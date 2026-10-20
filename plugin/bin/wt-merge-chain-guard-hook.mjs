#!/usr/bin/env node
// wt-merge-chain-guard-hook.mjs — a PreToolUse guard, plugin-level: journals (never blocks) a
// Bash command that chains a `git merge` together with whatever runs after it — `git merge x
// && pnpm test`, `git merge x ; pnpm test`, or the two on separate lines of one command string.
//
// WHY THE HAZARD. A merge can do NOTHING — `Already up to date` from the wrong tree, or an
// abort on a non-fast-forwardable branch — and the commands chained after it then run on the
// UNMERGED tree and return exit 0. Three gates green, three honest exit codes, certifying a
// subject nobody intended to certify. The exit code cannot detect this, and that is the point:
// it belongs to the gate, and the gate genuinely passes. It answers a question about the wrong
// SUBJECT, not the wrong gate. Observed three times in one day on this project, caught only by
// a human reading the merge's own output separately — a habit, not a mechanism.
//
// The remedy is always the same shape: run the merge ALONE, read its result, THEN gate. A `;`
// between them — or a newline, which is the same thing to the shell — hands the next command a
// stale tree to certify.
//
// ⚠ WHY THE MERGE CHECK IS NOT BLOCKING — measured, not a default caution. Measured against
// this project's own history before shipping: 1,140 distinct real `git
// merge`-containing Bash commands, replayed against this guard's own executable as PreToolUse
// payloads — 376 matched. Reading them: the overwhelming majority are NOT the blind-chain
// hazard — they are the project's own established careful pattern, `git merge x > log 2>&1;
// echo "merge: $?"; <inspect the log or compare tree hashes>`, which THIS guard's predicate
// can now distinguish from a blind chained gate through a closed set of diagnostic command heads.
// Blocking the remaining volume
// of correct, careful work is exactly the false-positive shape that gets a guard switched off,
// taking its real cases with it (`wt-unquoted-tool-glob-guard-hook.mjs`'s own header explains
// the bar this guard did not clear: 0 false positives on unchosen material before shipping
// blocking). This one journals until a narrower predicate — one that can tell "diagnostic read of
// the merge's own outcome" apart from "downstream gate trusting it blindly" — is designed and
// measured to that bar.
//
// WHAT THIS DOES NOT COVER, so its silence is not read as coverage:
//   - a `git merge` PRECEDED by other commands (`cd repo && git merge x`) — nothing after the
//     merge can certify a stale tree there, so refusing it would be exactly the false-positive
//     shape that gets a guard switched off;
//   - `git merge --abort` / `--continue` / `--quit` — these cannot silently no-op the way a
//     plain `git merge <branch>` can (an abort/continue that "does nothing" fails loudly, it
//     does not leave a stale tree behind reading as merged), so they are excluded even when
//     chained;
//   - a `git merge` run alone, with nothing chained after it in the same command string;
//   - flags on `git` other than `-C <dir>` between `git` and `merge` — matches
//     `wt-check-commit-signatures-hook.mjs`'s own `GIT_COMMIT` shape for the same reason: that
//     is the form these commands are actually written in on this project, and a looser match
//     risks false positives on unrelated `git <verb> ... merge ...` text (e.g. `git log
//     --grep=merge`) it was never meant to catch;
//   - the word "merge" inside a heredoc body, a backtick span, a quoted string, or a shell
//     comment — those are DATA, not commands the shell will run, so they are stripped before
//     matching, same discipline as `wt-unquoted-tool-glob-guard-hook.mjs`.

