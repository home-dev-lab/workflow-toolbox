#!/usr/bin/env node
// wt-pilot-guard-hook.mjs — a PreToolUse guard, plugin-level, SELF-SCOPED by
// agent_type. It is the mechanical enforcement layer for the shipped pilot suite:
// the prose in the agent definitions says "publish/force-push/pattern-kill are
// escalations, never pilot actions"; this hook makes the reflex ones impossible to
// execute silently, instead of trusting prompt-level discipline.
//
// Scope (fail-OPEN by construction — it only ever DENIES a narrow, named set):
// - It acts ONLY when the tool call comes from one of OUR shipped pilot agents
//   (agent_type ∈ {pilot, pilot-orchestrator, pilot-watchdog}). agent_id/agent_type
//   are populated by Claude Code only inside a subagent; a MAIN-session call has no
//   agent_id, so the guard no-ops there. Any other subagent → no-op.
//   COMPAT CAVEAT: these two payload fields are NOT in the official hooks schema doc,
//   but were EMPIRICALLY CONFIRMED present on the real harness (Claude Code 2.1.215:
//   a subagent's Bash PreToolUse stdin carried top-level agent_type + agent_id; a
//   main-session call carried neither). Because they are undocumented, treat them as
//   best-effort: if a future harness stops sending agent_id, the guard degrades to a
//   silent no-op — it must NEVER fall back to a blanket deny, since the user's own
//   main session legitimately runs `git push` etc. agent_type may be bare ("pilot")
//   or namespaced ("workflow-toolbox:pilot") — the pilot suite is no longer
//   plugin-registered so the harness should only ever send the bare form now, but the
//   guard keeps tolerating both: normalize by stripping the namespace regardless.
// - It only inspects Bash commands. Every other tool → no-op.
// - For a matching pilot Bash call it DENIES only: `git push` with no explicitly
//   named remote; a force/delete/mirror push to ANY remote; `npm|pnpm|yarn publish`;
//   `pkill -f` / `killall` pattern-kills. Everything else proceeds.
//
// Allow path is SILENT exit 0 (no JSON): emitting permissionDecision:"allow" would
// AUTO-APPROVE the call and bypass the user's normal permission prompts — the guard
// must never widen permissions, only refuse. Deny path = exit 0 + stdout JSON with
// hookSpecificOutput.permissionDecision:"deny" (the current contract; exit 2 would
// discard stdout). Any internal error fails open with one stderr trace (never block on a bug).
//
// This is DEFENSE-IN-DEPTH against reflex mistakes, not an adversarial sandbox: the
// primary layer is the agent definitions' escalation contract. It matches the common
// command forms robustly and does not chase deliberate obfuscation.

import fs from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'

// ⚠ NOT an allowlist of agent types. It used to be one — `pilot`, `pilot-orchestrator`,
// `pilot-watchdog` — and that failed OPEN: a copy of the pilot definition under any other name
// was unguarded, silently. Measured 2026-07-29: the same `git merge main` was refused for
// `pilot` and allowed for `pilot-verify`, a byte-identical copy.
//
// The invariant is not "is this a pilot" — it is "may a SUBAGENT publish, force-push, or merge
// an integration branch". The answer is no for every one of them: those are user-gated
// escalations the spawning session holds, never a delegate's to take. So the guard now applies
// to EVERY subagent and fails CLOSED — a new agent type is covered the day it is created,
// without anyone remembering to list it.
//
// EXEMPT is the escape hatch, deliberately empty. Add a type here only with a written reason:
// an entry is a hole, and a hole nobody re-reads is how the enumeration failed the first time.
const EXEMPT_AGENTS = new Set()

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

