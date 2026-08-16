#!/usr/bin/env node
// wt-prior-art-launch-guard-hook.mjs — a PreToolUse guard on Bash: when a command is about to
// LAUNCH a workflow run (`wt-observe … launch`, or a `curl` against `/api/pipeline` /
// `/api/scripted-run`), print the titles of any board cards whose name looks related, before
// the run starts.
//
// WHY THIS EXISTS. A session spent an evening re-running a fully-scripted pipeline experiment and
// re-deriving three environment traps from scratch, hours after a board card already describing
// that exact experiment — and naming all three traps — had been written. A memory note saying
// "search the board first" already existed and was not read. A note is recall-on-demand: it is
// read only by someone who already suspects the problem. This guard does not rely on that — it
// fires at the MOMENT of the act (launching a run), unasked, from a file a producer hook already
// wrote from an earlier board read.
//
// ⚠ WARNS, NEVER DENIES — its false-positive rate has not been measured. A launch matching a
// keyword substring is not proof the card describes the SAME work; the reader judges.
//
// ⚠ WHAT IT DOES NOT COVER, so its silence is not read as coverage:
//   - it fires on LAUNCH COMMANDS ONLY — exploratory work that reads the board, plans, or writes
//     code but never launches a run reaches this guard not at all;
//   - its index is only as fresh as the LAST board read in SOME session (the producer hook
//     wt-actionable-snapshot-producer-hook.mjs writes it, reactively, off a get_board/find_cards
//     call) — a card created after that read is invisible until the board is read again;
//   - it matches on CARD TITLE substrings only, never description or comments — a related card
//     with an unrelated-sounding title will not surface here;
//   - a card in `Done` can still hold unmet criteria (a partial delivery, a deferred follow-up) —
//     the guard does not distinguish Done from any other list, by design: dismissing a match
//     because it is "already Done" is exactly the judgment the guard exists to interrupt.
//
// ⚠ TWO DISTINCT SILENCES, PRINTED DIFFERENTLY — the whole point of this mechanism. "No board
// read has ever happened for this project" (no index file on disk) and "a board read happened,
// nothing in it matched" are different facts and must never render as the same message: a guard
// whose two silences look identical is the exact defect this mechanism exists to close (see the
// index-file case in the memory note this card responds to).

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { recordGuardEvent } from './lib/guard-journal.mjs'
import { stateRoot, cardIndexPath } from './lib/prior-art-state-paths.mjs'
import { matchLaunchCommand, deriveKeywords, matchCards, MAX_MATCHES } from './lib/prior-art-launch-guard-core.mjs'

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8')) || {}
  } catch {
    return {}
  }
}

function readIndex(cwd) {
  const path = cardIndexPath(stateRoot(), cwd)
  if (!existsSync(path)) return { present: false, index: null }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || !Array.isArray(parsed.cards)) return { present: false, index: null }
    return { present: true, index: parsed }
  } catch {
    // A corrupt/unreadable index reads the same as "no index" — never fabricate cards from it.
    return { present: false, index: null }
  }
}

function formatMatches(matches) {
  return matches
    .map((c) => `#${c.id} — ${c.name} [${c.listName}]`)
    .join('\n  ')
}

function main() {
  const input = readInput()
  if (input.hook_event_name !== 'PreToolUse') return
  if (input.tool_name !== 'Bash') return

  const cmd = input.tool_input && typeof input.tool_input.command === 'string'
    ? input.tool_input.command
    : ''
  if (!cmd) return
  if (!matchLaunchCommand(cmd)) return // not a launch command — stays silent, no distinction to make

  const cwd = typeof input.cwd === 'string' && input.cwd ? resolve(input.cwd) : ''
  const keywords = deriveKeywords(cmd)

  let body
  let matchedCount = 0
  if (!cwd) {
    body = 'no project cwd on this call — cannot resolve a card-title index.'
  } else {
    const { present, index } = readIndex(cwd)
    if (!present) {
      body =
        `no index on disk for this project — no board read (get_board / find_cards) has been ` +
        `observed in any session yet, so prior-art titles are unavailable for this launch.`
    } else {
      const matches = matchCards(index.cards, keywords).slice(0, MAX_MATCHES)
      matchedCount = matches.length
      if (matches.length === 0) {
        body =
          `index present (${index.scanned} card${index.scanned === 1 ? '' : 's'} scanned at ` +
          `${new Date(index.at).toISOString()}), no title matched keywords [${keywords.join(', ') || 'none derived'}].`
      } else {
        body = `possible prior art:\n  ${formatMatches(matches)}`
      }
    }
  }

  recordGuardEvent({
    guard: 'wt-prior-art-launch-guard-hook.mjs',
    decision: 'warned',
    class: matchedCount > 0 ? 'matched' : 'no-match-or-no-index',
  })

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        `⚠ [workflow-toolbox prior-art guard] About to LAUNCH a run. ${body} ` +
        `Read a candidate before assuming this is new work: get_card on its id — a card in ` +
        `Done can still hold unmet criteria.`,
    },
  }
  process.stdout.write(JSON.stringify(payload))
}

runFailOpenHook('wt-prior-art-launch-guard-hook.mjs', main)
