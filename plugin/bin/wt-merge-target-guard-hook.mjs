#!/usr/bin/env node
// wt-merge-target-guard-hook.mjs - a PreToolUse guard, plugin-level: WARNS (never blocks) when
// `git merge` is followed by two or more non-flag arguments. Git merges every named commit INTO
// the currently checked-out branch; it has no "merge into" argument. A command written as
// `git merge <source> <target>` can therefore advance HEAD with both refs instead of advancing
// the branch the caller intended to name as the target.
//
// Shell words are tokenised with quotes preserved as one argument. Option values such as the words
// in `git merge -m 'merge: card X into develop' <branch>` are skipped, while quoted refs still count.
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
//   - shell expansions or wrappers whose eventual arguments are not visible in the command text.
//   - intentional octopus merges: this warning-only guard cannot distinguish them from a mistaken
//     source/target spelling, so that false positive is accepted rather than weakening the warning.

import { readFileSync } from 'node:fs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { emitGuardNotice, recordGuardEvent } from './lib/guard-journal.mjs'

const GUARD = 'wt-merge-target-guard-hook.mjs'
const MERGE_STATE_OPERATION = /^--(?:abort|continue|quit)$/
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path'])
const OPTIONS_WITH_VALUE = new Set(['-m', '--message', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--into-name', '--cleanup', '--log', '--gpg-sign'])

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

function withoutHeredocBodies(command) {
  const output = []
  let delimiter = null
  for (const line of command.split(/\r?\n/)) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null
      continue
    }
    output.push(line)
    const match = line.match(/<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/)
    if (match) delimiter = match[2]
  }
  return output.join('\n')
}

function splitSegments(command) {
  const segments = []
  let current = ''; let quote = null
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote) {
      current += char
      if (char === quote && command[index - 1] !== '\\') quote = null
      continue
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue }
    if (char === '\n' || char === ';' || char === '|') {
      if (current.trim()) segments.push(current.trim())
      current = ''
      if (char === '|' && command[index + 1] === '|') index++
      continue
    }
    if (char === '&' && command[index + 1] === '&') {
      if (current.trim()) segments.push(current.trim())
      current = ''; index++; continue
    }
    current += char
  }
  if (current.trim()) segments.push(current.trim())
  return segments
}

function shellWords(segment) {
  const words = []
  let current = ''; let quote = null
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && index + 1 < segment.length) current += segment[++index]
      else current += char
    } else if (char === "'" || char === '"') quote = char
    else if (/\s/.test(char)) { if (current) { words.push(current); current = '' } }
    else if (char === '\\' && index + 1 < segment.length) current += segment[++index]
    else current += char
  }
  if (current) words.push(current)
  return words
}

function hasMultipleRefs(segment) {
  const command = shellWords(segment)
  if (command[0] !== 'git') return false
  let subcommand = 1
  while (subcommand < command.length && command[subcommand] !== 'merge') {
    const option = command[subcommand]
    if (!option.startsWith('-')) return false
    if (GIT_OPTIONS_WITH_VALUE.has(option)) subcommand++
    subcommand++
  }
  if (command[subcommand] !== 'merge') return false
  const words = command.slice(subcommand + 1)
  if (words.some((word) => MERGE_STATE_OPERATION.test(word))) return false
  let refs = 0
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
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

  const found = splitSegments(withoutHeredocBodies(command)).some(hasMultipleRefs)
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
