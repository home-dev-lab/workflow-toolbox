// guard-journal-isolation.setup.ts — makes the pollution invariant TRUE, not merely detected.
//
// Runs once per vitest worker (a `setupFiles` module, loaded before that worker's test files).
// It sets `process.env.WT_GUARD_JOURNAL_DIR` to a fresh, worker-private temp directory for the
// lifetime of that worker's tests. plugin/bin/lib/guard-journal.mjs's baseDir() already treats
// this env var as an override with top priority — this file simply arranges for it to always be
// SET while any test in this suite runs, so the 17 test files that spawn a real guard-hook child
// process without naming the var explicitly (verified before this fix: 0 occurrences of
// WT_GUARD_JOURNAL_DIR in each of them) redirect anyway, because `spawnSync(..., { env:
// process.env })` or `{ env: { ...process.env, ... } }` — the pattern every one of them uses —
// inherits it for free.
//
// A test that wants its OWN isolated journal directory for assertions (guard-journal.test.ts,
// guard-journal-family.test.ts) still works unchanged: their own `{ ...process.env,
// WT_GUARD_JOURNAL_DIR: journalDir, ...env }` spread simply overrides this default with a
// narrower one for that one call, same as it always did.
//
// Deliberately NOT a change to guard-journal.mjs itself: the production writer must never guess
// "am I under test" (see the module's own header) — this file is entirely test-harness-side, the
// production code is unchanged and has no idea a test suite exists.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'wt-guard-journal-suite-default-'))
process.env.WT_GUARD_JOURNAL_DIR = dir

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})