// Merge warnings are journal-only pending precision measurement: allow would auto-approve
// the call, and permissionDecisionReason reaches no model.
//
// COMMIT CHECK. A gate failed but a commit chained after it still landed in the same shell call.
// Recognized grammar: a preceding gate/commit pair is silent only when EVERY intervening
// separator is && and the gate is not negated. Otherwise warn, without simulating shell status.
// Accepted false positives: set -e; gate; commit, gate || exit 1; commit, status tests after
// gates, if/brace bodies changing options, and gate && echo ok | git commit.
// Delivery is additionalContext, including to subagents; allow+reason would auto-approve the
// command while hiding the reason from the model. This check never grants or denies permission.
// WHAT THIS DOES NOT COVER:
//   - shell aliases/functions wrapping commit; scripts running git commit internally;
//   - bash -c/sh -c strings, eval, xargs; commits inside if/while/for/case bodies;
//   - $(...); unlisted gate heads such as ./run-tests.sh; backslash-newline inside words;
//   - commit commands above 65,536 bytes (merge analysis is unchanged).
// Commit gates exclude package-manager queries/install and curl/wget. Interpreters count only
// script files, not inline code or stdin. A node/python file that is not a gate still warns
// when chained by ;. Examine at most 128 segments; commands beyond that bound are not covered.
// Warn-only until 20 consecutive real chained-commit firings are each confirmed true positives
// by joining the journal record with the transcript command that produced it. One false positive
// resets the count; only then may it deny. This measures precision only; recall is unmeasured.
// Lexer floor: only terminated quotes and certainly terminated heredocs hide data. Uncertain
// quotes/heredocs remain command text; warnings from gate+commit text in such data are accepted
// false positives by design. Arithmetic shifts are not heredoc operators.

import { readFileSync } from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

// Same `-C <dir>` shape wt-check-commit-signatures-hook.mjs already matches for `git commit`/
// `git push` — the form these commands are actually written in here, not a generic `git ...`
// scanner.
// `merge` must be followed by whitespace or end-of-segment, never a bare `\b` — `\b` alone
// also matches the boundary inside `merge-base`/`merge-tree`/`merge-file` (real, unrelated git
// plumbing subcommands), which would misfire on the single most common `merge`-prefixed command
// actually run on this project: `git merge-base --is-ancestor`.
const MERGE_ANCHOR = /^git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+merge(?:\s|$)/
const MERGE_NOOP_SAFE = /^git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+merge\s+--(abort|continue|quit)\b/
const SHELL_ESCAPE = '\\'

// A command line carries CODE and DATA in the same string. A heredoc body, a backtick span, a
// quoted string, and a shell comment are DATA: the shell never runs them as commands, so the
// word "merge" appearing there is prose, not a chained merge. Strip data spans before matching,
// or the guard refuses correct work that merely discusses or documents the trap it exists to
// catch.
// A forward scan records only CERTAIN data spans. An unmatched quote has no span: its
// entire suffix is subsequently treated as unquoted, without retrying every escaped quote.
// The scan runs on demand, left to right, and restarts after a removed heredoc body, so a
// quote inside a body never pairs with a quote after it.
function spanScanner(command) {
  const spans = new Map()
  const state = { pos: 0, stopped: false, escapedTo: -1, noClose: new Map() }
  return {
    get(i) { scanSpansTo(command, i, spans, state); return spans.get(i) },
    has(i) { return this.get(i) !== undefined },
    restart(at) { state.pos = at; state.stopped = false },
    all() { scanSpansTo(command, command.length, spans, state); return spans },
  }
}

function shellDataSpans(command) {
  return spanScanner(command).all()
}

function scanSpansTo(command, target, spans, state) {
  while (!state.stopped && state.pos <= target && state.pos < command.length) {
    const next = nextSpan(command, state.pos, spans, state)
    if (next < 0) state.stopped = true
    else state.pos = next
  }
}

function nextSpan(command, i, spans, state) {
  const char = command[i]
  if (char === SHELL_ESCAPE) { state.escapedTo = i + 2; return i + 2 }
  if (char === '#' && startsComment(command, i, state)) {
    const newline = command.indexOf('\n', i)
    const end = newline < 0 ? command.length : newline
    spans.set(i, { end, char })
    return end
  }
  if (!["'", '"', '`'].includes(char)) return i + 1
  const end = memoQuoteEnd(command, i, state.noClose)
  if (end >= 0) spans.set(i, { end, char })
  return end
}

