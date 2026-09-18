#!/usr/bin/env node
// wt-merge-target-guard-hook.mjs - a PreToolUse guard, plugin-level: WARNS (never blocks) when
// `git merge` is followed by two or more non-flag arguments. Git merges every named commit INTO
// the currently checked-out branch; it has no "merge into" argument. A command written as
// `git merge <source> <target>` can therefore advance HEAD with both refs instead of advancing
// the branch the caller intended to name as the target.
//
// Quoted strings are blanked before the merge arguments are tokenised. In particular, the words
// in `git merge -m 'merge: card X into develop' <branch>` are message data, not refs. Without
// blanking, that common correct command is indistinguishable from a many-ref merge and this guard
// would warn on routine work.
//
// `merge` is matched as the exact git subcommand, not with `\bmerge\b`: a word boundary also
// exists before the hyphen in `merge-base`, `merge-tree`, `merge-file`, and `merge-index`.
//
// SHAPE 2 IS DELIBERATELY NOT SHIPPED HERE. Warning whenever a checkout is on main, master, or
// release would fire on every legitimate merge in projects whose daily development branch is one
// of those names. That shape needs a project-configurable protected-branch list; an unconfigurable
// plugin-level version would create enough false positives to train users to ignore the guard.
//
// WHAT THIS DOES NOT COVER:
//   - whether the current checkout is a protected branch (shape 2, described above);
//   - refs supplied inside quoted strings, because quoted strings are deliberately treated as
//     indivisible data to avoid interpreting commit-message words as refs;
//   - shell expansions or wrappers whose eventual arguments are not visible in the command text.

import { readFileSync } from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'

const GUARD = 'wt-merge-target-guard-hook.mjs'
const MERGE_ANCHOR = /^git(?:\s+-C\s+(?:""|\S+))?\s+merge(?:\s|$)/
const MERGE_STATE_OPERATION = /^--(?:abort|continue|quit)$/
const OPTIONS_WITH_VALUE = new Set(['-m', '--message', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--into-name'])

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

function blankQuotedStrings(command) {
  return command.replace(/'[^']*'|"[^"]*"/g, '""')
}

function splitSegments(command) {
  return command
    .split(/\n|;|&&|\|\||\|/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function hasMultipleRefs(segment) {
  const match = segment.match(MERGE_ANCHOR)
  if (!match) return false

  const words = segment.slice(match[0].length).trim().split(/\s+/).filter(Boolean)
  if (words.some((word) => MERGE_STATE_OPERATION.test(word))) return false
  let refs = 0
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (word === '""') continue
    if (/^\d*(?:>>?|<<?)$/.test(word)) {
      i++
      continue
    }
    if (/^\d*(?:>>?|<<).+/.test(word) || /^\d*>&\d+$/.test(word)) continue
    if (word === '--') continue
    if (word.startsWith('-')) {
      if (OPTIONS_WITH_VALUE.has(word)) i++
      continue
    }
    refs++
    if (refs >= 2) return true
  }
  return false
}

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') return
  const command = input.tool_input && typeof input.tool_input.command === 'string'
    ? input.tool_input.command
    : ''
  if (!command) return

  const found = splitSegments(blankQuotedStrings(command)).some(hasMultipleRefs)
  if (!found) return

  recordGuardEvent({
    guard: GUARD,
    decision: 'warned',
    class: 'multi-ref-merge',
    session: input.session_id,
    agent: input.agent_id,
    evidence: { refs: 'multiple' },
  })
  emitGuardNotice({
    payload: input,
    stdoutJson: {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          '[workflow-toolbox merge-target guard] WARNING (not blocked): this `git merge` names ' +
          'two or more non-flag refs. Git merges every named ref INTO the currently checked-out ' +
          'branch; the final ref is not a target branch. Confirm HEAD is the branch you intend to ' +
          'advance, then run the merge with only the source ref(s).',
      },
    },
  })
}

runFailOpenHook(GUARD, main)
