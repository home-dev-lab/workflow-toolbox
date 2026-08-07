// guard-journal-read.mjs — the ONE shared parser/aggregator for plugin/bin/lib/guard-journal.mjs's
// NDJSON records. Extracted from wt-guard-journal-scan.mjs (card 1836526445) so a second reader —
// the SessionStart recurrence surface, wt-guard-recurrence-hook.mjs — does not re-implement the
// parse. A second parser drifts from the first; then two numbers disagree with nothing saying
// which one is right (a duplicated-shape defect this repo's own step-back rule names directly).
//
// Every caller — the CLI and the hook — gets identical: which week-files were read, per-guard
// blocked/warned/total, and the per-guard `classes` breakdown, from the same code path.
//
// FAIL-OPEN CONTRACT: this module only READS. It never throws for a missing directory, an
// unreadable directory, an unreadable individual week-file, or a malformed line — each of those
// is reported as a distinct, named outcome (see the return shape below), never an exception. A
// caller that wants "throw on trouble" gets nothing here; every one of the two current callers
// wants "degrade to a stated outcome", which is why this boundary is drawn here rather than at
// each call site.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolve the journal directory the same way guard-journal.mjs's baseDir() does — same
 *  override precedence (WT_GUARD_JOURNAL_DIR first), so a reader and the writer never disagree
 *  about which directory "the journal" means. */
export function defaultGuardJournalDir() {
  return process.env.WT_GUARD_JOURNAL_DIR || join(homedir(), '.local', 'state', 'wt-guard-journal')
}

/**
 * Read and aggregate the guard journal over a window of the most recent week-files.
 *
 * @param {object} [opts]
 * @param {number} [opts.weeks=1]   - how many of the most recent week-files to include.
 * @param {boolean} [opts.all=false] - include every week-file found, regardless of age (overrides weeks).
 * @param {string} [opts.baseDir]   - override the journal directory (defaults to defaultGuardJournalDir()).
 * @returns {
 *   {ok:true, baseDir:string, window:string, weekFiles:string[], totalEvents:number,
 *    totalLines:number, unreadableLines:number, rows:Array<{guard:string, blocked:number,
 *    warned:number, total:number, classes:Record<string,number>, unclassedTotal:number}>}
 *   |
 *   {ok:false, exitCode:2|3, message:string, baseDir:string}
 * }
 */
export function readGuardJournal({ weeks = 1, all = false, baseDir } = {}) {
  const BASE_DIR = baseDir || defaultGuardJournalDir()

  if (!existsSync(BASE_DIR)) {
    return {
      ok: false,
      exitCode: 2,
      message: `No guard journal at ${BASE_DIR} — no guard has recorded a block or warning yet.`,
      baseDir: BASE_DIR,
    }
  }

  let files
  try {
    files = readdirSync(BASE_DIR)
      .filter((f) => f.endsWith('.ndjson'))
      .map((f) => ({ name: f, path: join(BASE_DIR, f) }))
      .sort((a, b) => (a.name < b.name ? 1 : -1)) // newest ISO-week filename first, lexicographic == chronological
  } catch (error) {
    return {
      ok: false,
      exitCode: 3,
      message: `Guard journal directory ${BASE_DIR} exists but could not be read: ${error.message}`,
      baseDir: BASE_DIR,
    }
  }

  const selected = all ? files : files.slice(0, Math.max(1, weeks))

  // guard -> { blocked, warned, classes: Map<class,count>, unclassedTotal }
  const perGuard = new Map()
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
      // A malformed or future-version record (extra/renamed fields we don't know about) is
      // tolerated here the same way: we only require `guard` to be a string. Anything else —
      // including fields this version has never heard of — is simply ignored, never rejected.
      if (!entry || typeof entry.guard !== 'string') {
        unreadableLines += 1
        continue
      }
      if (!perGuard.has(entry.guard)) {
        perGuard.set(entry.guard, { blocked: 0, warned: 0, classes: new Map(), unclassedTotal: 0 })
      }
      const g = perGuard.get(entry.guard)
      if (entry.decision === 'blocked') g.blocked += 1
      else if (entry.decision === 'warned') g.warned += 1
      if (typeof entry.class === 'string' && entry.class) {
        g.classes.set(entry.class, (g.classes.get(entry.class) || 0) + 1)
      } else if (entry.decision === 'blocked' || entry.decision === 'warned') {
        g.unclassedTotal += 1
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
      unclassedTotal: g.unclassedTotal,
    }))
    .sort((a, b) => b.total - a.total)

  const windowLabel = all ? 'all recorded weeks' : `last ${Math.max(1, weeks)} week-file(s)`

  return {
    ok: true,
    baseDir: BASE_DIR,
    window: windowLabel,
    weekFiles: selected.map((f) => f.name),
    totalEvents: rows.reduce((s, r) => s + r.total, 0),
    totalLines,
    unreadableLines,
    rows,
  }
}
