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
// ⚠ WARNS, NEVER DENIES — a new guard's precision is measured on material it did not choose
// before it is allowed to block (mechanise-on-sight.md). This one reasons about a shell string
// via regex, which cannot perfectly parse quoting; a false positive on a benign already-escaped
// backtick would just be a nag, never a lost commit, so warn-only is the correct posture until
// its false-positive rate is measured on real usage.
//
// ⚠ WHAT IT DOES NOT COVER, so its silence is not read as coverage:
//   - single-quoted -m arguments (no substitution risk — deliberately silent);
//   - the heredoc / `-F` form (the documented safe form — deliberately silent);
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
import { recordGuardEvent } from './lib/guard-journal.mjs'

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

// Matches -m "..."  or --message "..." with a DOUBLE-quoted argument, non-greedy up to the next
// unescaped closing quote.
const DQUOTE_MESSAGE_ARG = /(?:-m|--message)\s+"((?:[^"\\]|\\.)*)"/g

function hasUnescapedBacktick(content) {
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '`' && content[i - 1] !== '\\') return true
  }
  return false
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

  let flagged = null
  for (const m of scanned.matchAll(DQUOTE_MESSAGE_ARG)) {
    if (hasUnescapedBacktick(m[1])) {
      flagged = m[1]
      break
    }
  }
  if (!flagged) return

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        '⚠ [workflow-toolbox git-commit backtick guard] A double-quoted git -m/--message ' +
        'argument contains an unescaped backtick — inside double quotes that IS command ' +
        'substitution: the shell will run whatever follows it and splice its output (often ' +
        'nothing) into the message, with no error. Measured: a word silently vanished from a ' +
        "real commit message this way. Safe forms: a heredoc (`git commit -F - <<'MSG' ... " +
        'MSG`), single quotes, or an escaped backtick (`\\``).',
    },
  }
  recordGuardEvent({
    guard: 'wt-git-commit-backtick-guard-hook.mjs',
    decision: 'warned',
    class: 'unescaped-backtick',
    reason: flagged,
  })
  process.stdout.write(JSON.stringify(payload))
}

runFailOpenHook('wt-git-commit-backtick-guard-hook.mjs', main)
