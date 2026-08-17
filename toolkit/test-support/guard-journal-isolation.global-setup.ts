// guard-journal-isolation.global-setup.ts — the ONE mechanical guarantee that a `pnpm test` run
// never writes into the REAL, durable guard journal (~/.local/state/wt-guard-journal by default,
// or wherever WT_GUARD_JOURNAL_DIR pointed for the *outer* process running vitest itself) —
// AND does so without making the suite's exit code depend on what OTHER processes on the same
// machine write to that same directory while the run is in flight.
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
// difference — a new file, or an existing file that grew — means SOMETHING wrote to the real
// location during this run.
//
// THIS IS A DIFFERENT CLAIM FROM THE PER-WORKER REDIRECT. The redirect (guard-journal-isolation.
// setup.ts) is what makes the invariant TRUE in the common case (env inherited via `...process.env`
// or `process.env` directly — the overwhelming pattern in this suite, verified by grep before this
// fix). This file is what makes a VIOLATION OF THE INVARIANT VISIBLE even when a future test
// bypasses the redirect (e.g. constructs its own `env: {}` from scratch, or unsets the var before
// spawning) — the two together are belt-and-suspenders, not the same guarantee twice.
//
// SOLE-WRITER ASSUMPTION — CONDITIONAL, NOT ASSUMED. `~/.local/state/wt-guard-journal` is
// MACHINE-GLOBAL, not per-run: every Claude Code session on this machine appends to it whenever
// a guard hook fires on an ordinary tool call, entirely independent of this test run. Measured:
// an UNCHANGED tree produced `pnpm test` exit 1 (teardown threw) immediately followed by exit 0
// on a re-run, identical pass tallies both times — the growth this file detected was real, but it
// was never THIS run's leak. A THROW is only warranted when this process can reasonably believe
// it is the journal's only writer for the run's duration; otherwise the observation is genuine
// but not attributable, and the correct response is a loud warning, not a red exit code.
//
// The sole-writer signal is: `process.env.CI` truthy (CI runners are single-tenant per job), OR
// the opt-in `WT_GUARD_JOURNAL_ISOLATION_STRICT` env var set to a truthy value (for a developer
// who knows no other session is touching this machine's journal right now and wants the hard
// guarantee locally). Absent either, growth is reported via `console.warn` and the suite PASSES
// — the merge-blocking path (`.github/workflows/cross-os.yml`, which runs with `CI` set) keeps
// full throwing strength; only an uncontrolled local run downgrades to a warning.
//
// THE WARNING NAMES ALL THREE CAUSES THAT PRODUCE THE IDENTICAL OBSERVATION — a before/after byte
// diff cannot itself distinguish them, so the message must not claim more than it knows:
//   1. a test in THIS run spawned a guard hook without redirecting WT_GUARD_JOURNAL_DIR (the
//      case this file was originally written to catch);
//   2. ANOTHER session on this machine fired a guard hook during this run's window — unrelated to
//      this suite entirely;
//   3. an ad-hoc `vitest run -t …` invocation ran OUTSIDE the isolation wrapper (e.g. bypassing
//      globalSetup/setupFiles via a narrower vitest invocation that skips config-level hooks).
//
// READABLE IN BOTH OUTCOMES — the trap this file was explicitly designed to avoid, and this fix
// preserves it. A check that reads "did the journal get new records" only produces a signal when
// something WENT WRONG; a clean run and a run that silently never executed both read as "no new
// records" — indistinguishable. The GUARD is on the DIFFERENCE (before-size vs after-size,
// before-file-set vs after-file-set), not on the presence/absence of the directory — a run with
// zero pre-existing journal activity and zero new activity still snapshots a real (possibly
// empty) map both times and compares them, so "the directory doesn't exist yet" and "the
// directory existed and grew" are structurally distinguishable outcomes, never conflated into the
// same "nothing to report" reading. What changed is only what happens on a DETECTED difference
// when the sole-writer signal is absent: warn instead of throw, never silence.
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

/** True only when this process can reasonably believe it is the journal's sole writer for the
 *  run's duration: a CI runner (single-tenant per job), or a developer's explicit local opt-in.
 *  Absent either, the machine-global journal may legitimately move for reasons unrelated to this
 *  run, and a detected difference downgrades from a throw to a warning. */
function soleWriterAssumptionHolds(): boolean {
  if (isTruthyEnv(process.env.CI)) return true
  if (isTruthyEnv(process.env.WT_GUARD_JOURNAL_ISOLATION_STRICT)) return true
  return false
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  return value !== '0' && value.toLowerCase() !== 'false'
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

    if (newFiles.length === 0 && grownFiles.length === 0) return

    const message =
      `GUARD JOURNAL CHANGED: the real journal at ${dir} changed during this test run. ` +
      `New files: ${JSON.stringify(newFiles)}. Grown files (name: before -> after bytes): ` +
      `${JSON.stringify(grownFiles.map((f) => `${f}: ${before[f]} -> ${after[f]}`))}. ` +
      `This directory is MACHINE-GLOBAL, not per-run, so this observation has three possible ` +
      `causes and this check cannot itself distinguish them: ` +
      `(1) a test in THIS run spawned a guard hook without redirecting WT_GUARD_JOURNAL_DIR — ` +
      `pass it (or spread it via the shared test env helper) to every spawnSync/execFileSync ` +
      `call that runs a plugin/bin/*guard*.mjs hook; ` +
      `(2) another Claude Code session on this machine fired a guard hook during this run's ` +
      `window, unrelated to this suite; ` +
      `(3) an ad-hoc vitest invocation ran outside this isolation wrapper (e.g. a narrower ` +
      `\`vitest run -t …\` that skips this config's globalSetup/setupFiles).`

    if (soleWriterAssumptionHolds()) {
      throw new Error(
        `${message} Sole-writer signal was ACTIVE (CI or WT_GUARD_JOURNAL_ISOLATION_STRICT) — ` +
          `treating this as attributable to case (1) and failing the run.`,
      )
    }

    console.warn(
      `${message} Sole-writer signal was NOT set (no CI, no WT_GUARD_JOURNAL_ISOLATION_STRICT) — ` +
        `this run cannot tell which cause applies, so it is warning rather than failing. Set ` +
        `WT_GUARD_JOURNAL_ISOLATION_STRICT=1 locally once you know no other session is touching ` +
        `this machine's journal, to get the hard failure back.`,
    )
  }
}
