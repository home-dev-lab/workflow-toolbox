#!/usr/bin/env node
// wt-git-commit-backtick-guard-hook.mjs — a PreToolUse guard, plugin-level: WARNS when a git
// commit/tag/notes `-m "..."` (double-quoted) argument contains an unescaped backtick — inside
// double quotes that IS command substitution, and the shell silently runs whatever follows it as
// a command, then splices its (often empty) stdout into the message. Nothing errors; the commit
// still succeeds.
//
// WHY. Measured: `git commit -m "the default \`stretch\` applied"` ran `stretch` as a command,
// printed "stretch: command not found" to stderr, and committed the sentence with the word
// silently replaced by nothing. The commit succeeded, so nothing failed loudly — only reading
// the stored message afterwards revealed the hole.
//
// A second hazard is covered by the same warn-only posture: `git commit --allow-empty` whose
// -m/--message texts name no marker word. `--allow-empty` permits a commit that records no change;
// one whose subject announces a delivery leaves a false "done" for whatever cites it. Each
// `git commit` command is judged on its OWN flags and messages, and a `git commit` that is only
// the text of another command's quoted argument is not a commit. When a command has both
// hazards, ONE notice carries both warnings.
//
// ⚠ WARNS, NEVER DENIES — a new guard's precision is measured on material it did not choose
// before it is allowed to block (mechanise-on-sight.md). This one reasons about a shell string
// via regex, which cannot perfectly parse quoting; a false positive on a benign already-escaped
// backtick would just be a nag, never a lost commit, so warn-only is the correct posture until
// its false-positive rate is measured on real usage.
//
// ⚠ WHAT IT DOES NOT COVER, so its silence is not read as coverage:
//   - single-quoted -m arguments for the BACKTICK check (no substitution risk — deliberately
//     silent; the empty-commit check does read them);
//   - the heredoc / `-F` form (the documented safe form — deliberately silent); an empty commit
//     whose message comes from -F has no readable subject, so it is never judged;
//   - the `-m "$(cat <<'EOF' ... EOF)"` form — a heredoc body embedded in a command
//     substitution, this project's own dominant commit convention. Its backticks are DATA (the
//     quoted heredoc delimiter disables all shell expansion inside the body), never CODE, so
//     they must never reach the backtick check — this is a MEASURED fix, not a design guess: a
//     first port without heredoc-stripping fired on 16/466 real historical commits, and reading
//     all 16 showed 12 were exactly this safe form (75% false-positive rate on the fired set,
//     against this project's own dominant commit shape). Stripped the same way the sibling
//     `wt-unquoted-tool-glob-guard-hook.mjs` strips heredoc bodies before matching;
//   - a backtick inside a variable that is THEN interpolated into -m (one hop too far for a
//     string-only guard);
//   - any command other than a Bash tool_use (a commit issued through another tool is invisible
//     to this hook).

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

// Heredoc bodies are DATA, not CODE — a `-m "$(cat <<'EOF' ... EOF)"` message's quoted-delimiter
// heredoc body is never expanded by the shell, so a backtick inside it is inert. Strip it before
// matching, or every such commit (this project's own dominant convention) reads as a hazard.
// Same technique as `wt-unquoted-tool-glob-guard-hook.mjs`'s `stripDataSpans`.
function stripHeredocBodies(cmd) {
  let out = cmd
  out = out.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\2$/gm, '<<HEREDOC')
  // Unterminated heredoc (the tag never closes inside this command): drop the tail.
  out = out.replace(/<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1[\s\S]*$/, '<<HEREDOC')
  return out
}

// Matches -m "...", --message "..." or --message="..." with a DOUBLE-quoted argument, up to the
// next unescaped closing quote.
const DQUOTE_MESSAGE_ARG = /(?:-m|--message)(?:\s+|=)"((?:[^"\\]|\\.)*)"/g

function hasUnescapedBacktick(content) {
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '`' && content[i - 1] !== '\\') return true
  }
  return false
}

// An empty commit is fine as a marker, and a defect when its subject announces work it did not
// do. The marker vocabulary is a guess about how people word an honest empty commit; a message
// naming any of these words is taken as honest and stays silent.
const MARKER_SINGLE = /\b(?:marker|empty|placeholder|no-?op|wip|checkpoint|trigger|ci)\b/i
const MARKER_PHRASES = /\bno\s+(?:code|change|diff)\b|\bnothing\s+to\s+(?:commit|write)\b/i
const namesMarker = (text) => MARKER_SINGLE.test(text) || MARKER_PHRASES.test(text)

