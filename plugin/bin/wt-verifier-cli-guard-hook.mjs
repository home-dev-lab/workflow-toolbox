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

/** Deterministic per-transcript marker path (safe filename via a hash of transcript_path). Both
 *  hook events derive the SAME path for the same subagent (same transcript_path). */
export function markerPathFor(transcriptPath) {
  const key = crypto.createHash('sha1').update(String(transcriptPath)).digest('hex').slice(0, 40)
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
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return // no per-vote key
  try {
    writeMarker(markerPathFor(transcriptPath))
  } catch {
    /* best-effort: a marker we couldn't write just falls back to the transcript scan */
  }
  reapOldMarkers()
}

/** PreToolUse decision on a StructuredOutput call: deny-reason string, or null to ALLOW.
 *  Fail-OPEN on every uncertainty. Allows on the flush-immune marker (primary) OR the flushed
 *  transcript scan (secondary); denies only when BOTH are absent. */
export function decidePreToolUse(
  input,
  readTranscript = (p) => fs.readFileSync(p, 'utf8'),
  markerExists = (p) => fs.existsSync(p),
) {
  if (input.tool_name !== 'StructuredOutput') return null
  if (!input.agent_id) return null // main session ⇒ not ours ⇒ allow
  const sig = signatureForAgentType(input.agent_type)
  if (sig === null) return null // non-wrapper agent (leaf/lean/…) ⇒ allow, verdict untouched
  const transcriptPath = input.transcript_path
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return null // fail-OPEN
  // PRIMARY: flush-immune marker written by this wrapper's own CLI PostToolUse.
  try {
    if (markerExists(markerPathFor(transcriptPath))) return null // real CLI proven ⇒ allow
  } catch {
    /* marker check failed ⇒ fall through to the transcript scan */
  }
  // SECONDARY: the transcript scan (works once the CLI Bash line is flushed).
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
  return (
    `[workflow-toolbox verifier CLI guard] Refused to emit a verdict: no real ${sig.id} CLI ` +
    `invocation is present for this verifier yet. You are a RELAY — you must actually run the ` +
    `${sig.id} CLI (e.g. \`${sig.id} run …\`) and transcribe ITS output, never answer from your ` +
    `own knowledge. Invoke the CLI now, then emit the verdict from its result; if the CLI is ` +
    `unavailable or failed, return its OPENCODE_UNAVAILABLE / error text verbatim (text mode) ` +
    `instead of a fabricated verdict.`
  )
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
