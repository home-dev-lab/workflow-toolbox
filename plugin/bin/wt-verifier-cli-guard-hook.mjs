#!/usr/bin/env node
// wt-verifier-cli-guard-hook.mjs — a two-event guard (PreToolUse + PostToolUse), plugin-level,
// SELF-SCOPED to the external cross-family verifier wrappers (opencode-verifier / codex-rescue).
// It is the mechanical fail-fast for the SELF-ANSWER failure mode: a wrapper is a THIN RELAY
// that must shell out to the external CLI (`opencode run` / `codex-companion task`) and
// transcribe its verdict — but it can silently SELF-ANSWER (reason from its own priors and emit
// the verdict tool call) without ever invoking the CLI (sonnet ~37%, codex 16/16 — see the
// provenance gate, card #1823504956762621933). The provenance gate DISQUALIFIES such a vote
// post-hoc, but only AFTER the wrapper has spent its full budget. This hook DENIES the terminal
// verdict tool (`StructuredOutput`) until a REAL external-CLI invocation is proven for this
// wrapper, so a self-answer cannot emit a verdict.
//
// ── HOW IT PROVES "the CLI ran" (fixed 23/07 after probe wf_0b6cfa3f-f7a) ──────────────────
// FIRST DESIGN (transcript-scan only) FALSE-REFUSED at scale in the DELEGATED (Path-B) run: the
// wrapper ran `opencode run` successfully, THEN emitted StructuredOutput — but at the SO
// PreToolUse moment the just-completed Bash `tool_use` line was NOT YET FLUSHED to the
// per-subagent transcript file, so the mid-flight scan saw zero invocations and refused every
// legitimate verdict (0/38 credited → probe VOID). ROOT CAUSE = flush timing (the regex + parser
// are correct — proven: they detect the call in 32/32 of the run's FINAL transcripts; and the
// path is the per-subagent transcript — proven: a shared/parent transcript would false-ALLOW,
// not the observed massive false-DENY). FIX = a flush-immune signal:
//   • PostToolUse (Bash): when a real CLI invocation COMPLETES, write a MARKER FILE keyed by
//     `transcript_path` (a documented hook field, present in BOTH events, and per-subagent in a
//     Path-B run — so it is a safe per-vote key with NO dependence on the undocumented `agent_id`
//     in PostToolUse). PostToolUse fires when the Bash tool finishes — BEFORE the model even
//     generates the SO call — so the marker is guaranteed present at the later SO PreToolUse.
//   • PreToolUse (StructuredOutput): ALLOW if the marker exists (primary, flush-immune) OR the
//     transcript-scan finds a call (secondary, works once the transcript is flushed). DENY only
//     when BOTH are absent — strong evidence of a genuine self-answer (no CLI ever ran).
//
// AGENT-SCOPED, so every OTHER agent (leaf / lean / …) stays effectively BARE — two layers:
//  (1) REGISTRATION is matcher-narrowed (PreToolUse→StructuredOutput, PostToolUse→Bash) in both
//      manifests, so the hook process never spawns on unrelated tool calls.
//  (2) the SCRIPT self-scopes: a StructuredOutput from a NON-wrapper agent returns at the
//      agent-type check (a ~ms silent no-op) and emits its verdict untouched; a PostToolUse Bash
//      writes a marker ONLY for a real external-CLI command (the specific regex is the scope).
//
// Scope (fail-OPEN by construction — it only ever DENIES a narrow, named case):
// - PreToolUse acts ONLY on tool_name === 'StructuredOutput' from an opencode/codex wrapper
//   subagent (agent_id present + agentType matches an external signature). Any uncertainty
//   (no agent_id, wrong agentType, no transcript_path) → ALLOW (silent). It must NEVER
//   blanket-deny: a false-closed deny nulls every vote of a working wrapper (the bug just fixed).
// - PostToolUse acts ONLY on a Bash command that matches an external-CLI signature; it only ever
//   WRITES a marker (never denies/blocks anything) — a no-op on every other command.
//
// Allow path is SILENT exit 0 (no JSON). Deny path = exit 0 + stdout JSON with
// hookSpecificOutput.permissionDecision:"deny". Any internal error is swallowed → exit 0.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