// A command line carries CODE and DATA in the same string, and only the code is executed.
// A commit message, an echoed sentence, a heredoc body may all legitimately quote one of the
// forms below — matching the raw string refuses correct work, and a guard that refuses correct
// work gets switched off, taking its real cases with it. Measured 2026-08-04 on this guard's
// local twin: a perfectly ordinary commit was refused because its MESSAGE contained the words
// "npm publish". That was its third false refusal.
//
// So the matching below runs on a stripped view: heredoc bodies replaced wholesale, quoted spans
// emptied in place (the quotes stay, so token positions and the segment split are preserved).
//
// ⚠ WHY EVERY rule here may use the stripped view, when the local twin could not.
// The twin also guards `rm -rf <target>`, where the quotes are part of the NORMAL form
// (`rm -rf "$HOME/tmp"`) — stripping there would blind it to the case that matters most, so it
// strips PER RULE. This guard has no such rule: publish, force/delete/mirror push, merge
// main/master, and pattern-kill are never legitimately quoted as data. If a rule whose target is
// routinely quoted is ever added here, that rule must opt OUT of the stripping rather than
// inherit it by position.
//
// ⚠ RESIDUAL, stated rather than hidden: `git push "--force"` reads as `git push ""` after
// stripping and is no longer caught. That is deliberate — it is an obfuscation shape, not a
// reflex mistake, and this guard is defense-in-depth against reflexes (see the header). The
// ordinary forms `git push --force` / `-f` are unaffected and stay covered by their tests.
function stripHeredocs(cmd) {
  return cmd.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
    '<<HEREDOC-BODY-STRIPPED',
  )
}
function stripQuotedSpans(cmd) {
  return cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

/** Split a shell command into rough segments on the sequencing operators, so each
 *  `git push` / `pkill` etc. is evaluated on its own. Strips data BEFORE splitting: a
 *  heredoc body or a quoted message may itself contain `;` or `&&`. */
function segments(command) {
  return stripQuotedSpans(stripHeredocs(command))
    .split(/\n|;|&&|\|\||\|/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** A `git push` in this segment that violates the remote-naming / non-destructive
 *  rules → a reason string; else null. */
function gitPushViolation(seg) {
  const toks = seg.split(/\s+/)
  const pi = toks.indexOf('push')
  if (pi === -1) return null
  if (toks.slice(0, pi).indexOf('git') === -1) return null // not a `git … push`
  const after = toks.slice(pi + 1)
  // Force / delete / mirror to ANY remote — remote-destructive, always an escalation.
  const destructive = after.some(
    (t) =>
      /^--(force|force-with-lease|delete|mirror)$/.test(t) ||
      (/^-[a-z]+$/i.test(t) && /[fd]/i.test(t)), // short-flag cluster containing f or d
  )
  if (destructive) return 'a force/delete/mirror push is remote-destructive'
  // Named remote? The first non-flag token after `push` is the remote.
  const positionals = after.filter((t) => !t.startsWith('-'))
  if (positionals.length === 0) {
    return 'a `git push` with no explicitly named remote (name it: `git push <remote> <branch>`)'
  }
  return null
}

/** Merging an integration branch INTO the pilot's own work — the pilot integrates its branch
 *  the other way round, and pulling main in mid-arc silently moves the base its gates ran
 *  against. Covers a bare `main`/`master` and any remote-qualified form. */
function gitMergeViolation(seg) {
  const toks = seg.split(/\s+/)
  const mi = toks.indexOf('merge')
  if (mi === -1) return null
  if (toks.slice(0, mi).indexOf('git') === -1) return null // not a `git … merge`
  const refs = toks.slice(mi + 1).filter((t) => !t.startsWith('-'))
  const protectedRef = refs.some((r) => /^(?:[A-Za-z0-9._-]+\/)?(?:main|master)$/.test(r))
  return protectedRef ? 'merging main/master into your branch changes the base your gates ran against' : null
}

/** The first destructive/forbidden pattern in the command, or null to allow. */
function firstViolation(command) {
  for (const seg of segments(command)) {
    if (/\b(npm|pnpm|yarn)\s+publish\b/.test(seg)) return 'npm/pnpm/yarn publish is a release action'
    const merge = gitMergeViolation(seg)
    if (merge) return merge
    if (/\bkillall\b/.test(seg)) return 'killall is a pattern-kill (kill by exact PID instead)'
    if (/\bpkill\b/.test(seg) && /(-[a-z]*f\b|--full\b)/i.test(seg)) {
      return 'pkill -f is a broad pattern-kill (kill by exact PID instead)'
    }
    const push = gitPushViolation(seg)
    if (push) return push
  }
  return null
}

function main() {
  const input = readInput()
  // Any SUBAGENT. No agent_id ⇒ the main session itself ⇒ it holds the gate, so allow (silent).
  if (!input.agent_id) return
  const agentType = String(input.agent_type || '').split(':').pop()
  if (EXEMPT_AGENTS.has(agentType)) return
  if (input.tool_name !== 'Bash') return
  const command =
    input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : ''
  if (!command) return

  const reason = firstViolation(command)
  if (!reason) return // allow: SILENT exit 0, so normal permission flow is untouched

  recordGuardEvent({
    guard: 'wt-pilot-guard-hook.mjs',
    decision: 'blocked',
    reason,
  })
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[workflow-toolbox pilot guard] Refused: ${reason}. This would take a user-gated ` +
          `escalation inside a delegate, so the approval path stops being visible at the main ` +
          `session. Fix: relay the exact command to your arbiter (main session) instead of ` +
          `running it here.`,
      },
    }),
  )
}

runFailOpenHook('wt-pilot-guard-hook.mjs', main)
