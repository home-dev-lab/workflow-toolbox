#!/usr/bin/env node
// wt-find-newermt-format-guard-hook.mjs — a PreToolUse guard, plugin-level: WARNS when a
// `find … -newermt <arg>` argument is not ISO-8601 or a timestamp lacks a UTC offset.
// On some `find` builds (e.g. `bfs`),
// `-newermt` accepts ONLY ISO-8601 timestamps and whole `@epoch` seconds. A natural English date
// ("5 minutes ago") or a fractional `@epoch.frac` value makes such a build print an error to
// STDERR; with stderr swallowed (2>/dev/null, or just piped into `wc -l`/`head`), the
// command looks like it ran clean and
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
// A fractional `@epoch.frac` warns too, because `bfs` rejects it; a whole `@epoch` stays silent,
// because `bfs` accepts it. This ships warn-only.
//
// ⚠ WARNS, NEVER DENIES — a new guard's precision is measured on material it did not choose
// before it is allowed to block (mechanise-on-sight.md). This one reasons about a shell string
// via shell-word text matching; it cannot evaluate a command substitution's actual output, so it treats any
// `$(...)` argument as presumed-safe rather than trying to parse further. Shell-variable values
// are also unknown, so variable arguments are presumed-safe. A `find` written INSIDE a `$(...)`
// body (assignments, `for … in $(…)`, nested substitutions) or inside the script of
// `sh -c` / `bash -c` / `zsh -c` is checked like a top-level one, down to a fixed nesting depth.
//
// ⚠ WHAT IT DOES NOT COVER, so its silence is not read as coverage:
//   - an argument built via `$(...)` command substitution — presumed safe, deliberately silent
//     (the common correct form pipes `date -d ... +%Y-%m-%dT%H:%M:%S%:z` through here;
//     the offset avoids ambiguous local time at a DST fall-back);
//   - a shell-variable argument (`$T`, `${T}`) — its value is unknown, deliberately silent;
//   - a bare ISO date with no time component (`2026-08-06`) — accepted by ISO-8601-only builds,
//     deliberately silent; likewise a whole `@epoch` (`@1792887059`);
//   - a `find` build that accepts natural-language dates (GNU findutils) — the guard has no way
//     to detect which build resolves, so it warns unconditionally;
//   - a `find` inside a backtick substitution, or nested deeper than the fixed depth bound of
//     substitutions and `-c` scripts;
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
// This matcher does not evaluate shell code or variable values.
// A quoted `)` inside the body does not close it: `"$(printf ')'; find …)"` runs the find.
const SUBSTITUTION_QUOTE = /'[^']*'|"(?:\\[\s\S]|[^"\\])*"/
const COMMAND_SUBSTITUTION = new RegExp(String.raw`\$\((?:${SUBSTITUTION_QUOTE.source}|[^()'"]|\([^()]*\))*\)`)
// Inside double quotes `$(` only opens a substitution, so its body may carry its own quotes. The
// alternatives start on disjoint characters: a malformed input cannot backtrack exponentially.
const DOUBLE_QUOTED = new RegExp(String.raw`"(?:\\[\s\S]|${COMMAND_SUBSTITUTION.source}|\$(?!\()|[^"\\$])*"`)
const QUOTED_WORD_PART = new RegExp(String.raw`\`(?:\\.|[^\`\\])*\`|${DOUBLE_QUOTED.source}|'[^']*'`)
const BARE_WORD_PART = /\\[\s\S]|[^\s"'`\\;&|()<>]/
const SHELL_COMMENT = /#[^\n]*/
const SHELL_TOKEN = new RegExp(`${SHELL_COMMENT.source}|(?:${COMMAND_SUBSTITUTION.source}|${QUOTED_WORD_PART.source}|${BARE_WORD_PART.source})+|[;&|()\\n<>]`, 'g')
const COMMAND_SEPARATOR = /^[;&|()\n]$/
const FIND_COMMAND = /(?:^|\/)(?:find|bfs)$/

// Nested shell text re-read as commands: `$(...)` bodies and `sh|bash|zsh -c` scripts.
const MAX_NESTING = 8
// A word's segments: single-quoted text and escapes are inert, double-quoted text is scanned.
const WORD_SEGMENT = new RegExp(String.raw`'[^']*'|\\[\s\S]|${DOUBLE_QUOTED.source}|${COMMAND_SUBSTITUTION.source}`, 'g')
const QUOTED_SUBSTITUTION = new RegExp(String.raw`\\[\s\S]|${COMMAND_SUBSTITUTION.source}`, 'g')
const SHELL_COMMAND = /(?:^|\/)(?:sh|bash|zsh)$/
const SHELL_FLAG_CLUSTER = /^-[A-Za-z]+$/
const SHELL_OPTION_WITH_VALUE = /^[-+][oO]$|^--(?:rcfile|init-file)$/
// Words that run the NEXT word as a command, each with the options that take a value and the
// count of positional arguments (timeout's duration) before that command.
const LAUNCHERS = new Map([
  ['sudo', { valued: /^-[ugCDhpRrtTU]$|^--(?:user|group|chdir|prompt|host)$/, positional: 0 }],
  ['timeout', { valued: /^-[sk]$|^--(?:signal|kill-after)$/, positional: 1 }],
  ['nice', { valued: /^-n$|^--adjustment$/, positional: 0 }],
  ['env', { valued: /^-[uCS]$|^--(?:unset|chdir|split-string)$/, positional: 0 }],
  ['stdbuf', { valued: /^-[ioe]$/, positional: 0 }],
  ['exec', { valued: /^-a$/, positional: 0 }],
  ...['nohup', 'setsid', 'time', 'command'].map((name) => [name, { valued: /^$/, positional: 0 }]),
])
const ASSIGNMENT = /^[A-Za-z_]\w*=/

// A bare ISO date stays accepted; a time component needs an explicit UTC offset.
const ISO_DATE = /\d{4}-\d{2}-\d{2}/
const ISO_TIME = /[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?/
const UTC_OFFSET = /Z|[+-]\d{2}:\d{2}/
const ISO_8601 = new RegExp(`^${ISO_DATE.source}(?:${ISO_TIME.source}(?:${UTC_OFFSET.source}))?$`)
// `bfs` accepts whole epoch seconds and rejects a fractional `@epoch.frac`.
const WHOLE_EPOCH = /^@-?\d+$/
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
  return (expandable.includes('$') && SHELL_VARIABLE.test(arg)) || ISO_8601.test(arg) || WHOLE_EPOCH.test(arg)
}

function unsafeFindArgument(words) {
  const head = words.findIndex((word) => FIND_COMMAND.test(shellValue(word)))
  if (head === -1) return null
  const args = words.slice(head + 1)
  for (const [index, arg] of args.entries()) {
    if (arg !== '-newermt') continue
    const raw = args[index + 1]
    if (raw && !isPresumedSafe(raw)) return shellValue(raw)
  }
  return null
}

// The bodies of the `$(...)` substitutions a word expands (single-quoted text expands nothing).
function* substitutionBodies(word) {
  for (const [segment] of word.matchAll(WORD_SEGMENT)) {
    if (segment.startsWith('$(')) yield segment.slice(2, -1)
    else if (segment.startsWith('"')) {
      for (const [inner] of segment.matchAll(QUOTED_SUBSTITUTION)) {
        if (inner.startsWith('$(')) yield inner.slice(2, -1)
      }
    }
  }
}

function launcherName(word) {
  const value = shellValue(word)
  return value.slice(value.lastIndexOf('/') + 1)
}

// The index after a launcher word, its options (with their values) and its positional arguments.
function skipLauncher(words, at) {
  const { valued, positional } = LAUNCHERS.get(launcherName(words[at]))
  let index = at + 1
  while (index < words.length && shellValue(words[index]).startsWith('-')) {
    const option = shellValue(words[index])
    index += valued.test(option) ? 2 : 1
    if (option === '--') break
  }
  return index + positional
}

// The index of the word in command position: after assignments and launchers with their arguments.
function commandStart(words) {
  let index = 0
  while (index < words.length) {
    if (ASSIGNMENT.test(shellValue(words[index]))) index++
    else if (LAUNCHERS.has(launcherName(words[index]))) index = skipLauncher(words, index)
    else break
  }
  return index
}

// The script of `[launchers] sh|bash|zsh [options] -c <script>`, or null when the shell runs a
// file instead, or when the shell word is only an argument (`echo bash -c '…'`).
function shellScript(words) {
  const head = commandStart(words)
  if (head >= words.length || !SHELL_COMMAND.test(shellValue(words[head]))) return null
  let runsScript = false
  for (let index = head + 1; index < words.length; index++) {
    const word = shellValue(words[index])
    if (SHELL_OPTION_WITH_VALUE.test(word)) index++
    else if (/^[-+]/.test(word)) runsScript ||= SHELL_FLAG_CLUSTER.test(word) && word.includes('c')
    else return runsScript ? word : null
  }
  return null
}

function* nestedShellText(words) {
  for (const word of words) yield* substitutionBodies(word)
  const script = shellScript(words)
  if (script !== null) yield script
}

function nestedFlaggedArgument(words, depth) {
  if (depth >= MAX_NESTING) return null
  for (const text of nestedShellText(words)) {
    const flagged = flaggedArgument(text, depth + 1)
    if (flagged !== null) return flagged
  }
  return null
}

function flaggedArgument(cmd, depth = 0) {
  for (const words of simpleCommands(cmd)) {
    const flagged = unsafeFindArgument(words) ?? nestedFlaggedArgument(words, depth)
    if (flagged !== null) return flagged
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
        '`-newermt` — they reject a fractional `@epoch` value as well as a natural-language date ' +
        '("5 minutes ago") on stderr and, when ' +
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
