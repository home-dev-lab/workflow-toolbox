#!/usr/bin/env node
// wt-verifier-cli-guard-hook.mjs — a PreToolUse guard, plugin-level, SELF-SCOPED by
// agent_type to the external cross-family verifier wrappers (opencode-verifier /
// codex-rescue). It is the mechanical fail-fast for the SELF-ANSWER failure mode: a
// wrapper is a THIN RELAY that must shell out to the external CLI (`opencode run` /
// `codex-companion task`) and transcribe its verdict — but it can silently SELF-ANSWER
// (reason from its own priors and emit the verdict tool call) without ever invoking the
// CLI (sonnet ~37%, codex 16/16 — see the provenance gate, card #1823504956762621933).
// The provenance gate DISQUALIFIES such a vote post-hoc, but only AFTER the wrapper has
// spent its full budget. This hook DENIES the terminal verdict tool (`StructuredOutput`)
// until a REAL external-CLI invocation is present in the wrapper's own transcript, so a
// self-answer cannot emit a verdict and is nudged to actually invoke the CLI instead.
//
// AGENT-SCOPED, so every OTHER agent (leaf / lean / …) stays effectively BARE — two layers:
//  (1) REGISTRATION is matcher-narrowed to the `StructuredOutput` tool in both manifests, so
//      the hook process never even SPAWNS on any other tool call (Bash/Read/etc. cost zero).
//  (2) the SCRIPT self-scopes: a StructuredOutput call from a NON-wrapper agent returns at the
//      agent-type check below (a ~ms silent no-op) BEFORE any transcript read — the verdict is
//      emitted untouched. Only the opencode/codex verifier wrapper is ever actually guarded.
//
// Scope (fail-OPEN by construction — it only ever DENIES a narrow, named case):
// - Acts ONLY on tool_name === 'StructuredOutput' (the verdict channel the pattern forces
//   via a schema). Every other tool → no-op (the wrapper legitimately runs Bash/Read).
// - Acts ONLY when the call comes from one of the external verifier wrappers (agent_type,
//   namespace-stripped, matches an external-CLI signature's typeRe: opencode / codex).
//   agent_id/agent_type are populated by Claude Code only inside a SUBAGENT (empirically
//   confirmed on the real harness, undocumented — same caveat as wt-pilot-guard-hook); a
//   main-session call has no agent_id → no-op. Any other subagent → no-op.
// - Reads the subagent's own transcript (transcript_path, a documented hook field) and
//   scans its Bash tool_use commands for a REAL external-CLI invocation with the SAME
//   canonical regex the provenance gate uses (drift-locked — see the test). One or more
//   invocations → ALLOW (silent). Zero → DENY the verdict with a corrective reason.
// - ANY uncertainty (no agent_id, agent_type not an external wrapper, no transcript_path,
//   unreadable/empty transcript, internal error) → ALLOW (silent exit 0). It must NEVER
//   blanket-deny: a false-closed deny would null every vote of a working wrapper.
//
// Allow path is SILENT exit 0 (no JSON): emitting permissionDecision:"allow" would
// AUTO-APPROVE and bypass the user's normal permission prompts. Deny path = exit 0 +
// stdout JSON with hookSpecificOutput.permissionDecision:"deny". Any internal error is
// swallowed → exit 0 (never block on a bug).
//
// DEFENSE-IN-DEPTH: the post-hoc provenance gate (patterns) remains the integrity backstop
// and the haiku wrapper default bounds the cost; this hook is the EARLY layer that stops the
// verdict at the tool boundary and converts a would-be self-answer into a real CLI call.

import fs from 'node:fs'
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

/** Count REAL external-CLI invocations in one transcript's Bash tool_use commands. Mirrors
 *  the provenance gate's scanner (parseTranscriptExternalCalls shape): iterate jsonl lines,
 *  find assistant messages with tool_use blocks name==='Bash', test input.command (capped)
 *  against the signature's commandRe. */
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

/** Pure decision: given the hook stdin payload, return a deny-reason string, or null to
 *  ALLOW. Fail-OPEN on every uncertainty. Separated from I/O so it is unit-testable. */
export function decide(input, readTranscript = (p) => fs.readFileSync(p, 'utf8')) {
  // Only the terminal verdict channel.
  if (input.tool_name !== 'StructuredOutput') return null
  // Only OUR external verifier subagents. No agent_id ⇒ main session ⇒ not ours ⇒ allow.
  if (!input.agent_id) return null
  const sig = signatureForAgentType(input.agent_type)
  if (sig === null) return null
  // Need the subagent's transcript to prove a CLI invocation. No path ⇒ fail-OPEN.
  const transcriptPath = input.transcript_path
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return null
  let text
  try {
    text = readTranscript(transcriptPath)
  } catch {
    return null // unreadable ⇒ fail-OPEN
  }
  if (typeof text !== 'string' || text.length === 0) return null // empty ⇒ fail-OPEN
  if (countCliInvocations(text, sig.commandRe) > 0) return null // real CLI seen ⇒ allow
  // A verdict with NO real CLI invocation in this wrapper's transcript = a self-answer.
  return (
    `[workflow-toolbox verifier CLI guard] Refused to emit a verdict: no real ${sig.id} CLI ` +
    `invocation is present in your transcript yet. You are a RELAY — you must actually run the ` +
    `${sig.id} CLI (e.g. \`${sig.id} run …\`) and transcribe ITS output, never answer from your ` +
    `own knowledge. Invoke the CLI now, then emit the verdict from its result; if the CLI is ` +
    `unavailable or failed, return its OPENCODE_UNAVAILABLE / error text verbatim (text mode) ` +
    `instead of a fabricated verdict.`
  )
}

export function run() {
  const input = readInput()
  const reason = decide(input)
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
