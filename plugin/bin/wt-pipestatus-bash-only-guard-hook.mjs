#!/usr/bin/env node
// wt-pipestatus-bash-only-guard-hook.mjs — a PreToolUse guard, plugin-level: WARNS when a Bash
// command references `PIPESTATUS` — under zsh, `PIPESTATUS` is a BASH-only array. In zsh the
// equivalent is `$pipestatus` (lowercase, 1-indexed) — `PIPESTATUS` simply does not exist there,
// so any reference to it expands to EMPTY with no error. A command built to read a pipeline's
// real exit code (`cmd | tee log; echo ${PIPESTATUS[0]}`) then silently reports nothing, and an
// `if [ "${PIPESTATUS[0]}" = 0 ]` reads as false without ever failing loudly.
//
// WHY. Verified live under zsh: `true | false; echo "${PIPESTATUS[0]}"` prints an EMPTY string
// (not `1`), while the pipeline's own `$?` correctly reports `1`. This is the exact shell-family
// trap `wt-verify-by-ground-truth.md` names: never pipe a gate and read `$?` through PIPESTATUS —
// the safe form is redirect-to-file, then `$?`, then read the file (shell-independent), or
// `$pipestatus[1]` if a zsh-native array is wanted.
//
// This guard applies ONLY under a zsh-shaped shell hazard model: it fires on the bare
// `PIPESTATUS` token regardless of which shell actually runs the command, because the guard
// cannot see which shell interprets a given Bash tool_use — under bash the reference is correct
// and the warning is a false positive there, which is why this ships warn-only rather than
// blocking (see below).
//
// ⚠ WARNS, NEVER DENIES — a new guard's precision is measured on material it did not choose
// before it is allowed to block (mechanise-on-sight.md). This one reasons about a shell string
// via regex, which cannot know whether the reference sits inside a heredoc/comment merely
// describing the trap (as this very file does) — a false positive there is a nag, never a lost
// command, so warn-only is correct until measured.
//
// ⚠ WHAT IT DOES NOT COVER, so its silence is not read as coverage:
//   - the zsh-correct form `$pipestatus[1]` (lowercase) — deliberately silent, that is the fix;
//   - `PIPESTATUS` appearing only in prose (an echo, a commit message, a heredoc quoting this
//     trap) — same known false-positive family as the sibling guards in this directory;
//   - a shell environment where `PIPESTATUS` is genuinely bash and genuinely correct — the guard
//     has no way to know which shell interprets the command, so it warns unconditionally;
//   - any command other than a Bash tool_use.

import { readFileSync } from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

// Bare `PIPESTATUS` (all-caps, the bash-only array name), not part of a longer identifier.
const PIPESTATUS_REF = /(?<![\w])PIPESTATUS(?![\w])/

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Bash') return

  const cmd = input.tool_input && typeof input.tool_input.command === 'string'
    ? input.tool_input.command
    : ''
  if (!cmd) return
  if (!PIPESTATUS_REF.test(cmd)) return

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        '⚠ [workflow-toolbox pipestatus guard] `PIPESTATUS` is BASH-ONLY — under zsh it does ' +
        'not exist and expands EMPTY with no error (verified live: `true | false; echo ' +
        '"${PIPESTATUS[0]}"` prints nothing, not `1`, while `$?` correctly reports `1`). If your ' +
        'Bash tool runs under zsh, use `$pipestatus[1]` (lowercase, zsh) for a pipeline stage\'s ' +
        'exit code, or better: redirect the gate to a file, then `echo $?`, then read the file — ' +
        'shell-independent and never piped.',
    },
  }
  recordGuardEvent({
    guard: 'wt-pipestatus-bash-only-guard-hook.mjs',
    decision: 'warned',
    class: 'pipestatus-bash-only',
  })
  process.stdout.write(JSON.stringify(payload))
}

runFailOpenHook('wt-pipestatus-bash-only-guard-hook.mjs', main)
