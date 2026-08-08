#!/usr/bin/env node
// wt-pgrep-env-dump-guard-hook.mjs — a PreToolUse guard on Bash: warn when a command uses
// `pgrep -a`/`-f` in a form that prints full command lines (`-a`/`-l`/`-af`/`-fl`…), or
// `ps -f`/`ps aux`/`ps -ef`/`ps -o args=` without a PID filter.
//
// WHY. A Bash-tool shell launched via a shell function wrapper commonly carries its own
// environment on its OWN command line — package-manager detection, plugin flags, session
// bookkeeping, whatever the wrapper exports before invoking the real binary. A full-listing
// `pgrep`/`ps` then dumps every one of those `export KEY=value` pairs into the transcript, which
// the model then holds durably — and the call itself does not look unusual: the output is
// plausible-looking process-listing text, just carrying content nobody asked to see, and
// possibly secrets among it.
//
// ⚠ WARNS, NEVER DENIES — a new guard's precision is measured on material it did not choose
// before it is allowed to block. This one reasons about a shell string via regex; it cannot know
// the actual match count a given pattern will return, so a narrow, safe
// `pgrep -af <very-specific-unique-name>` still fires even though its real output may be small.
// Warn-only lets the caller judge.
//
// ⚠ WHAT IT DOES NOT COVER, so its silence is not read as coverage:
//   - PID-only forms (`pgrep -f pattern`, `pgrep -c -f pattern`, bare `pgrep pattern`) —
//     deliberately silent, that is the safe form;
//   - `ps -o args= -p <pid>` (a single already-identified PID, the sanctioned follow-up) —
//     silent by design, even though it still matches `ps -o args=` loosely; see the negative
//     lookahead below;
//   - a bare `ps` with no `-a`/`-e`/`-f`/`aux` flag;
//   - prose ABOUT this trap (a heredoc, a commit message documenting the pattern) — same known
//     false-positive family as the sibling guards in this directory: a textual guard cannot tell
//     code from data.

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

// pgrep with a full-listing flag: -a, -l, or a combined short-flag cluster containing one of
// them (e.g. -af, -fa, -la). The dash must be preceded by whitespace or the string start (a real
// argument boundary), never mid-token — otherwise a hyphenated PATTERN argument (e.g.
// `pgrep my-pattern`) reads as if it contained a flag.
const PGREP_FULL = /\bpgrep\b[^\n|;&]*(?:\s|^)-[a-zA-Z]*[al][a-zA-Z]*(?=\s|$)/
// ps with a full-listing flag set (-ef, -aux/aux, -f alone, -o args= without a -p PID filter).
const PS_EF_AUX = /\bps\b[^\n|;&]*(-ef\b|\baux\b|-aux\b)/
const PS_ARGS_NO_PID = /\bps\b(?![^\n]*-p\s)[^\n|;&]*-o\s*args=/

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Bash') return

  const cmd = input.tool_input && typeof input.tool_input.command === 'string'
    ? input.tool_input.command
    : ''
  if (!cmd) return

  const hit = PGREP_FULL.test(cmd) || PS_EF_AUX.test(cmd) || PS_ARGS_NO_PID.test(cmd)
  if (!hit) return

  recordGuardEvent({
    guard: 'wt-pgrep-env-dump-guard-hook.mjs',
    decision: 'warned',
    class: 'full-listing-pgrep-ps',
  })
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        '⚠ [workflow-toolbox pgrep-env-dump guard] A full-listing `pgrep`/`ps` can dump the ' +
        'ENTIRE process environment into the transcript — a Bash-tool shell launched via a shell ' +
        'wrapper commonly carries its own exported variables on its own command line, and a ' +
        'full-command listing prints all of them. Prefer `pgrep -f <pattern> | head -1` (PID ' +
        'only) or `pgrep -c -f <pattern>` (count only); request the full command line ONLY for ' +
        'an already-identified PID, truncated: `ps -o args= -p <pid> | cut -c1-120`.',
    },
  }
  process.stdout.write(JSON.stringify(payload))
}

runFailOpenHook('wt-pgrep-env-dump-guard-hook.mjs', main)
