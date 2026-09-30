#!/usr/bin/env node
// wt-rm-critical-path-guard-hook.mjs — refuses an `rm`/`rmdir` that Claude Code's built-in
// critical-path check would stop for a permission prompt, and hands back the command to write
// instead.
//
// WHY. Claude Code asks before an `rm`/`rmdir` whose target is a critical path in every mode that
// can ask, bypassPermissions included, and neither an allow rule nor a PreToolUse "allow" can
// approve it (permission-modes.md, "Critical paths"). The shapes that trip it in ordinary agent
// work are a glob or trailing slash directly under a variable (`rm -f $G/*.log`), a variable
// followed by a system top-level directory name when the variable may be unset (`rm -rf $S/usr`), and a variable
// derived from the working directory (`M=$(pwd); rm -rf $M`). A delegated agent that meets the
// prompt waits on a console its owner may not be watching. A refusal comes back at once, with the
// rewrite, and the agent carries on.
//
// TWO EVENTS, one script:
//   PreToolUse on Bash — predicts the check (lib/rm-critical-path-core.mjs) and denies with the
//     rewritten command. It fires for sub-agents too: they are the ones left waiting.
//   PermissionRequest on Bash — the harness has already decided to ask. In bypassPermissions mode
//     it answers "deny" with the remedy instead of letting the prompt wait, when the prediction
//     found a critical target or when an rm target is not a plain literal path (a variable, a
//     glob, a substitution, a script read twice) — the shapes the prediction can miss. A prompt on
//     a command whose rm targets are all plain literal paths was raised for another reason and is
//     left alone; so is every prompt outside bypassPermissions, where an ordinary `rm` prompt is
//     the expected dialog. The event carries no prompt cause, so a prompt raised for another
//     reason on a command that also has a non-literal rm target is still refused.
//
// MODES. `WT_RM_CRITICAL_PATH_GUARD=warn` (or `WT_GUARD_MODE=observe`) turns both refusals into a
// journal entry plus, on PreToolUse, an allow-with-reason notice; the default denies.
//
// WHAT IT DOES NOT COVER, so its silence is not read as coverage:
//   - a variable assigned in an earlier Bash call is judged against the inherited environment, as
//     the harness does; a target assembled by `eval`, a shell function, or a script file is not
//     seen by the PreToolUse half (the PermissionRequest half still answers it in bypass mode);
//   - PowerShell `Remove-Item`, which has its own check;
//   - a harness rule added after the version this was written against — the PermissionRequest
//     half is the backstop for that too, in bypass mode only.

import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { guardMode, recordGuardEvent } from './lib/guard-journal.mjs'
import { homeDirectory } from './lib/host/home-directory.mjs'
import { readStdinJson } from './lib/host/read-stdin-json.mjs'
import { describeRemedy, hasNonLiteralRmInvocation, scanRmCriticalPath } from './lib/rm-critical-path-core.mjs'

const GUARD = 'wt-rm-critical-path-guard-hook.mjs'
const TAG = '[workflow-toolbox rm critical-path guard]'
const MAX_SHOWN = 600

function warnOnly() {
  const own = String(process.env.WT_RM_CRITICAL_PATH_GUARD ?? '').trim().toLowerCase()
  return own === 'warn' || guardMode() === 'observe'
}

function refusalText(command, hits, { afterPrompt }) {
  const { lines, rewritten } = describeRemedy(command, hits)
  const head = afterPrompt
    ? `${TAG} Refused instead of prompting: Claude Code stopped this removal for approval (critical-path check), and in bypassPermissions mode nobody may be watching the prompt.`
    : `${TAG} Refused: this removal would stop for a permission prompt that no allow rule or hook can approve (Claude Code's critical-path check, active in bypassPermissions mode too). A delegated agent would wait on it until someone answers by hand.`
  const body = lines.length > 0
    ? lines.map((l) => `- ${l}`).join('\n')
    : '- the check read at least one target as a critical path: write every rm/rmdir target as a literal absolute path, never through a variable, a glob under a variable, or the working directory.'
  const tail = rewritten !== null && rewritten.length <= MAX_SHOWN
    ? `\n\nRun this instead:\n${rewritten}`
    : '\n\nRewrite the targets above and run the command again.'
  return `${head}\n\n${body}${tail}`
}

function preToolUse(input, command) {
  const hits = scanRmCriticalPath(command, { cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(), home: homeDirectory(), env: process.env })
  if (hits.length === 0) return
  const warn = warnOnly()
  recordGuardEvent({
    guard: GUARD,
    decision: warn ? 'warned' : 'blocked',
    session: input.session_id,
    agent: input.agent_id,
    class: hits[0].rule,
    evidence: { rules: [...new Set(hits.map((h) => h.rule))].join(','), hits: hits.length },
  })
  const reason = refusalText(command, hits, { afterPrompt: false })
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: warn
      ? { hookEventName: 'PreToolUse', additionalContext: reason }
      : { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }))
}

function permissionRequest(input, command) {
  if (input.permission_mode !== 'bypassPermissions') return
  const hits = scanRmCriticalPath(command, { cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(), home: homeDirectory(), env: process.env })
  // A prompt on a command whose rm targets are all plain literal paths was raised for something
  // else (a literal critical path would be among the hits): leave that decision to the user.
  if (hits.length === 0 && !hasNonLiteralRmInvocation(command)) return
  const warn = warnOnly()
  recordGuardEvent({
    guard: GUARD,
    decision: warn ? 'warned' : 'blocked',
    session: input.session_id,
    agent: input.agent_id,
    class: hits.length > 0 ? `prompt:${hits[0].rule}` : 'prompt:unpredicted',
    evidence: { event: 'PermissionRequest', hits: hits.length },
  })
  if (warn) return
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: refusalText(command, hits, { afterPrompt: true }) },
    },
  }))
}

function main() {
  const input = readStdinJson()
  if (input.tool_name !== 'Bash') return
  const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : ''
  if (!command) return
  if (input.hook_event_name === 'PreToolUse') preToolUse(input, command)
  else if (input.hook_event_name === 'PermissionRequest') permissionRequest(input, command)
}

runFailOpenHook(GUARD, main)
