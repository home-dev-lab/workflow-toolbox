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
// discard stdout). Any internal error is swallowed → exit 0 (never block on a bug).
//
// This is DEFENSE-IN-DEPTH against reflex mistakes, not an adversarial sandbox: the
// primary layer is the agent definitions' escalation contract. It matches the common
// command forms robustly and does not chase deliberate obfuscation.

import fs from 'node:fs'

const PILOT_AGENTS = new Set(['pilot', 'pilot-orchestrator', 'pilot-watchdog'])

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Split a shell command into rough segments on the sequencing operators, so each
 *  `git push` / `pkill` etc. is evaluated on its own. */
function segments(command) {
  return command.split(/\n|;|&&|\|\||\|/).map((s) => s.trim()).filter(Boolean)
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

/** The first destructive/forbidden pattern in the command, or null to allow. */
function firstViolation(command) {
  for (const seg of segments(command)) {
    if (/\b(npm|pnpm|yarn)\s+publish\b/.test(seg)) return 'npm/pnpm/yarn publish is a release action'
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
  // Only OUR pilot subagents. No agent_id ⇒ main session ⇒ not ours ⇒ allow (silent).
  if (!input.agent_id) return
  const agentType = String(input.agent_type || '').split(':').pop()
  if (!PILOT_AGENTS.has(agentType)) return
  if (input.tool_name !== 'Bash') return
  const command =
    input.tool_input && typeof input.tool_input.command === 'string' ? input.tool_input.command : ''
  if (!command) return

  const reason = firstViolation(command)
  if (!reason) return // allow: SILENT exit 0, so normal permission flow is untouched

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[workflow-toolbox pilot guard] Refused: ${reason}. This is an escalation, not a ` +
          `pilot action — relay it to your arbiter (main session) instead of running it.`,
      },
    }),
  )
}

try {
  main()
} catch {
  // Never block a tool call because the guard itself hit a bug: emit nothing, exit 0.
}
