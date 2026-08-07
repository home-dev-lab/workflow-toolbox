// guard-journal-isolation.global-setup.ts — the ONE mechanical guarantee that a `pnpm test` run
// never writes into the REAL, durable guard journal (~/.local/state/wt-guard-journal by default,
// or wherever WT_GUARD_JOURNAL_DIR pointed for the *outer* process running vitest itself).
//
// WHY A GLOBAL SETUP, NOT A PER-FILE FIX. 17 test files spawn a real guard-hook child process
// without redirecting WT_GUARD_JOURNAL_DIR — each inherited it by omission, not by choice. Fixing
// each call site is necessary for the SYMPTOM (see guard-journal-isolation.setup.ts, the sibling
// per-worker file that does that) but not sufficient for the INVARIANT: a test written next month,
// by someone who has never read this file, can spawn a guard hook exactly the same way the 17 did
// and reintroduce the leak with nothing failing. This file is the mechanical backstop for THAT
// case — it does not rely on every test author remembering to redirect anything.
//
// HOW. `globalSetup` runs once, in the vitest *parent* process, before any worker spins up and
// again (its returned teardown) after every worker has finished. It snapshots the REAL journal
// directory's file set + byte sizes before the run and re-reads the same snapshot after. Any
// difference — a new file, or an existing file that grew — means some test, somewhere, wrote to
// the real location during this run, and the whole suite goes RED with the guard name(s) named.
//
// THIS IS A DIFFERENT CLAIM FROM THE PER-WORKER REDIRECT. The redirect (guard-journal-isolation.
// setup.ts) is what makes the invariant TRUE in the common case (env inherited via `...process.env`
// or `process.env` directly — the overwhelming pattern in this suite, verified by grep before this
// fix). This file is what makes a VIOLATION OF THE INVARIANT VISIBLE even when a future test
// bypasses the redirect (e.g. constructs its own `env: {}` from scratch, or unsets the var before
// spawning) — the two together are belt-and-suspenders, not the same guarantee twice.
//
// READABLE IN BOTH OUTCOMES — the trap this file was explicitly designed to avoid. A check that
// reads "did the journal get new records" only produces a signal when something WENT WRONG; a
// clean run and a run that silently never executed both read as "no new records; the module
// itself never imported, so nothing happened either way. The GUARD is on the DIFFERENCE
// (before-size vs after-size, before-file-set vs after-file-set), not on the presence/absence
// of the directory — a run with zero pre-existing journal activity and zero new activity still
// snapshots a real (possibly empty) map both times and compares them, so "the directory doesn't
// exist yet" and "the directory existed and grew" are structurally distinguishable outcomes,
// never conflated into the same "nothing to report" reading.
import { existsSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The location a guard hook journals to when NOTHING redirects it — must match
 *  plugin/bin/lib/guard-journal.mjs's baseDir() exactly, including the WT_GUARD_JOURNAL_DIR
 *  override precedence, since the OUTER process (this one) may itself be running under a
 *  redirected journal (CI, another test harness) and the invariant is "did IT change", not
 *  "did the hardcoded path change". */
function realJournalDir(): string {
  const override = process.env.WT_GUARD_JOURNAL_DIR
  if (override) return override
  return path.join(os.homedir(), '.local', 'state', 'wt-guard-journal')
}

type Snapshot = Record<string, number> // filename -> byte size

function snapshot(): Snapshot {
  const dir = realJournalDir()
  if (!existsSync(dir)) return {}
  const out: Snapshot = {}
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ndjson')) continue
    out[f] = statSync(path.join(dir, f)).size
  }
  return out
}

export default function setup(): () => void {
  const before = snapshot()
  const dir = realJournalDir()

  return function teardown() {
    const after = snapshot()
    const newFiles = Object.keys(after).filter((f) => !(f in before))
    const grownFiles = Object.keys(after).filter((f) => f in before && after[f] !== before[f])

    if (newFiles.length > 0 || grownFiles.length > 0) {
      throw new Error(
        `GUARD JOURNAL POLLUTION: the real journal at ${dir} changed during this test run — a ` +
          `test spawned a guard hook without redirecting WT_GUARD_JOURNAL_DIR. ` +
          `New files: ${JSON.stringify(newFiles)}. Grown files (name: before -> after bytes): ` +
          `${JSON.stringify(grownFiles.map((f) => `${f}: ${before[f]} -> ${after[f]}`))}. ` +
          `Fix: pass WT_GUARD_JOURNAL_DIR (or spread it via the shared test env helper) to every ` +
          `spawnSync/execFileSync call that runs a plugin/bin/*guard*.mjs hook.`,
      )
    }
  }
}
