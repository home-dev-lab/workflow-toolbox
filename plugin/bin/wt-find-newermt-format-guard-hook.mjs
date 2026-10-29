#!/usr/bin/env node
// wt-find-newermt-format-guard-hook.mjs — a PreToolUse guard, plugin-level: WARNS when a
// `find … -newermt <arg>` argument is not ISO-8601 or a timestamp lacks a UTC offset.
// On some `find` builds (e.g. `bfs`),
// `-newermt` accepts ONLY ISO-8601 timestamps. A natural English date ("5 minutes ago") makes
// such a build print an error to STDERR and still exit 0 when piped — with stderr swallowed
// (2>/dev/null, or just piped into `wc -l`/`head`), the command looks like it ran clean and
// simply found nothing, which reads as "no recent files" instead of "the date format was
// rejected".
//
// WHY. Verified live on a `bfs`-backed `find`: `find . -newermt "5 minutes ago" 2>/dev/null |
// wc -l` returns `0` — indistinguishable from a correct empty result. The safe form is
// `find . -newermt "$(date -d '5 minutes ago' +%Y-%m-%dT%H:%M:%S%:z)"` — the offset avoids
// ambiguous local time at a DST fall-back.
//
// This hazard is build-specific (GNU findutils' `find` accepts natural-language dates fine) —
// the guard cannot see which `find` a given Bash tool_use resolves to, so it fires
// unconditionally on the non-ISO shape rather than trying to detect the build. Offsetless
// timestamp literals also warn: local time is ambiguous during a DST fall-back, even on GNU find.
// This ships warn-only.
//
// ⚠ WARNS, NEVER DENIES — a new guard's precision is measured on material it did not choose
// before it is allowed to block (mechanise-on-sight.md). This one reasons about a shell string
// via shell-word text matching; it cannot evaluate a command substitution's actual output, so it treats any
// `$(...)` argument as presumed-safe rather than trying to parse further. Shell-variable values
// are also unknown, so variable arguments are presumed-safe.
//
// ⚠ WHAT IT DOES NOT COVER, so its silence is not read as coverage:
//   - an argument built via `$(...)` command substitution — presumed safe, deliberately silent
//     (the common correct form pipes `date -d ... +%Y-%m-%dT%H:%M:%S%:z` through here;
//     the offset avoids ambiguous local time at a DST fall-back);
//   - a shell-variable argument (`$T`, `${T}`) — its value is unknown, deliberately silent;
//   - a bare ISO date with no time component (`2026-08-06`) — accepted by ISO-8601-only builds,
//     deliberately silent;
//   - a `find` build that accepts natural-language dates (GNU findutils) — the guard has no way
//     to detect which build resolves, so it warns unconditionally;
//   - `find` invoked through a variable or wrapper script that isn't visible in the command
//     text itself;
//   - any command other than a Bash tool_use.
//
// ⚠ KNOWN FALSE POSITIVE: this is not a complete shell parser. A heredoc body documenting
// this trap can still resemble a simple command. Quoted arguments of other programs are
// skipped, but heredoc bodies are not distinguished from commands. Harmless here because it only warns
// (additionalContext), never denies.

import { readFileSync } from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

// Keep adjacent quoted/bare segments in one word and operators outside quotes separate.
// Substitutions remain opaque; this matcher does not evaluate shell code or variable values.
const COMMAND_SUBSTITUTION = /\$\((?:[^()]|\([^()]*\))*\)/
const QUOTED_WORD_PART = /`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'[^']*'/
const BARE_WORD_PART = /\\[\s\S]|[^\s"'`\\;&|()<>]/
const SHELL_COMMENT = /#[^\n]*/
const SHELL_TOKEN = new RegExp(`${SHELL_COMMENT.source}|(?:${COMMAND_SUBSTITUTION.source}|${QUOTED_WORD_PART.source}|${BARE_WORD_PART.source})+|[;&|()\\n<>]`, 'g')
const COMMAND_SEPARATOR = /^[;&|()\n]$/
const FIND_COMMAND = /(?:^|\/)(?:find|bfs)$/

// A bare ISO date stays accepted; a time component needs an explicit UTC offset.
const ISO_DATE = /\d{4}-\d{2}-\d{2}/
const ISO_TIME = /[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?/
const UTC_OFFSET = /Z|[+-]\d{2}:\d{2}/
const ISO_8601 = new RegExp(`^${ISO_DATE.source}(?:${ISO_TIME.source}(?:${UTC_OFFSET.source}))?$`)
const EPOCH = /^@-?\d+(?:\.\d+)?$/
const SHELL_VARIABLE = /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/

function shellValue(raw) {
  return raw.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\([\s\S])/g, (_match, single, double, escaped) => {
    if (single !== undefined) return single
    if (double !== undefined) return double.replace(/\\(["\\$`])/g, '$1')
    return escaped
  })
}

function* simpleCommands(cmd) {
  let words = []
  for (const match of cmd.replace(/\\\n/g, '').matchAll(SHELL_TOKEN)) {
    const token = match[0]
    if (token.startsWith('#')) continue
    if (COMMAND_SEPARATOR.test(token)) {
      yield words
      words = []
    } else words.push(token)
  }
  yield words
}

function isPresumedSafe(raw) {
  const arg = shellValue(raw)
  const expandable = raw.replace(/'[^']*'|\\[\s\S]/g, '')
  if (expandable.includes('$(') || expandable.includes('`')) return true
  return (expandable.includes('$') && SHELL_VARIABLE.test(arg)) || ISO_8601.test(arg) || EPOCH.test(arg)
}

function flaggedArgument(cmd) {
  for (const words of simpleCommands(cmd)) {
    const head = words.findIndex((word) => FIND_COMMAND.test(shellValue(word)))
    if (head === -1) continue
    const args = words.slice(head + 1)
    for (const [index, arg] of args.entries()) {
      if (arg !== '-newermt') continue
      const raw = args[index + 1]
      if (raw && !isPresumedSafe(raw)) return shellValue(raw)
    }
  }
  return null
}

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Bash') return

  const cmd = input.tool_input && typeof input.tool_input.command === 'string'
    ? input.tool_input.command
    : ''
  if (!cmd) return
  if (!/\b(?:find|bfs)\b/.test(cmd)) return
  if (!/-newermt\b/.test(cmd)) return

  const flagged = flaggedArgument(cmd)
  if (!flagged) return

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        `⚠ [workflow-toolbox find-newermt guard] \`find -newermt "${flagged}"\` does not look ` +
        'like an ISO-8601 date or a timestamp with a UTC offset. ' +
        'Some `find` builds (e.g. `bfs`) accept ONLY ISO-8601 timestamps for ' +
        '`-newermt` — a natural-language date ("5 minutes ago") is rejected on stderr and, when ' +
        'stderr is swallowed or piped, the command silently reports zero matches instead of ' +
        'erroring. Safe form: `-newermt "$(date -d \'5 minutes ago\' +%Y-%m-%dT%H:%M:%S%:z)"` ' +
        '— the offset avoids ambiguous local time at a DST fall-back.',
    },
  }
  recordGuardEvent({
    guard: 'wt-find-newermt-format-guard-hook.mjs',
    decision: 'warned',
    session: input.session_id,
    agent: input.agent_id,
    class: 'non-iso-newermt',
    // No `reason`: the flagged argument is raw command text; only its shape is recorded.
    evidence: { arg: 'non-iso' },
  })
  emitGuardNotice({ payload: input, stdoutJson: payload })
}

runFailOpenHook('wt-find-newermt-format-guard-hook.mjs', main)