// One shell token: a quoted piece (an unclosed quote runs to the end), an escape, a separator,
// a blank run, or a run of plain characters. The alternatives start on disjoint characters.
const QUOTED_PIECE = /'[^']*'?|"(?:\\[\s\S]|[^"\\])*"?/
const SHELL_PIECE = new RegExp(String.raw`${QUOTED_PIECE.source}|\\[\s\S]|[;&|\n]|[^\S\n]+|[^\s'"\\;&|]+`, 'g')
const CLOSED_DOUBLE = /^"(?:\\[\s\S]|[^"\\])*"$/
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
// `-m <msg>`, `-m<msg>`, or a cluster of value-less flags ending in m (`-am <msg>`, `-amship`).
const SHORT_MESSAGE = /^-[aqvsne]*m(.*)$/s

function pieceText(piece) {
  if (piece.startsWith("'")) return piece.slice(1, piece.endsWith("'") && piece.length > 1 ? -1 : undefined)
  if (piece.startsWith('"')) {
    const body = piece.slice(1, CLOSED_DOUBLE.test(piece) ? -1 : undefined)
    return body.replace(/\\([\\"$`\n])/g, '$1')
  }
  return piece.startsWith('\\') ? piece.slice(1) : piece
}

// The simple commands of a command line, quote-aware, as lists of words with quotes removed.
function simpleCommands(cmd) {
  const commands = [[]]
  let word = null
  const end = () => {
    if (word !== null) commands[commands.length - 1].push(word)
    word = null
  }
  for (const [piece] of cmd.matchAll(SHELL_PIECE)) {
    const separator = /^[;&|\n]$/.test(piece)
    const blank = !separator && /^\s/.test(piece)
    if (separator || blank) end()
    if (separator) commands.push([])
    else if (!blank) word = (word ?? '') + pieceText(piece)
  }
  end()
  return commands
}

// Words that run the NEXT word as a command, each with the options that take a value and the
// count of positional arguments (timeout's duration) before that command. Kept in step with the
// find guard's map: the hooks ship standalone, so they share no library.
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
// Reserved words after which the next word is again in command position.
const RESERVED_WORDS = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{', '('])
const SHELL_COMMAND = /^(?:sh|bash|zsh)$/
const SHELL_OPTION_WITH_VALUE = /^[-+][oO]$|^--(?:rcfile|init-file)$/
const SHELL_FLAG_CLUSTER = /^-[A-Za-z]+$/
const MAX_SCRIPT_DEPTH = 3

const baseName = (word) => word.slice(word.lastIndexOf('/') + 1)
// `command -v` / `-V` (alone or in a cluster) looks a name up and runs nothing.
const isLookup = (words, at) => baseName(words[at]) === 'command' && /^-[a-zA-Z]*[vV]/.test(words[at + 1] ?? '')

// The index after a launcher word, its options (with their values) and its positional arguments.
function skipLauncher(words, at) {
  const { valued, positional } = LAUNCHERS.get(baseName(words[at]))
  let index = at + 1
  while (index < words.length && words[index].startsWith('-')) {
    const option = words[index]
    index += valued.test(option) ? 2 : 1
    if (option === '--') break
  }
  return index + positional
}

// The index of the word in command position: after reserved words, assignments, and launchers
// with their arguments. Words are already quote-removed.
function commandStart(words) {
  let index = 0
  while (index < words.length) {
    if (RESERVED_WORDS.has(words[index]) || ASSIGNMENT.test(words[index])) index++
    else if (isLookup(words, index)) return words.length
    else if (LAUNCHERS.has(baseName(words[index]))) index = skipLauncher(words, index)
    else break
  }
  return index
}

// The script of `[launchers] sh|bash|zsh [options] -c <script>`, or null when the shell runs a
// file instead, or when the shell word is only an argument (`echo bash -c '…'`).
function shellScript(words) {
  const head = commandStart(words)
  if (head >= words.length || !SHELL_COMMAND.test(baseName(words[head]))) return null
  let runsScript = false
  for (let index = head + 1; index < words.length; index++) {
    const word = words[index]
    if (SHELL_OPTION_WITH_VALUE.test(word)) index++
    else if (/^[-+]/.test(word)) runsScript ||= SHELL_FLAG_CLUSTER.test(word) && word.includes('c')
    else return runsScript ? word : null
  }
  return null
}

// The arguments of a `git [global options] commit …` command in command position, or null.
function commitArguments(words) {
  let i = commandStart(words)
  if (words[i]?.split('/').pop() !== 'git') return null
  i++
  while (i < words.length && words[i].startsWith('-')) i += GIT_VALUE_OPTIONS.has(words[i]) ? 2 : 1
  return words[i] === 'commit' ? words.slice(i + 1) : null
}

// Every -m/--message text of one commit's arguments, in every spelling git accepts.
function commitMessages(args) {
  const messages = []
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const arg = args[i]
    const short = arg.startsWith('--') ? null : arg.match(SHORT_MESSAGE)
    if (arg.startsWith('--message=')) messages.push(arg.slice('--message='.length))
    else if (arg === '--message' || (short && short[1] === '')) messages.push(args[++i] ?? '')
    else if (short) messages.push(short[1])
  }
  return messages
}

// Warn text for ONE commit, else null. No readable message (a -F file) means the subject cannot be
// judged: fail open, silently.
function commitNotice(args) {
  if (!args.includes('--allow-empty')) return null
  const messages = commitMessages(args)
  if (!messages.length || messages.some(namesMarker)) return null
  return EMPTY_NOTICE
}

const CLASS_BACKTICK = 'unescaped-backtick'
const CLASS_EMPTY = 'empty-commit-claims-delivery'

const BACKTICK_NOTICE =
  '⚠ [workflow-toolbox git-commit backtick guard] A double-quoted git -m/--message ' +
  'argument contains an unescaped backtick — inside double quotes that IS command ' +
  'substitution: the shell will run whatever follows it and splice its output (often ' +
  'nothing) into the message, with no error. Measured: a word silently vanished from a ' +
  "real commit message this way. Safe forms: a heredoc (`git commit -F - <<'MSG' ... " +
  'MSG`), single quotes, or an escaped backtick (`\\``).'

const EMPTY_NOTICE =
  '⚠ [workflow-toolbox git-commit backtick guard] This commit passes --allow-empty, so it may ' +
  'record NO change, and its message does not say it is a marker. A commit that records nothing ' +
  'is fine as a marker, and a defect when its subject announces work it did not do: whatever ' +
  'cites it as a delivery then carries a false "done", and the next session briefs work from it. ' +
  'If it is a marker, say what it IS ("marker: no code written, reason X"); if it carries the ' +
  'change, --allow-empty is not needed. Warning only; proceed if the subject is honest.'

// Warn text when one `git commit` command passes --allow-empty and its readable messages name no
// marker, else null. Each commit is judged alone: another commit's marker never excuses it. A
// shell `-c` script is walked as a command line of its own, at most MAX_SCRIPT_DEPTH levels deep.
function emptyCommitNotice(scanned, depth = 0) {
  if (!scanned.includes('--allow-empty')) return null
  for (const words of simpleCommands(scanned)) {
    const args = commitArguments(words)
    if (args && commitNotice(args)) return EMPTY_NOTICE
    const script = depth < MAX_SCRIPT_DEPTH ? shellScript(words) : null
    if (script !== null && emptyCommitNotice(script, depth + 1)) return EMPTY_NOTICE
  }
  return null
}

function backtickNotice(scanned) {
  for (const m of scanned.matchAll(DQUOTE_MESSAGE_ARG)) {
    if (hasUnescapedBacktick(m[1])) return BACKTICK_NOTICE
  }
  return null
}

function journalWarning(input, klass, evidence) {
  // No `reason`: the flagged fragment is the commit message text itself, and raw command
  // text never reaches the journal on a machine that exports credentials into shells.
  recordGuardEvent({
    guard: 'wt-git-commit-backtick-guard-hook.mjs',
    decision: 'warned',
    session: input.session_id,
    agent: input.agent_id,
    class: klass,
    evidence,
  })
}

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Bash') return

  const cmd = input.tool_input && typeof input.tool_input.command === 'string'
    ? input.tool_input.command
    : ''
  if (!cmd) return
  if (!/\bgit\s+(commit|tag|notes)\b/.test(cmd)) return // scope: git operations that store prose

  const scanned = stripHeredocBodies(cmd)
  // Both hazards are checked and both are reported, in ONE notice: an empty commit with an
  // unescaped backtick must not lose the second warning.
  const notices = []
  const empty = emptyCommitNotice(scanned)
  if (empty) {
    journalWarning(input, CLASS_EMPTY, { flag: '--allow-empty' })
    notices.push(empty)
  }
  const backtick = backtickNotice(scanned)
  if (backtick) {
    journalWarning(input, CLASS_BACKTICK, { flag: '-m' })
    notices.push(backtick)
  }
  if (!notices.length) return

  const payload = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notices.join('\n\n') },
  }
  emitGuardNotice({ payload: input, stdoutJson: payload })
}

runFailOpenHook('wt-git-commit-backtick-guard-hook.mjs', main)