// `#` opens a comment only at a word start: after unescaped whitespace (`foo\ #bar` is one word).
function startsComment(command, i, state) {
  return i === 0 || (/\s/.test(command[i - 1]) && state.escapedTo !== i)
}

// No closing quote after a failed start means none after any later start of that quote kind,
// so a scan that restarts after a heredoc body never repeats a failed search.
function memoQuoteEnd(command, start, noClose) {
  const quote = command[start]
  if (start >= (noClose.get(quote) ?? Infinity)) return -1
  const end = certainQuoteEnd(command, start)
  if (end < 0) noClose.set(quote, start)
  return end
}

function certainQuoteEnd(command, start) {
  const quote = command[start]
  for (let i = start + 1; i < command.length; i++) {
    if (command[i] === SHELL_ESCAPE && quote !== "'") i++
    else if (command[i] === quote) return i + 1
  }
  return -1
}

function heredocLines(command) {
  const lines = new Map()
  const tabs = new Map()
  for (let start = 0; start < command.length;) {
    const newline = command.indexOf('\n', start)
    const end = newline < 0 ? command.length : newline
    const line = command.slice(start, end)
    for (const [map, key] of [[lines, line], [tabs, line.replace(/^\t+/, '')]]) {
      if (!map.has(key)) map.set(key, [])
      map.get(key).push({ start, end: Math.min(end + 1, command.length) })
    }
    start = end + 1
  }
  return { lines, tabs, cursors: new Map() }
}

function heredocEnd(lines, start, doc) {
  const matches = (doc.tabs ? lines.tabs : lines.lines).get(doc.delimiter) || []
  const key = `${doc.tabs}:${doc.delimiter}`
  let index = lines.cursors.get(key) || 0
  while (index < matches.length && matches[index].start < start) index++
  lines.cursors.set(key, index)
  return matches[index]?.end ?? -1
}

function heredocIntroducer(command, index, spans) {
  if (!command.startsWith('<<', index) || command.startsWith('<<<', index)) return null
  const tabs = command[index + 2] === '-'
  let start = index + (tabs ? 3 : 2)
  while (/[ \t]/.test(command[start] || '\n')) start++
  const end = heredocWordEnd(command, start, spans)
  if (end <= start) return null
  // Bash quote removal: a backslash inside single quotes stays part of the delimiter.
  return { delimiter: shellWords(command.slice(start, end)).join(''), tabs, end }
}

function heredocWordEnd(command, start, spans) {
  let i = start
  while (i < command.length) {
    const char = command[i]
    if (char === SHELL_ESCAPE) { i += 2; continue }
    if (char === "'" || char === '"') {
      const end = spans.get(i)?.end
      if (end === undefined) return start
      i = end
    } else if (/[\s;|&<>]/.test(char)) return i
    else i++
  }
  return command.length
}

function pendingHeredocEnd(lines, start, pending) {
  let end = start
  for (const doc of pending) {
    const next = heredocEnd(lines, end, doc)
    if (next < 0) break // uncertainty never removes this body or subsequent ones
    end = next
  }
  return end
}

function heredocScanSkip(command, i, spans, state) {
  if (spans.has(i)) return spans.get(i).end
  if (command[i] === SHELL_ESCAPE) return i + 2
  if (command.startsWith('((', i)) { state.arithmetic++; return i + 2 }
  if (state.arithmetic && command.startsWith('))', i)) { state.arithmetic--; return i + 2 }
  if (command.startsWith('<<<', i)) return i + 3
  return i
}

// Quotes/comments and arithmetic cannot introduce heredocs. Bodies are removed only after
// the introducing newline and each body's exact terminator are found, in redirection order.
function stripHeredocs(command) {
  const spans = spanScanner(command)
  const lines = heredocLines(command)
  const parts = []
  let pending = []
  let start = 0
  const state = { arithmetic: 0 }
  for (let i = 0; i < command.length;) {
    const skip = heredocScanSkip(command, i, spans, state)
    if (skip > i) { i = skip; continue }
    const doc = state.arithmetic ? null : heredocIntroducer(command, i, spans)
    if (doc) { pending.push(doc); i = doc.end; continue }
    if (command[i++] !== '\n' || pending.length === 0) continue
    const end = pendingHeredocEnd(lines, i, pending)
    pending = []
    if (end === i) continue
    parts.push(command.slice(start, i))
    start = end
    i = end
    spans.restart(end)
  }
  parts.push(command.slice(start))
  return parts.join('')
}

