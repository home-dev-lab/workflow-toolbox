#!/usr/bin/env node
// wt-merge-chain-guard-hook.mjs — a PreToolUse guard, plugin-level: WARNS (never blocks) on a
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
// ⚠ WHY THIS SHIPS WARN-ONLY, NOT BLOCKING — measured, not a default caution. The predicate is
// "any command follows a `git merge` in the same invocation", which is what the hazard actually
// is. Measured against this project's own history before shipping: 1,140 distinct real `git
// merge`-containing Bash commands, replayed against this guard's own executable as PreToolUse
// payloads — 376 matched. Reading them: the overwhelming majority are NOT the blind-chain
// hazard — they are the project's own established careful pattern, `git merge x > log 2>&1;
// echo "merge: $?"; <inspect the log or compare tree hashes>`, which THIS guard's predicate
// cannot distinguish from a blind chained gate without a much larger, more fragile analysis of
// what the trailing commands actually do with the captured result. A conservative verb-based
// re-classification of the same 376 still found roughly three quarters with no recognizable
// downstream gate command (test/build/publish/push) in the chained tail. Blocking that volume
// of correct, careful work is exactly the false-positive shape that gets a guard switched off,
// taking its real cases with it (`wt-unquoted-tool-glob-guard-hook.mjs`'s own header explains
// the bar this guard did not clear: 0 false positives on unchosen material before shipping
// blocking). This one warns until a narrower predicate — one that can tell "diagnostic read of
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

// Same `-C <dir>` shape wt-check-commit-signatures-hook.mjs already matches for `git commit`/
// `git push` — the form these commands are actually written in here, not a generic `git ...`
// scanner.
// `merge` must be followed by whitespace or end-of-segment, never a bare `\b` — `\b` alone
// also matches the boundary inside `merge-base`/`merge-tree`/`merge-file` (real, unrelated git
// plumbing subcommands), which would misfire on the single most common `merge`-prefixed command
// actually run on this project: `git merge-base --is-ancestor`.
const MERGE_ANCHOR = /^git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+merge(?:\s|$)/
const MERGE_NOOP_SAFE = /^git(?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+))?\s+merge\s+--(abort|continue|quit)\b/

// A command line carries CODE and DATA in the same string. A heredoc body, a backtick span, a
// quoted string, and a shell comment are DATA: the shell never runs them as commands, so the
// word "merge" appearing there is prose, not a chained merge. Strip data spans before matching,
// or the guard refuses correct work that merely discusses or documents the trap it exists to
// catch.
function stripDataSpans(cmd) {
  let out = cmd
  // Heredoc bodies: <<'TAG' ... TAG  /  <<TAG ... TAG  (quoted or bare, optional -)
  out = out.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\2$/gm, '<<HEREDOC')
  // Unterminated heredoc (the tag never closes inside this command): drop the tail.
  out = out.replace(/<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1[\s\S]*$/, '<<HEREDOC')
  // Markdown/backtick spans — prose quoting a command rather than running it.
  out = out.replace(/`[^`]*`/g, '`CODESPAN`')
  // QUOTED spans, single and double — content inside is never split by the shell as a separate
  // command, whether it is a real argument or an example string.
  out = out.replace(/'[^']*'/g, "'Q'").replace(/"[^"]*"/g, '"Q"')
  // Shell comments: `#` at the start of a word runs to end of line. Safe to strip only AFTER
  // quotes are gone — a `#` still inside a quoted span at this point does not exist anymore.
  out = out.replace(/(^|\s)#.*$/gm, '$1')
  return out
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

// Preserve quoted executable paths while splitting only on unquoted shell separators. This is
// used for evidence only; the stricter DATA-stripped representation above remains the predicate.
function splitEvidenceSegments(cmd) {
  const source = cmd
    .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\2$/gm, '<<HEREDOC')
    .replace(/<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1[\s\S]*$/, '<<HEREDOC')
    .replace(/`[^`]*`/g, '`CODESPAN`')
  const segments = []
  let segment = ''
  let quote = null

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '\\' && quote !== "'") {
      segment += char
      if (i + 1 < source.length) segment += source[++i]
      continue
    }
    if (quote) {
      segment += char
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      segment += char
      continue
    }
    if (char === '#' && (i === 0 || /\s/.test(source[i - 1]))) {
      while (i + 1 < source.length && source[i + 1] !== '\n') i++
      continue
    }
    if (char === '\n' || char === ';' || char === '|' || (char === '&' && source[i + 1] === '&')) {
      if (segment.trim()) segments.push(segment.trim())
      segment = ''
      if ((char === '|' && source[i + 1] === '|') || (char === '&' && source[i + 1] === '&')) i++
      continue
    }
    segment += char
  }
  if (segment.trim()) segments.push(segment.trim())
  return segments
}

function shellWords(segment) {
  const words = []
  let word = ''
  let quote = null
  let started = false
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]
    if (char === '\\' && quote !== "'") {
      started = true
      if (i + 1 < segment.length) word += segment[++i]
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else word += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (started) words.push(word)
  return words
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function commandHead(segment) {
  const words = shellWords(segment)
  let i = 0
  while (i < words.length && ASSIGNMENT.test(words[i])) i++

  // Resolve common command prefixes without ever selecting the command's arguments.
  while (i < words.length) {
    if (words[i] === 'env') {
      i++
      while (i < words.length) {
        if (ASSIGNMENT.test(words[i])) i++
        else if (['-u', '--unset', '-C', '--chdir'].includes(words[i])) i += 2
        else if (words[i].startsWith('-')) i++
        else break
      }
      continue
    }
    if (words[i] === 'timeout') {
      i++
      while (i < words.length && words[i].startsWith('-')) {
        if (['-s', '--signal', '-k', '--kill-after'].includes(words[i])) i += 2
        else i++
      }
      if (i < words.length) i++ // duration
      continue
    }
    break
  }
  return words[i] || null
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
  if (!found) return
  const after = splitEvidenceSegments(raw)
    .slice(found.index + 1)
    .map(commandHead)
    .filter(Boolean)
    .join(',')

  recordGuardEvent({
    guard: 'wt-merge-chain-guard-hook.mjs',
    decision: 'warned',
    class: 'chained-merge',
    reason: found.segment,
    session: input.session_id,
    evidence: after ? { after } : undefined,
  })
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          '[workflow-toolbox merge-chain guard] WARNING (not blocked): a `git merge` is ' +
          `chained with what runs after it (\`${found.segment}\`). A merge can do NOTHING — ` +
          '"Already up to date" from the wrong tree, or an abort on a non-fast-forwardable ' +
          'branch — and the chained commands then run on the UNMERGED tree and return exit 0, ' +
          'certifying a subject nobody intended to certify. If what follows is a GATE that ' +
          'trusts the merge succeeded (a test/build/publish/push run), run the merge ALONE, ' +
          'read its result, and only THEN run the gate in a separate command. If what follows ' +
          "only reads the merge's own captured exit code or log, this is expected and safe — " +
          'this guard cannot yet tell the two apart, so it warns rather than refuses.',
      },
    }),
  )
}

runFailOpenHook('wt-merge-chain-guard-hook.mjs', main)
