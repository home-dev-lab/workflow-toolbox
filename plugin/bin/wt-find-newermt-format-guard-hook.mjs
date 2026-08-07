#!/usr/bin/env node
// wt-find-newermt-format-guard-hook.mjs — a PreToolUse guard, plugin-level: WARNS when a
// `find … -newermt <arg>` argument is not ISO-8601. On some `find` builds (e.g. `bfs`),
// `-newermt` accepts ONLY ISO-8601 timestamps. A natural English date ("5 minutes ago") makes
// such a build print an error to STDERR and still exit 0 when piped — with stderr swallowed
// (2>/dev/null, or just piped into `wc -l`/`head`), the command looks like it ran clean and
// simply found nothing, which reads as "no recent files" instead of "the date format was
// rejected".
//
// WHY. Verified live on a `bfs`-backed `find`: `find . -newermt "5 minutes ago" 2>/dev/null |
// wc -l` returns `0` — indistinguishable from a correct empty result. The safe form is
// `find . -newermt "$(date -d '5 minutes ago' +%Y-%m-%dT%H:%M:%S)"`.
//
// This hazard is build-specific (GNU findutils' `find` accepts natural-language dates fine) —
// the guard cannot see which `find` a given Bash tool_use resolves to, so it fires
// unconditionally on the non-ISO shape rather than trying to detect the build, which is part of
// why this ships warn-only.
//
// ⚠ WARNS, NEVER DENIES — a new guard's precision is measured on material it did not choose
// before it is allowed to block (mechanise-on-sight.md). This one reasons about a shell string
// via regex; it cannot evaluate a command substitution's actual output, so it treats any
// `$(...)` argument as presumed-safe rather than trying to parse further.
//
// ⚠ WHAT IT DOES NOT COVER, so its silence is not read as coverage:
//   - an argument built via `$(...)` command substitution — presumed safe, deliberately silent
//     (the common correct form pipes `date -d ... +%Y-%m-%dT%H:%M:%S` through here);
//   - a bare ISO date with no time component (`2026-08-06`) — accepted by ISO-8601-only builds,
//     deliberately silent;
//   - a `find` build that accepts natural-language dates (GNU findutils) — the guard has no way
//     to detect which build resolves, so it warns unconditionally;
//   - `find` invoked through a variable or wrapper script that isn't visible in the command
//     text itself;
//   - any command other than a Bash tool_use.
//
// ⚠ KNOWN FALSE POSITIVE, same family as the sibling guards in this directory: the guard reads
// the raw command STRING, so prose documenting this trap (a commit message, a heredoc) fires
// identically to a real invocation. Harmless here because this guard only warns
// (additionalContext), never denies.

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

// -newermt followed by a double-quoted, single-quoted, or bare argument.
const NEWERMT_ARG = /-newermt\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g

// ISO-8601 date, optionally with a time component (some `find` builds accept date-only or full
// timestamp).
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2})?$/

function isPresumedSafe(arg) {
  if (arg.startsWith('$(') || arg.includes('`')) return true // command substitution — presumed
  return ISO_8601.test(arg)
}

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Bash') return

  const cmd = input.tool_input && typeof input.tool_input.command === 'string'
    ? input.tool_input.command
    : ''
  if (!cmd) return
  if (!/\bfind\b/.test(cmd)) return
  if (!/-newermt\b/.test(cmd)) return

  let flagged = null
  for (const m of cmd.matchAll(NEWERMT_ARG)) {
    const arg = m[1] ?? m[2] ?? m[3] ?? ''
    if (!isPresumedSafe(arg)) {
      flagged = arg
      break
    }
  }
  if (!flagged) return

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        `⚠ [workflow-toolbox find-newermt guard] \`find -newermt "${flagged}"\` does not look ` +
        'like ISO-8601. Some `find` builds (e.g. `bfs`) accept ONLY ISO-8601 timestamps for ' +
        '`-newermt` — a natural-language date ("5 minutes ago") is rejected on stderr and, when ' +
        'stderr is swallowed or piped, the command silently reports zero matches instead of ' +
        'erroring. Safe form: `-newermt "$(date -d \'5 minutes ago\' +%Y-%m-%dT%H:%M:%S)"`.',
    },
  }
  recordGuardEvent({
    guard: 'wt-find-newermt-format-guard-hook.mjs',
    decision: 'warned',
    class: 'non-iso-newermt',
    reason: flagged,
  })
  process.stdout.write(JSON.stringify(payload))
}

runFailOpenHook('wt-find-newermt-format-guard-hook.mjs', main)
