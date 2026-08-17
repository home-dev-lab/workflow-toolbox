#!/usr/bin/env node
// wt-guard-journal-scan.mjs — the READ side of guard-journal.mjs. Reports, per guard, how many
// times it BLOCKED or WARNED this week (or over a chosen window), so "has this recurred" has a
// number instead of an impression.
//
// WHAT THIS CANNOT TELL YOU, stated up front because it is the whole reason this script prints
// a caveat rather than a bare table:
//   - This journal counts EVENTS, not confirmed defects. A guard may include bounded `evidence`
//     that makes its own real-catch/false-positive distinction inspectable, but the scanner does
//     not classify that evidence — a rising count is never proof that N real mistakes happened.
//   - Only guards that HAVE a journal call show up here at all. A defect with no guard watching
//     it is invisible by construction — this mechanises recidivism (a KNOWN check firing
//     again), never inauguration (a brand-new class of mistake nobody has written a check for
//     yet). Silence in this report is not evidence nothing went wrong.
//   - Two of the eighteen `plugin/bin/*guard*.mjs` files are deliberately NOT wired to this
//     journal: `wt-outbound-guard-hook.mjs` already keeps its own durable registry for a
//     different question (spawn accounting, read via wt-spawn-registry-scan.mjs) and
//     `wt-stale-date-guard.mjs` is a report-generating CLI, not a PreToolUse/PostToolUse hook
//     that decides block/warn on a tool call.
//
// PARSING lives in plugin/bin/lib/guard-journal-read.mjs — shared with the SessionStart
// recurrence surface (wt-guard-recurrence-hook.mjs) so the two readers can never disagree about
// what a record means. This file is presentation only.
//
// Usage:
//   node wt-guard-journal-scan.mjs [--weeks N] [--all] [--json]
//     --weeks N   how many of the most recent week-files to include (default 1 = this week)
//     --all       include every week-file found, regardless of age
//     --json      machine-readable output
//
// Exit codes: 0 = read cleanly (even if zero events) · 2 = journal directory does not exist yet
//             (no guard has ever fired) · 3 = journal directory exists but is unreadable
//             (permission error, not-a-directory, ...) — DISTINCT from "zero events": a reader
//             that can't see the data must never print 0 and let it read as "clean".

import { readGuardJournal } from './lib/guard-journal-read.mjs'
import { handleHelpFlag } from './lib/cli-help.mjs'

const HELP = `wt-guard-journal-scan — read the shared guard journal and report, per guard, how
many times it BLOCKED or WARNED this week (or a chosen window). Presentation only — parsing
lives in lib/guard-journal-read.mjs, shared with the SessionStart recurrence surface.

Usage:
  node wt-guard-journal-scan.mjs [--weeks N] [--all] [--json]
    --weeks N   how many of the most recent week-files to include (default 1 = this week)
    --all       include every week-file found, regardless of age
    --json      machine-readable output

Exit codes: 0 read cleanly (even if zero events) · 2 journal directory does not exist yet ·
3 journal directory exists but is unreadable.
`

const argv = process.argv.slice(2)
handleHelpFlag(argv, HELP)

const KNOWN_FLAGS = new Set(['--weeks', '--all', '--json'])
for (const token of argv) {
  if (token.startsWith('--') && !KNOWN_FLAGS.has(token)) {
    console.error(`wt-guard-journal-scan: unknown flag '${token}'`)
    process.exit(2)
  }
}

const arg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const WEEKS = Number(arg('--weeks', '1'))
const ALL = argv.includes('--all')
const AS_JSON = argv.includes('--json')

const result = readGuardJournal({ weeks: WEEKS, all: ALL })

if (!result.ok) {
  if (AS_JSON) {
    console.log(JSON.stringify({ ok: false, exitCode: result.exitCode, message: result.message, baseDir: result.baseDir }))
  } else {
    console.log(result.message)
  }
  process.exit(result.exitCode)
}

const { baseDir, window: windowLabel, weekFiles, totalLines, unreadableLines, rows } = result

if (AS_JSON) {
  console.log(
    JSON.stringify({
      ok: true,
      baseDir,
      window: windowLabel,
      weekFiles,
      totalEvents: result.totalEvents,
      unreadableLines,
      guards: rows.map(({ guard, blocked, warned, total, classes }) => ({ guard, blocked, warned, total, classes })),
      caveat:
        'A count is an EVENT count, not a confirmed-defect count. Some guards include bounded ' +
        'evidence that lets a reader classify a firing, but this scanner does not classify it. ' +
        'Only guards wired to this journal appear here; a defect with no guard is invisible by construction.',
    }),
  )
  process.exit(0)
}

console.log(`Guard journal — ${windowLabel} (${baseDir})`)
console.log(`Week-files read: ${weekFiles.join(', ') || '(none)'}`)
if (rows.length === 0) {
  console.log('No blocked or warned events recorded in this window.')
} else {
  console.log('')
  console.log('guard'.padEnd(42) + 'blocked'.padStart(9) + 'warned'.padStart(9) + 'total'.padStart(8))
  for (const r of rows) {
    console.log(r.guard.padEnd(42) + String(r.blocked).padStart(9) + String(r.warned).padStart(9) + String(r.total).padStart(8))
  }
}
if (unreadableLines > 0) {
  console.log(`\n⚠ ${unreadableLines} of ${totalLines} lines in the read window were malformed and skipped.`)
}
console.log(
  '\n⚠ These are EVENT counts, not confirmed-defect counts. Some guards include bounded ' +
    'evidence that lets a reader classify a firing, but this scanner does not classify it — read ' +
    'the records before concluding N real mistakes happened. Only ' +
    'guards wired to this journal appear here; a defect nobody has a guard for is absent by ' +
    'construction, not evidence nothing went wrong.',
)
