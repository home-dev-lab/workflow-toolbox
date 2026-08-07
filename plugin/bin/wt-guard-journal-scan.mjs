#!/usr/bin/env node
// wt-guard-journal-scan.mjs — the READ side of guard-journal.mjs. Reports, per guard, how many
// times it BLOCKED or WARNED this week (or over a chosen window), so "has this recurred" has a
// number instead of an impression.
//
// WHAT THIS CANNOT TELL YOU, stated up front because it is the whole reason this script prints
// a caveat rather than a bare table:
//   - A guard that fires on CORRECT work (a false positive) writes the exact same record shape
//     as one that caught a real, repeated defect. This journal counts EVENTS, not confirmed
//     defects — a rising count for one guard is a prompt to go read what it actually matched,
//     never proof that N real mistakes happened.
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

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE_DIR = process.env.WT_GUARD_JOURNAL_DIR || join(homedir(), '.local', 'state', 'wt-guard-journal')

const argv = process.argv.slice(2)
const arg = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const WEEKS = Number(arg('--weeks', '1'))
const ALL = argv.includes('--all')
const AS_JSON = argv.includes('--json')

function fail(exitCode, message) {
  if (AS_JSON) {
    console.log(JSON.stringify({ ok: false, exitCode, message, baseDir: BASE_DIR }))
  } else {
    console.log(message)
  }
  process.exit(exitCode)
}

if (!existsSync(BASE_DIR)) {
  fail(2, `No guard journal at ${BASE_DIR} — no guard has recorded a block or warning yet.`)
}

let files
try {
  files = readdirSync(BASE_DIR)
    .filter((f) => f.endsWith('.ndjson'))
    .map((f) => ({ name: f, path: join(BASE_DIR, f) }))
    .sort((a, b) => (a.name < b.name ? 1 : -1)) // newest ISO-week filename first, lexicographic == chronological
} catch (error) {
  fail(3, `Guard journal directory ${BASE_DIR} exists but could not be read: ${error.message}`)
}

const selected = ALL ? files : files.slice(0, Math.max(1, WEEKS))

const perGuard = new Map() // guard -> { blocked, warned, classes: Map<class,count> }
let unreadableLines = 0
let totalLines = 0

for (const f of selected) {
  let text
  try {
    text = readFileSync(f.path, 'utf8')
  } catch {
    continue // one unreadable week-file must not sink the whole report
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    totalLines += 1
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      unreadableLines += 1
      continue
    }
    if (!entry || typeof entry.guard !== 'string') {
      unreadableLines += 1
      continue
    }
    if (!perGuard.has(entry.guard)) {
      perGuard.set(entry.guard, { blocked: 0, warned: 0, classes: new Map() })
    }
    const g = perGuard.get(entry.guard)
    if (entry.decision === 'blocked') g.blocked += 1
    else if (entry.decision === 'warned') g.warned += 1
    if (typeof entry.class === 'string') {
      g.classes.set(entry.class, (g.classes.get(entry.class) || 0) + 1)
    }
  }
}

const rows = [...perGuard.entries()]
  .map(([guard, g]) => ({
    guard,
    blocked: g.blocked,
    warned: g.warned,
    total: g.blocked + g.warned,
    classes: Object.fromEntries(g.classes),
  }))
  .sort((a, b) => b.total - a.total)

const windowLabel = ALL ? 'all recorded weeks' : `last ${Math.max(1, WEEKS)} week-file(s)`

if (AS_JSON) {
  console.log(
    JSON.stringify({
      ok: true,
      baseDir: BASE_DIR,
      window: windowLabel,
      weekFiles: selected.map((f) => f.name),
      totalEvents: rows.reduce((s, r) => s + r.total, 0),
      unreadableLines,
      guards: rows,
      caveat:
        'A count is an EVENT count, not a confirmed-defect count — a guard firing on correct ' +
        'work looks identical to one catching a real recurrence. Only guards wired to this ' +
        'journal appear here; a defect with no guard is invisible by construction.',
    }),
  )
  process.exit(0)
}

console.log(`Guard journal — ${windowLabel} (${BASE_DIR})`)
console.log(`Week-files read: ${selected.map((f) => f.name).join(', ') || '(none)'}`)
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
  '\n⚠ These are EVENT counts, not confirmed-defect counts: a guard firing on correct work ' +
    '(a false positive) writes the same record shape as one catching a real recurrence — read ' +
    "what a rising count actually matched before concluding N real mistakes happened. Only " +
    'guards wired to this journal appear here; a defect nobody has a guard for is absent by ' +
    'construction, not evidence nothing went wrong.',
)