// The external-CLI delegation signatures — a DELIBERATE byte-identical COPY of
// @workflow-toolbox/patterns' provenance-gate EXTERNAL_CLI_SIGNATURES (itself a copy of the
// shipped @workflow-toolbox/debugger registry). This hook is a plugin .mjs run by bare node
// (no bundler, no TS), so it cannot import the TS registry; a drift-lock test asserts these
// stay byte-identical (id + typeRe + commandRe source/flags) so any divergence fails a gate.
export const EXTERNAL_CLI_SIGNATURES = [
  {
    id: 'opencode',
    typeRe: /opencode/i,
    commandRe:
      /(?:^|[\s;|&(=])(?:[^\s;|&"']*\/)?opencode(?:\.exe|\.cmd)?\s+run\b|(?:^|[\s;|&(=])["'](?:[^"']*\/)?opencode(?:\.exe|\.cmd)?["']\s+run\b|[A-Za-z_]*BIN=[^\n]*opencode[\s\S]*?"?\$\{?[A-Za-z_]*BIN\}?"?\s+run\b/im,
  },
  {
    id: 'codex',
    typeRe: /codex/i,
    commandRe:
      /codex-companion\.mjs["']?\s+task\b|(?:^|[\s;|&(=])(?:[^\s;|&"']*\/)?codex(?:\.exe)?\s+exec\b|(?:^|[\s;|&(=])["'](?:[^"']*\/)?codex(?:\.exe)?["']\s+exec\b/im,
  },
]

// Cap on how much of one Bash command string we scan — parity with the provenance gate's
// SCANNER_COMMAND_SCAN_MAX (a real invocation buried past this is missed; accepted for a
// best-effort early guard, and identical to what the shipped scanner would see).
const COMMAND_SCAN_MAX = 20_000

// Marker files prove a real CLI invocation across the PostToolUse→PreToolUse gap, immune to
// transcript flush timing. Dir is os.tmpdir() (shared by both hook processes of the same
// delegated session), overridable via WT_VERIFIER_MARKER_DIR for isolated tests.
const MARKER_PREFIX = 'wt-verifier-cli-seen-'
const MARKER_TTL_MS = 6 * 60 * 60 * 1000 // opportunistically reap markers older than this

export function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** The external-CLI signature this agent_type is a wrapper for, or null. Mirrors the gate's
 *  externalGateExpectation: match the (namespace-stripped) agent_type against each typeRe. */
export function signatureForAgentType(agentType) {
  const bare = String(agentType || '').split(':').pop()
  if (!bare) return null
  for (const sig of EXTERNAL_CLI_SIGNATURES) if (sig.typeRe.test(bare)) return sig
  return null
}

/** The first external-CLI signature whose commandRe matches this Bash command (a REAL
 *  invocation), or null. Command is capped like the transcript scanner. */
export function signatureForCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return null
  const scan = command.length > COMMAND_SCAN_MAX ? command.slice(0, COMMAND_SCAN_MAX) : command
  for (const sig of EXTERNAL_CLI_SIGNATURES) if (sig.commandRe.test(scan)) return sig
  return null
}

/** Count REAL external-CLI invocations in one transcript's Bash tool_use commands (the flushed
 *  fallback signal). Mirrors the provenance gate's scanner (parseTranscriptExternalCalls shape). */
export function countCliInvocations(transcriptText, commandRe) {
  let n = 0
  for (const raw of transcriptText.split('\n')) {
    const t = raw.trim()
    if (!t) continue
    let o
    try {
      o = JSON.parse(t)
    } catch {
      continue
    }
    const m = o && o.message
    if (!m || typeof m !== 'object') continue
    const c = m.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (!b || b.type !== 'tool_use' || b.name !== 'Bash') continue
      const cmd = b.input && b.input.command
      if (typeof cmd !== 'string') continue
      const scan = cmd.length > COMMAND_SCAN_MAX ? cmd.slice(0, COMMAND_SCAN_MAX) : cmd
      if (commandRe.test(scan)) n++
    }
  }
  return n
}

function markerDir() {
  return process.env['WT_VERIFIER_MARKER_DIR'] || os.tmpdir()
}

/** Deterministic PER-SUBAGENT marker path. Keyed by (transcript_path + agent_id): in Path B
 *  transcript_path is the SHARED delegated-session transcript (re-probe wf: identical for all 66
 *  agents), so transcript_path ALONE would be ONE run-global marker — a sibling's CLI run would
 *  then allow-marker every self-answer (6 leaked in the re-probe). Folding agent_id in makes the
 *  marker per-VOTE (and per-run). Both hook events derive the SAME path for the SAME subagent
 *  (same transcript_path + same agent_id). agent_id is present in both events (re-probe census:
 *  60 distinct agent_ids on marker-writes). */
export function markerPathFor(transcriptPath, agentId) {
  const key = crypto
    .createHash('sha1')
    .update(`${String(transcriptPath)}:${String(agentId)}`)
    .digest('hex')
    .slice(0, 40)
  return path.join(markerDir(), MARKER_PREFIX + key)
}

/** Opportunistic cleanup so markers don't accumulate forever (best-effort, never throws). */
function reapOldMarkers() {
  try {
    const dir = markerDir()
    const now = Date.now()
    for (const f of fs.readdirSync(dir)) {
      if (f.indexOf(MARKER_PREFIX) !== 0) continue
      const fp = path.join(dir, f)
      try {
        if (now - fs.statSync(fp).mtimeMs > MARKER_TTL_MS) fs.rmSync(fp, { force: true })
      } catch {
        /* ignore a single unstattable/unremovable marker */
      }
    }
  } catch {
    /* dir unreadable ⇒ skip cleanup */
  }
}

/** PostToolUse: when a real external-CLI invocation COMPLETES, write its per-transcript marker.
 *  Never denies/blocks — it only records provenance. Self-scoped by the command regex (only a
 *  real `opencode run`/`codex …` matches); an agent_type, if present, must be a wrapper. */
export function handlePostToolUse(input, writeMarker = (p) => fs.writeFileSync(p, String(Date.now()))) {
  if (input.tool_name !== 'Bash') return
  const command = input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : ''
  if (signatureForCommand(command) === null) return // not a real external-CLI invocation
  // If agent_type IS present, only a wrapper marks (avoid stray markers); if absent (undocumented
  // in PostToolUse), the specific command regex above is the scope.
  if (input.agent_type !== undefined && signatureForAgentType(input.agent_type) === null) return
  const transcriptPath = input.transcript_path
  const agentId = input.agent_id
  // Need BOTH transcript_path AND agent_id to form the PER-SUBAGENT key. Without agent_id a marker
  // would be run-global (the re-probe bleed) — so skip writing rather than write an unkeyed marker
  // that a sibling self-answer could ride.
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return
  if (!agentId) return
  try {
    writeMarker(markerPathFor(transcriptPath, agentId))
  } catch {
    /* best-effort: a marker we couldn't write just falls back to the transcript scan */
  }
  reapOldMarkers()
}

/** The refusal reason for one wrapper signature. */
function denyReason(sig) {
  return (
    `[workflow-toolbox verifier CLI guard] Refused to emit a verdict: no real ${sig.id} CLI ` +
    `invocation is proven for this verifier yet. You are a RELAY — you must actually run the ` +
    `${sig.id} CLI (e.g. \`${sig.id} run …\`) and transcribe ITS output, never answer from your ` +
    `own knowledge. Invoke the CLI now, then emit the verdict from its result; if the CLI is ` +
    `unavailable or failed, return its OPENCODE_UNAVAILABLE / error text verbatim (text mode) ` +
    `instead of a fabricated verdict.`
  )
}

/** PreToolUse decision on a StructuredOutput call: deny-reason string, or null to ALLOW.
 *  Order matters (fixed after the re-probe bleed): the WRAPPER-SIG check is FIRST so a non-wrapper
 *  agent (leaf/lean, or the main session with no agent_type) is never guarded; then, for a wrapper,
 *  a missing per-vote key must NEVER widen allow — an external wrapper with no agent_id is
 *  DENIED (fail-CLOSED), because the marker is keyed per-subagent by agent_id and a shared/absent
 *  key would let a self-answer ride a sibling's CLI run. Otherwise ALLOW on the flush-immune
 *  per-subagent marker (primary) OR the flushed transcript scan (secondary); DENY when both absent. */
export function decidePreToolUse(
  input,
  readTranscript = (p) => fs.readFileSync(p, 'utf8'),
  markerExists = (p) => fs.existsSync(p),
) {
  if (input.tool_name !== 'StructuredOutput') return null
  // Wrapper-sig FIRST: a non-wrapper agent (leaf/lean, or the main session which carries no
  // agent_type) is NEVER guarded — its verdict passes untouched.
  const sig = signatureForAgentType(input.agent_type)
  if (sig === null) return null
  // It IS an external verifier wrapper. A missing agent_id means no per-subagent key can be formed,
  // and a shared/absent key would let a self-answer ride a sibling's marker (the re-probe bleed) →
  // FAIL-CLOSED. (agent_id is present in both hook events in practice — re-probe census: 60 distinct.)
  const agentId = input.agent_id
  if (!agentId) return denyReason(sig)
  const transcriptPath = input.transcript_path
  // No transcript_path ⇒ no key AND no scan possible. transcript_path is THE core hook field and is
  // always present in practice; fail-OPEN here (rather than deny) so a hypothetical missing field
  // never reincarnates the round-1 catastrophic deny-ALL. (agent_id, the undocumented field, is the
  // one that fails CLOSED above.)
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return null
  // PRIMARY: flush-immune PER-SUBAGENT marker written by THIS subagent's own CLI PostToolUse.
  try {
    if (markerExists(markerPathFor(transcriptPath, agentId))) return null // real CLI proven ⇒ allow
  } catch {
    /* marker check failed ⇒ fall through to the transcript scan */
  }
  // SECONDARY: the transcript scan (works once the CLI Bash line is flushed). In Path B this reads
  // the SHARED delegated-session transcript, which carries 0 opencode calls (the calls live in
  // per-subagent files) — so it CANNOT false-allow there; in an interactive spawn transcript_path
  // is the agent's own transcript, where it is per-agent-correct.
  let text
  try {
    text = readTranscript(transcriptPath)
  } catch {
    return null // unreadable ⇒ fail-OPEN
  }
  if (typeof text === 'string' && text.length > 0 && countCliInvocations(text, sig.commandRe) > 0) {
    return null // real CLI seen in the (flushed) transcript ⇒ allow
  }
  // Neither signal present: a verdict with NO real CLI invocation = a self-answer.
  return denyReason(sig)
}

/** Back-compat alias: the PreToolUse decision. */
export const decide = decidePreToolUse

export function run() {
  const input = readInput()
  if (input.hook_event_name === 'PostToolUse') {
    handlePostToolUse(input) // records provenance; never emits a decision
    return
  }
  const reason = decidePreToolUse(input)
  if (!reason) return // allow: SILENT exit 0, so normal permission flow is untouched
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
}

// Entry-guard: run only when invoked directly as a hook, so the module is importable by the
// drift-lock / decision unit tests without executing (and blocking on) stdin.
const invokedPath = process.argv[1]
const isEntry = invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href
if (isEntry) {
  try {
    run()
  } catch {
    // Never block a tool call because the guard itself hit a bug: emit nothing, exit 0.
  }
}
