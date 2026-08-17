#!/usr/bin/env node
// wt-guard-recurrence-hook.mjs — SessionStart surface that turns a guard's recorded firing
// COUNT into something a session meets without asking for it: crossing a threshold surfaces the
// count itself, not a reminder to reflect. plugin/rules/wt-durable-fix-at-the-right-level.md
// names the threshold as a COUNT: "same guard fired for the same reason more than twice in one
// week → mechanise what it guards, or fix the guard." Before this hook, that threshold lived
// only in wt-guard-journal-scan.mjs, a CLI nothing invoked — a counter nobody reads is not a
// trigger.
//
// STRUCTURAL DECISION (fixed by the brief): SessionStart, reusing the existing journal parser
// (plugin/bin/lib/guard-journal-read.mjs) rather than a second implementation of it.
//
// SHAPES CONSIDERED for "reach a session unasked":
//   1. THIS ONE — SessionStart additionalContext, read-only, silent below threshold. Matches the
//      existing wt-env-prerequisite-drift-hook.mjs / wt-delegation-ladder-hook.mjs pattern
//      already in this plugin: a warning light, not a gate, silent on the common path.
//   2. A PostToolUse hook on every guard's own tool matcher, firing right after a guard blocks —
//      catches the threshold at the moment it's crossed instead of at the next session start.
//      Rejected: it would need wiring into 16 separate matchers (one per guard's own PreToolUse
//      registration), multiplying the registration surface for a signal that is not time-
//      critical — "more than twice in a week" tolerates a session-start delay by construction.
//   3. A Stop hook, mirroring wt-actionable-gate-hook.mjs's model of reporting at end-of-turn.
//      Rejected: SessionStart is the point at which a session's shape is decided, and the card's
//      own wording ("surfaces the count itself") reads as ambient orientation, not a closing
//      audit — the same reasoning behind wt-delegation-ladder-hook.mjs choosing SessionStart.
// (1) is the brief's fixed choice; (2) and (3) are recorded here for the next reader who wonders
// why this file lives where it does.
//
// GROUPING DECISION for "the same reason" (the rule's own wording): group by (guard, class) when
// a record carries a `class` (the guard's own classification of what it matched — the closest
// thing this journal has to "the reason"); group every UNCLASSED firing of one guard into a
// SINGLE bucket for that guard. COST, stated rather than left implicit: a guard that never sets
// `class` gets one shared bucket for every reason it fires for, so two genuinely different
// defects caught by the same unclassed guard can cross the threshold together and read as one
// recurring class when they are two separate ones. The alternative — grouping by a normalized
// `reason` free-text string — was rejected: `reason` is free text (see guard-journal.mjs's own
// doc comment), and matching on it would need fuzzy normalization that is itself a source of
// silent mis-grouping (two near-identical sentences either wrongly merge, or wrongly split) — a
// class-or-guard bucket is coarser but never silently wrong in that particular way.
//
// INVARIANTS THIS HOOK MUST HOLD (mechanically tested — see the sibling .test.ts):
//   - SILENT on the happy path — no guard crossed the threshold this week. Noise here gets the
//     surface switched off, taking its real case with it (the same "unmeasured guard" caution
//     wt-durable-fix-at-the-right-level.md states for a REFUSING guard, applied here to a
//     SPEAKING one).
//   - Speaks ONLY the count and the guard/class name, never an instruction to "reflect" — the
//     card's own wording, verbatim.
//   - BOTH bounds travel with the number whenever it is shown: an event count is not a
//     confirmed-defect count, and only guards wired to the journal are counted at all.
//   - Cannot break a session: a missing directory, an unreadable directory, a malformed line, or
//     an unrecognised/future-version record shape each degrade to SILENCE — never a thrown
//     error, and never an interruption either way. readGuardJournal() already fails open for
//     every one of those; runFailOpenHook() below is the last-resort backstop for anything this
//     file itself might still throw (e.g. a future edit to buildMessage()).
//
// This hook does not read the SessionStart payload at all — the journal's location does not
// depend on the project (it is a single machine-wide directory), so there is nothing on stdin
// this hook needs. It still runs under runFailOpenHook so a broken entry path leaves a trace
// instead of looking healthy-quiet, matching every other hook in this plugin.

import { readGuardJournal } from './lib/guard-journal-read.mjs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'

// "more than twice in one week" (wt-durable-fix-at-the-right-level.md) = 3 or more firings.
const RECURRENCE_THRESHOLD = 3
const UNCLASSED_LABEL = '(unclassed)'

/**
 * Build the recurrence list from a readGuardJournal() result, applying the (guard,class) /
 * (guard,unclassed) grouping documented above. Not exported: this repo's hook tests drive the
 * REAL hook as a child process (see the sibling .test.ts) rather than importing hook modules —
 * an import would execute this file's top-level runFailOpenHook(main) call as a side effect,
 * including a stdin read, which is exactly the ambiguity black-box spawning avoids.
 * @returns {Array<{guard:string, label:string, count:number}>} sorted by count, descending.
 */
function recurringGroups(result) {
  if (!result || result.ok !== true) return []
  const groups = []
  for (const row of result.rows) {
    for (const [cls, count] of Object.entries(row.classes)) {
      if (count >= RECURRENCE_THRESHOLD) groups.push({ guard: row.guard, label: cls, count })
    }
    if (row.unclassedTotal >= RECURRENCE_THRESHOLD) {
      groups.push({ guard: row.guard, label: UNCLASSED_LABEL, count: row.unclassedTotal })
    }
  }
  return groups.sort((a, b) => b.count - a.count)
}

function buildMessage(result, groups) {
  const lines = [
    `[wt] guard recurrence this week — ${RECURRENCE_THRESHOLD}+ firings is the mechanise/fix-` +
      `the-guard trigger, not a reminder to reflect:`,
  ]
  for (const g of groups) {
    lines.push(`  ${g.guard} [${g.label}] — ${g.count} firings this week`)
  }
  lines.push(
    '⚠ Event count, not a confirmed-defect count: some guards include bounded evidence that ' +
      'lets a reader classify a firing, but this summary does not — read the records before acting. ' +
      'Only guards wired to this journal appear here; a defect with no guard is invisible by ' +
      'construction, never evidence nothing went wrong.',
  )
  lines.push(`Full picture: node <plugin>/bin/wt-guard-journal-scan.mjs --weeks 1 (baseDir: ${result.baseDir})`)
  return lines.join('\n')
}

function main() {
  const result = readGuardJournal({ weeks: 1 })
  if (!result.ok) return // missing/unreadable journal degrades to silence — never an error
  const groups = recurringGroups(result)
  if (groups.length === 0) return // steady state: nothing crossed the threshold, say nothing

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildMessage(result, groups),
      },
    }),
  )
}

runFailOpenHook('wt-guard-recurrence-hook.mjs', main)