export function stripDataSpans(cmd, preserveQuotes = false) {
  const command = stripHeredocs(cmd)
  const parts = []
  let start = 0
  for (const [index, span] of shellDataSpans(command)) {
    parts.push(command.slice(start, index))
    if (span.char === '`') parts.push('`CODESPAN`')
    else if (span.char !== '#') parts.push(preserveQuotes ? command.slice(index, span.end) : `${span.char}Q${span.char}`)
    start = span.end
  }
  parts.push(command.slice(start))
  return parts.join('')
}

// Split on the shell's own top-level command separators, matching
// wt-check-commit-signatures-hook.mjs's own segment split. `||` is listed alongside the bare
// `|` for readability (a `||` pair matches the single-`|` alternative twice in a row, which
// `.filter(Boolean)` below already collapses to the same result either way).
function splitSegments(cmd) {
  return cmd
    .split(/\n|;|&&|\|\||\|/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

// Bash backslash rules: literal inside single quotes; inside double quotes it escapes only $ ` " \\ newline.
function escapeConsumed(quote, next) {
  if (quote === "'") return false
  return quote !== '"' || /[$`"\\\n]/.test(next ?? '')
}

export function shellWords(segment) {
  const state = { words: [], word: '', quote: null, started: false }
  for (let i = 0; i < segment.length; i++) i = shellWordStep(segment, i, state)
  if (state.started) state.words.push(state.word)
  return state.words
}

// Consume one character (two for a consumed escape) and return the index of the last one read.
function shellWordStep(segment, i, state) {
  const char = segment[i]
  if (char === SHELL_ESCAPE && escapeConsumed(state.quote, segment[i + 1])) {
    state.started = true
    if (i + 1 < segment.length) state.word += segment[i + 1]
    return i + 1
  }
  if (state.quote) {
    if (char === state.quote) state.quote = null
    else state.word += char
  } else if (char === "'" || char === '"') {
    state.quote = char
    state.started = true
  } else if (/\s/.test(char)) {
    if (state.started) state.words.push(state.word)
    state.word = ''
    state.started = false
  } else {
    state.word += char
    state.started = true
  }
  return i
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// Resolve a segment's command word, skipping leading assignments/redirections and common `env`/
// `timeout` prefixes, WITHOUT ever selecting the command's arguments. Returns the index into
// `words` the real command head sits at (never the words themselves, so a caller cannot
// accidentally forward argument text) alongside the parsed word list for a bounded look-ahead
// (e.g. a git subcommand right after `git`).
function resolveCommand(segment) {
  const words = shellWords(segment)
  let i = leadingCommandIndex(words)

  while (i < words.length) {
    const redirect = redirectionWidth(words[i])
    if (redirect) { i += redirect; continue }
    if (words[i] === 'env') {
      i = envCommandIndex(words, i + 1)
      continue
    }
    if (words[i] === 'timeout') {
      i = timeoutCommandIndex(words, i + 1)
      continue
    }
    break
  }
  return { words, index: i }
}

function leadingCommandIndex(words) {
  let i = 0
  while (i < words.length) {
    if (ASSIGNMENT.test(words[i])) { i++; continue }
    const redirect = redirectionWidth(words[i])
    if (!redirect) break
    i += redirect
  }
  return i
}

function envCommandIndex(words, i) {
  while (i < words.length) {
    if (ASSIGNMENT.test(words[i])) i++
    else if (['-u', '--unset', '-C', '--chdir'].includes(words[i])) i += 2
    else if (words[i].startsWith('-')) i++
    else break
  }
  return i
}

function timeoutCommandIndex(words, i) {
  while (i < words.length && words[i].startsWith('-')) {
    if (['-s', '--signal', '-k', '--kill-after'].includes(words[i])) i += 2
    else i++
  }
  if (i < words.length) i++ // duration
  return i
}

function redirectionWidth(word) {
  const match = /^(?:\d*|&)(?:>&|<&|>>?|<<?)(.*)$/.exec(word)
  if (!match) return 0
  return match[1] ? 1 : 2
}

// The closed set a trailing segment's classification is drawn from. Never widen this to carry
// command text — the journal record must survive being read by anyone, on a machine that
// exports real credentials into shell environments, and a trailing segment is arbitrary text.
const TRAILING_CLASS = Object.freeze({ GATE: 'gate', DIAGNOSTIC: 'diagnostic', UNCLASSIFIED: 'unclassified' })

// Heads that TRUST the merge's outcome by acting on the tree — a test/build/publish/push run,
// exactly the shape the guard's header describes as the real hazard.
const GATE_HEADS = new Set([
  'pnpm', 'npm', 'yarn', 'npx', 'make', 'docker', 'cargo', 'go', 'mvn', 'gradle',
  'python', 'python3', 'node', 'bash', 'sh', 'zsh', 'curl', 'wget',
  'tsc', 'vitest', 'jest', 'mocha', 'pytest',
])
const GATE_GIT_SUBCOMMANDS = new Set(['push', 'commit', 'tag', 'publish'])

// Heads that only READ the merge's own outcome — the project's documented safe pattern
// (`git merge x > log 2>&1; echo "merge: $?"; <inspect the log or compare tree hashes>`).
const DIAGNOSTIC_HEADS = new Set(['echo', 'printf', 'cat', 'cut', 'grep', 'test', 'true', 'false', 'wc', 'head', 'tail', 'diff', 'stat', 'ls', 'pwd', '[', '[['])
const DIAGNOSTIC_GIT_SUBCOMMANDS = new Set(['log', 'diff', 'show', 'status', 'rev-parse', 'rev-list', 'merge-base'])

// Classify ONE trailing segment. Returns a TRAILING_CLASS value or null (unrecognized head) —
// never the segment's own words. `git` needs one extra look-ahead (its subcommand) to tell a
// gate (`git push`) from a diagnostic read (`git log`) apart; every other head is decided by
// its own name alone.
function commandBasename(head) {
  return head.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '')
}

function classifySegment(segment) {
  const { words, index } = resolveCommand(segment)
  const head = words[index]
  if (!head) return null
  if (head === 'git') {
    let j = index + 1
    if (words[j] === '-C') j += 2
    const sub = words[j]
    if (sub && GATE_GIT_SUBCOMMANDS.has(sub)) return TRAILING_CLASS.GATE
    if (sub && DIAGNOSTIC_GIT_SUBCOMMANDS.has(sub)) return TRAILING_CLASS.DIAGNOSTIC
    return null
  }
  const base = commandBasename(head)
  if (GATE_HEADS.has(head) || GATE_HEADS.has(base)) return TRAILING_CLASS.GATE
  if (DIAGNOSTIC_HEADS.has(head) || DIAGNOSTIC_HEADS.has(base)) return TRAILING_CLASS.DIAGNOSTIC
  return null
}

// Classify the WHOLE trailing chain as one closed-set value. Any segment that trusts the tree
// (a gate) makes the whole chain a gate, regardless of what else follows — a single blind gate
// among several diagnostic reads is still the hazard the guard exists to catch. Only when
// EVERY segment is a recognized diagnostic read does the chain classify as diagnostic; anything
// the classifier cannot place is UNCLASSIFIED rather than guessed.
function classifyTrailing(segments) {
  if (segments.length === 0) return TRAILING_CLASS.UNCLASSIFIED
  const results = segments.map(classifySegment)
  if (results.some((r) => r === TRAILING_CLASS.GATE)) return TRAILING_CLASS.GATE
  if (results.every((r) => r === TRAILING_CLASS.DIAGNOSTIC)) return TRAILING_CLASS.DIAGNOSTIC
  return TRAILING_CLASS.UNCLASSIFIED
}

// Find a `git merge` (excluding --abort/--continue/--quit) that is followed by at least one
// more real command in the SAME invocation. A merge preceded by other commands is fine —
// nothing runs after it here to certify a stale tree.
function findChainedMerge(segments) {
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]
    if (MERGE_NOOP_SAFE.test(segment)) continue
    if (MERGE_ANCHOR.test(segment)) return { segment, index: i }
  }
  return null
}

const COMMIT_PREFIX = /^(?:[({!]\s*|(?:then|else|elif|do|if|while|until|time)\s+)/
const COMPOUND_BODY = /^(?:then|else|elif|do)(?:\s|$)/
const SEPARATOR_CLASS = Object.freeze({ ';': 'semicolon', '\n': 'newline', '||': 'or', '|': 'pipe', '|&': 'pipe', '&': 'background' })
const COMMIT_SEGMENT_LIMIT = 128
const COMMIT_BYTE_LIMIT = 65_536
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--exec-path', '--attr-source'])
const PACKAGE_HEADS = new Set(['pnpm', 'npm', 'yarn', 'bun'])
const PACKAGE_QUERIES = new Set(['--version', '-v', 'install', 'i', 'ci', 'add', 'remove', 'rm', 'view', 'info', 'ls', 'list', 'why', 'outdated', 'config', 'store', 'root', 'bin', 'help', 'init', 'link', 'unlink'])
const PACKAGE_VALUE_OPTIONS = new Set(['--dir', '-C', '--filter', '--prefix'])
const INTERPRETERS = new Set(['node', 'python', 'python3', 'bash', 'sh', 'zsh'])

function isCommitSeparator(command, match, separator) {
  if (separator === '&' && /[<>]/.test(command[match.index - 1] + command[match.index + 1])) return false
  return Object.hasOwn(SEPARATOR_CLASS, separator) || separator === '&&'
}

function splitCommitSegments(command) {
  const tokens = /\\[\s\S]|['"`]|[;\n]|&&|\|[&|]?|&/g
  const spans = shellDataSpans(command)
  const segments = []
  let start = 0
  for (let match = tokens.exec(command); match && segments.length < COMMIT_SEGMENT_LIMIT; match = tokens.exec(command)) {
    const separator = match[0]
    const span = spans.get(match.index)
    if (span) { tokens.lastIndex = span.end; continue }
    if (!isCommitSeparator(command, match, separator)) continue
    const text = command.slice(start, match.index).trim()
    if (text) segments.push({ text, separator })
    else if (separator === ';' && segments.length) segments.at(-1).separator = separator
    start = tokens.lastIndex
  }
  if (segments.length < COMMIT_SEGMENT_LIMIT && command.slice(start).trim()) segments.push({ text: command.slice(start).trim(), separator: '' })
  return segments
}

function resolveCommitCommand(segment) {
  let text = segment
  let negated = false
  while (COMMIT_PREFIX.test(text)) {
    if (text.startsWith('!')) negated = true
    text = text.replace(COMMIT_PREFIX, '').trimStart()
  }
  text = text.replace(/^command\s+(?:(?:-p|--)\s+)*/, '')
  const resolved = resolveCommand(text)
  return { ...resolved, head: resolved.words[resolved.index], negated }
}

function isCommit({ words, index, head }) {
  if (!head || commandBasename(head) !== 'git') return false
  let i = index + 1
  while (i < words.length) {
    if (GIT_VALUE_OPTIONS.has(words[i])) i += 2
    else if (/^--[\w-]+(?:=.*)?$/.test(words[i]) || ['-P', '-p'].includes(words[i])) i++
    else return words[i] === 'commit'
  }
  return false
}

function packageGate(words) {
  let i = 0
  while (words[i]?.startsWith('-')) {
    if (PACKAGE_QUERIES.has(words[i])) return false
    i += PACKAGE_VALUE_OPTIONS.has(words[i]) ? 2 : 1
  }
  return words[i] && !PACKAGE_QUERIES.has(words[i])
}

function scriptGate(words) {
  for (const word of words) {
    if (/^(?:-[epc]|--(?:eval|print)(?:=|$))/.test(word) || word === '-') return false
    if (!word.startsWith('-')) return !/^[<>\d]*[<>]/.test(word)
  }
  return false
}

function commitGate(resolved) {
  const base = resolved.head ? commandBasename(resolved.head) : undefined
  const args = resolved.words.slice(resolved.index + 1)
  if (PACKAGE_HEADS.has(base)) return packageGate(args) ? base : null
  if (INTERPRETERS.has(base)) return scriptGate(args) ? base : null
  return GATE_HEADS.has(base) && !['curl', 'wget'].includes(base) ? base : null
}

function describeCommitSegments(command) {
  return splitCommitSegments(command).map((segment) => {
    const resolved = resolveCommitCommand(segment.text)
    return { ...segment, ...resolved, gate: commitGate(resolved) }
  })
}

function unprotectedGate(segments, gate, commit) {
  if (segments[gate].negated) return { separator: 'negated', gate: segments[gate].gate }
  for (let i = gate; i < commit; i++) {
    if (segments[i].separator !== '&&') return { separator: SEPARATOR_CLASS[segments[i].separator], gate: segments[gate].gate }
  }
  return null
}

function findChainedCommit(command) {
  const segments = describeCommitSegments(command)
  for (let c = 0; c < segments.length; c++) {
    if (!isCommit(segments[c]) || COMPOUND_BODY.test(segments[c].text)) continue
    for (let g = 0; g < c; g++) {
      if (!segments[g].gate) continue
      const hazard = unprotectedGate(segments, g, c)
      if (hazard) return hazard
    }
  }
  return null
}

function noticeChainedCommit(input, raw) {
  if (Buffer.byteLength(raw, 'utf8') > COMMIT_BYTE_LIMIT) return
  const hazard = findChainedCommit(stripDataSpans(raw, true))
  if (!hazard) return
  recordGuardEvent({
    guard: 'wt-merge-chain-guard-hook.mjs', decision: 'warned', class: 'chained-commit',
    session: input.session_id, agent: input.agent_id, evidence: hazard,
  })
  emitGuardNotice({
    // Hazard notices reach the triggering agent, including subagents, by default.
    payload: input,
    stdoutJson: { hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: '[workflow-toolbox commit-chain guard] WARNING (not blocked): ' +
        `a git commit runs after a gate (${hazard.gate}) whose failure does not stop it (${hazard.separator}). ` +
        'A red gate then still commits. Run the gate alone, read its exit code, then commit, or chain with &&.',
    } },
  })
}

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Bash') return

  const raw = input.tool_input && typeof input.tool_input.command === 'string'
    ? input.tool_input.command
    : ''
  if (!raw) return

  const segments = splitSegments(stripDataSpans(raw))
  const found = findChainedMerge(segments)
  if (!found) return noticeChainedCommit(input, raw)
  // Classification only — the trailing segment's own text NEVER reaches the journal. See
  // classifyTrailing()'s header: the return value is always one of TRAILING_CLASS's three
  // members, never anything derived from the segment strings themselves.
  const trailing = classifyTrailing(segments.slice(found.index + 1))

  recordGuardEvent({
    guard: 'wt-merge-chain-guard-hook.mjs',
    decision: trailing === TRAILING_CLASS.DIAGNOSTIC ? 'silent' : 'warned',
    class: 'chained-merge',
    // No `reason`: the merge segment is raw command text (branch names, paths, anything the
    // caller typed). The classification below is the whole record.
    session: input.session_id,
    agent: input.agent_id,
    evidence: { trailing },
  })
  noticeChainedCommit(input, raw)
}

if (isInvokedDirectly(import.meta.url)) runFailOpenHook('wt-merge-chain-guard-hook.mjs', main)
