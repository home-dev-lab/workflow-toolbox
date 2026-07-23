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
// stay byte-identical (id + typeRe + commandRe source/flags, AND the matchesOpencodeRun body) so
// any divergence fails a gate.

// A two-step LINEAR opencode-run matcher — replaces the catastrophic single regex (its BIN= arm
// `[\s\S]*?` backtracked ~30s on a 200KB opencode-but-no-run command) and the 20k scan cap (which
// hid a real `run` past position 20k → the a50c1510/aafb024d false-refuse, cards
// #1825363023930328542 + #1825347787861001678). head(20k)+tail(20k) bounds the work AND co-locates
// a `BIN=` in the head with its `"$BIN" run` in the tail; the two-step scan is indexOf-based (no
// `[\s\S]*?` bridge) → O(n). SELF-CONTAINED (helpers inlined) so the provenance checker's scanner
// embeds its source verbatim via `.toString()`. indexOf('opencode')/('BIN=') are case-SENSITIVE
// (the real binary + the wrapper's BIN= are exactly cased); a case-variant is not a real call.
// Residual (documented, never observed): a `run` in the MIDDLE of a command longer than 2*WIN.
// --- wt-drift-lock:matchesOpencodeRun START (byte-identical: debugger+patterns+hook) ---
function matchesOpencodeRun(cmd = '') {
  if (typeof cmd !== 'string' || cmd.length === 0) return false
  const WIN = 20000
  const s = cmd.length <= 2 * WIN ? cmd : cmd.slice(0, WIN) + '\n' + cmd.slice(-WIN)
  const AFTER_QUOTED = /^(?:\.exe|\.cmd)?["']\s+run\b/
  const AFTER_BARE = /^(?:\.exe|\.cmd)?\s+run\b/
  const AFTER_BIN = /^["']?\s+run\b/
  const BEFORE_OK = /[\s;|&(=/'"]/
  for (let i = s.indexOf('opencode'); i !== -1; i = s.indexOf('opencode', i + 1)) {
    const before = i === 0 ? '' : s[i - 1]
    if (before && !BEFORE_OK.test(before)) continue
    const after = s.slice(i + 8, i + 8 + 16)
    // Case A — a real QUOTED invocation: a CLOSING quote right after the opencode token, then run
    // (`"opencode" run`, `"/path/opencode" run`).
    if (AFTER_QUOTED.test(after)) return true
    // Case B — a real UNQUOTED invocation: run right after (no quote), and opencode was NOT opened
    // by a quote — rejects the string arg `"opencode run"` (quote-before pairs with run inside).
    if (before !== '"' && before !== "'" && AFTER_BARE.test(after)) return true
  }
  let hasBinOpencode = false
  for (let i = s.indexOf('BIN='); i !== -1; i = s.indexOf('BIN=', i + 1)) {
    const nl = s.indexOf('\n', i)
    const end = Math.min(nl === -1 ? s.length : nl, i + 4 + 256)
    if (s.slice(i + 4, end).indexOf('opencode') !== -1) {
      hasBinOpencode = true
      break
    }
  }
  if (hasBinOpencode) {
    for (const m of s.matchAll(/\$\{?[A-Za-z_]*BIN\}?/g)) {
      const at = m.index ?? 0
      const tok = m[0] ?? ''
      if (AFTER_BIN.test(s.slice(at + tok.length, at + tok.length + 16))) return true
    }
  }
  return false
}
// --- wt-drift-lock:matchesOpencodeRun END ---

export const EXTERNAL_CLI_SIGNATURES = [
  {
    id: 'opencode',
    typeRe: /opencode/i,
    commandRe:
      /(?:^|[\s;|&(=])(?:[^\s;|&"']*\/)?opencode(?:\.exe|\.cmd)?\s+run\b|(?:^|[\s;|&(=])["'](?:[^"']*\/)?opencode(?:\.exe|\.cmd)?["']\s+run\b|[A-Za-z_]*BIN=[^\n]*opencode[\s\S]*?"?\$\{?[A-Za-z_]*BIN\}?"?\s+run\b/im,
    matchCommand: matchesOpencodeRun,
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

// Per-subagent DENY counter (card #1825363023930328542): a sibling file (SAME key family as the
// cli-seen marker — sha1(transcript_path + ':' + agent_id)) holding how many verdicts THIS wrapper
// has had refused with no CLI provenance. At DENY_TERMINAL_AT the refusal becomes TERMINAL (stop
// retrying, return text). After the step-1 matcher fix a real-CLI vote is ALLOWED on its first
// post-run StructuredOutput, so it never accrues a count — the counter only bites a PERSISTENT
// no-CLI self-answer. Cap = 3 (aafb024d recovered on its 3rd attempt; a lower cap would cut
// legitimate short-retry recoveries).
const DENY_COUNTER_PREFIX = 'wt-verifier-denies-'
const DENY_TERMINAL_AT = 3

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

/** Route one Bash command to the right matcher for `sig`: opencode's linear self-bounded
 *  `matchCommand` given the FULL command (a pre-cap would drop the tail where a long-heredoc `run`
 *  lives — the a50c1510/aafb024d false-refuse this fix removes); or a direct/linear signature's
 *  capped `commandRe` (codex). */
function matchesCli(command, sig) {
  if (sig.matchCommand) return sig.matchCommand(command)
  const scan = command.length > COMMAND_SCAN_MAX ? command.slice(0, COMMAND_SCAN_MAX) : command
  return sig.commandRe.test(scan)
}

/** The first external-CLI signature whose matcher accepts this Bash command (a REAL invocation),
 *  or null. */
export function signatureForCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return null
  for (const sig of EXTERNAL_CLI_SIGNATURES) if (matchesCli(command, sig)) return sig
  return null
}

/** Count REAL external-CLI invocations in one transcript's Bash tool_use commands (the flushed
 *  fallback signal). Mirrors the provenance gate's scanner (parseTranscriptExternalCalls shape).
 *  Routes each command through `matchesCli(cmd, sig)` — the FULL command for opencode's linear
 *  matcher, so a `run` past 20k in a long heredoc is still counted. */
export function countCliInvocations(transcriptText, sig) {
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
      if (matchesCli(cmd, sig)) n++
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

/** Per-subagent deny-counter path — SAME per-vote key as markerPathFor, different prefix, so a
 *  wrapper's deny count and its cli-seen marker live side by side and never collide with a
 *  sibling's. */
export function denyCounterPathFor(transcriptPath, agentId) {
  const key = crypto
    .createHash('sha1')
    .update(`${String(transcriptPath)}:${String(agentId)}`)
    .digest('hex')
    .slice(0, 40)
  return path.join(markerDir(), DENY_COUNTER_PREFIX + key)
}

/** Opportunistic cleanup so markers don't accumulate forever (best-effort, never throws). */
function reapOldMarkers() {
  try {
    const dir = markerDir()
    const now = Date.now()
    for (const f of fs.readdirSync(dir)) {
      if (f.indexOf(MARKER_PREFIX) !== 0 && f.indexOf(DENY_COUNTER_PREFIX) !== 0) continue
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

/** Nudge appended to a non-terminal deny (denies 1..N-1): the model often just finished the CLI
 *  and needs to re-emit its verdict rather than re-run. */
function retryHintLine(sig) {
  return ` If your ${sig.id} CLI just finished, re-emit StructuredOutput now — its result is what unblocks you.`
}

/** The TERMINAL refusal at DENY_TERMINAL_AT: stop retrying, return the CLI's own output as TEXT. A
 *  PreToolUse deny is technically retryable by the model, so this is a strong MESSAGE (the ratified
 *  mechanism (i)); the retry loop is bounded by maxTurns regardless. */
function terminalDenyReason(sig, count) {
  return (
    `[workflow-toolbox verifier CLI guard] TERMINAL (refused ${count}×): no real ${sig.id} CLI ` +
    `invocation has EVER been proven for this verifier. STOP retrying — further StructuredOutput ` +
    `calls will keep being refused. Return your FINAL answer as TEXT now: the ${sig.id} CLI's ` +
    `OPENCODE_UNAVAILABLE / error output verbatim if it failed or is unavailable, otherwise state ` +
    `plainly that you could not run it. Do NOT emit a verdict from your own knowledge.`
  )
}

/** Count THIS deny per-subagent and escalate to a TERMINAL refusal at the cap. Pure over injected
 *  fs so unit tests can drive it; the child-process tests exercise the real files. Without a
 *  per-vote key (no transcript_path / agent_id, or a non-wrapper agent_type) it cannot count and
 *  returns the base reason unchanged — still a deny, just no escalation. */
export function escalateDeny(
  input,
  baseReason,
  readCount = (p) => fs.readFileSync(p, 'utf8'),
  writeCount = (p, v) => fs.writeFileSync(p, v),
) {
  const sig = signatureForAgentType(input.agent_type)
  const transcriptPath = input.transcript_path
  const agentId = input.agent_id
  if (sig === null || typeof transcriptPath !== 'string' || transcriptPath.length === 0 || !agentId) {
    return baseReason
  }
  const counterPath = denyCounterPathFor(transcriptPath, agentId)
  let count = 0
  try {
    const n = parseInt(readCount(counterPath), 10)
    if (Number.isFinite(n) && n > 0) count = n
  } catch {
    /* no prior count on disk */
  }
  count += 1
  try {
    writeCount(counterPath, String(count))
  } catch {
    /* best-effort: a count we couldn't persist just doesn't escalate */
  }
  return count >= DENY_TERMINAL_AT ? terminalDenyReason(sig, count) : baseReason + retryHintLine(sig)
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
  if (typeof text === 'string' && text.length > 0 && countCliInvocations(text, sig) > 0) {
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
  // A deny was decided → count it per-subagent and escalate to a TERMINAL refusal at the cap.
  const finalReason = escalateDeny(input, reason)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: finalReason,
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
