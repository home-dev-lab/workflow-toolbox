// stop-state.test.ts — the first test peer for stop-state.ts, covering the DURABLE
// project-scoped reported-runs store (the #65796 fix). The per-session state (readStopState /
// writeStopState) stays keyed by sessionId; this store keys on the cwd-derived PROJECT slug so
// a mid-session session-UUID change (auto-compaction) does NOT reset the dedup and replay every
// still-listed finished run.
//
// The functions use the real $TMPDIR/wt-stop-hook dir (no injectable seam, matching the module's
// held-out convention), so each test uses a UNIQUE cwd — the derived filename is therefore unique
// and can never collide with a real hook's state — and cleans its file up afterwards.

import { unlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, describe, it, expect } from 'vitest'
import {
  reportedRunsPath,
  readReportedRuns,
  writeReportedRuns,
  givenUpTasksPath,
  readGivenUpTasks,
  writeGivenUpTasks,
} from '../src/stop-state.js'
import { projectSlug } from '../src/source.js'

// Unique per-test cwds so the derived state file never collides with a real run's.
const cwds: string[] = []
function uniqueCwd(tag: string): string {
  const cwd = `/tmp/wt-stop-state-test/${tag}`
  cwds.push(cwd)
  return cwd
}

afterEach(() => {
  for (const cwd of cwds.splice(0)) {
    // Both durable files may have been written for a given cwd; clean up each independently.
    for (const p of [reportedRunsPath(cwd), givenUpTasksPath(cwd)]) {
      try {
        unlinkSync(p)
      } catch {
        // never written / already gone — fine
      }
    }
  }
})

describe('reportedRunsPath — keyed by PROJECT (cwd), not session', () => {
  it('derives the path from the project slug under $TMPDIR/wt-stop-hook, with no session input', () => {
    const cwd = '/home/me/projects/thing'
    expect(reportedRunsPath(cwd)).toBe(join(tmpdir(), 'wt-stop-hook', `reported-runs-${projectSlug(cwd)}.json`))
  })

  it('two different projects get two different files; the same project is stable across calls', () => {
    expect(reportedRunsPath('/proj/a')).not.toBe(reportedRunsPath('/proj/b'))
    expect(reportedRunsPath('/proj/a')).toBe(reportedRunsPath('/proj/a'))
  })

  it('degrades an empty cwd to a stable "unknown" file rather than an empty name', () => {
    expect(reportedRunsPath('')).toBe(join(tmpdir(), 'wt-stop-hook', 'reported-runs-unknown.json'))
  })
})

describe('read/writeReportedRuns — durable round-trip', () => {
  it('persists runIds and reads them back for the same project', () => {
    const cwd = uniqueCwd('roundtrip')
    writeReportedRuns(cwd, ['wf_a1', 'wf_b2', 'wf_c3'])
    expect(readReportedRuns(cwd)).toEqual(['wf_a1', 'wf_b2', 'wf_c3'])
  })

  it('the set SURVIVES a simulated session change — a second read (same cwd, new "session") still sees it', () => {
    // The functions take ONLY cwd: there is no session identity to lose. This is the #65796 fix —
    // a regression back to session-keying would break this (the new session would read []).
    const cwd = uniqueCwd('survives-session-change')
    writeReportedRuns(cwd, ['wf_kept'])
    // ... time passes, auto-compaction swaps the session UUID, the hook fires again ...
    expect(readReportedRuns(cwd)).toEqual(['wf_kept'])
  })

  it('FIFO-caps the stored set so a long-lived project cannot grow it unbounded', () => {
    const cwd = uniqueCwd('fifo-cap')
    const many = Array.from({ length: 620 }, (_, i) => `wf_${i}`)
    writeReportedRuns(cwd, many)
    const read = readReportedRuns(cwd)
    expect(read).toHaveLength(500) // REPORTED_RUNS_CAP
    expect(read[0]).toBe('wf_120') // oldest 120 evicted; newest kept
    expect(read.at(-1)).toBe('wf_619')
  })

  it('is tolerant: a never-written project reads back [] and never throws', () => {
    const cwd = uniqueCwd('never-written')
    expect(readReportedRuns(cwd)).toEqual([])
    expect(() => readReportedRuns(cwd)).not.toThrow()
  })

  it('MERGES with the on-disk set — a durable reported run is never dropped by a later write', () => {
    // The set is additive: dropping a runId would re-announce that run. A later write (e.g. a
    // concurrent same-project session that only knows wf_new) must UNION, not clobber wf_old.
    const cwd = uniqueCwd('merge')
    writeReportedRuns(cwd, ['wf_old'])
    writeReportedRuns(cwd, ['wf_new'])
    expect(readReportedRuns(cwd).sort()).toEqual(['wf_new', 'wf_old'])
  })

  it('is tolerant of a MALFORMED state file — reads [] and never throws', () => {
    const cwd = uniqueCwd('malformed')
    mkdirSync(dirname(reportedRunsPath(cwd)), { recursive: true })
    writeFileSync(reportedRunsPath(cwd), '{ not valid json')
    expect(readReportedRuns(cwd)).toEqual([])
    expect(() => readReportedRuns(cwd)).not.toThrow()
    // a subsequent write still succeeds (overwriting the garbage), merging in the new run
    writeReportedRuns(cwd, ['wf_ok'])
    expect(readReportedRuns(cwd)).toEqual(['wf_ok'])
  })
})

describe('read/writeGivenUpTasks — durable VANISHED-run dedup (the taskId half of #65796)', () => {
  // given-up-tasks holds taskIds we conclusively gave up resolving (the journal was NEVER
  // readable), so a run whose runId is unknown is still dedup'd across a session-UUID change.
  // It shares the durableSet* mechanism with reported-runs, so the FIFO cap and malformed-file
  // tolerance are already exercised by the reported-runs suite above; here we cover the
  // given-up-specific FILE/field and the cross-session survival that actually closes the gap.

  it('keys the path by PROJECT under a DISTINCT file from reported-runs (given-up-tasks-<slug>)', () => {
    const cwd = '/home/me/projects/thing'
    expect(givenUpTasksPath(cwd)).toBe(
      join(tmpdir(), 'wt-stop-hook', `given-up-tasks-${projectSlug(cwd)}.json`),
    )
    // The two durable sets must never share a file, or a runId and a taskId could collide.
    expect(givenUpTasksPath(cwd)).not.toBe(reportedRunsPath(cwd))
  })

  it('persists taskIds and reads them back for the same project', () => {
    const cwd = uniqueCwd('givenup-roundtrip')
    writeGivenUpTasks(cwd, ['w1abc', 'w2def'])
    expect(readGivenUpTasks(cwd)).toEqual(['w1abc', 'w2def'])
  })

  it('SURVIVES a simulated session change — a new "session" (same cwd) still sees the given-up set', () => {
    // The #65796 fix for vanished runs: keyed on cwd, not session, so a UUID change can't reset it.
    const cwd = uniqueCwd('givenup-survives')
    writeGivenUpTasks(cwd, ['w1vanished'])
    expect(readGivenUpTasks(cwd)).toEqual(['w1vanished'])
  })

  it('MERGES with the on-disk set — a given-up taskId is never dropped by a later write', () => {
    const cwd = uniqueCwd('givenup-merge')
    writeGivenUpTasks(cwd, ['w1old'])
    writeGivenUpTasks(cwd, ['w2new'])
    expect(readGivenUpTasks(cwd).sort()).toEqual(['w1old', 'w2new'])
  })

  it('is independent from reported-runs — writing one leaves the other empty', () => {
    const cwd = uniqueCwd('givenup-independent')
    writeReportedRuns(cwd, ['wf_resolved'])
    expect(readGivenUpTasks(cwd)).toEqual([])
    writeGivenUpTasks(cwd, ['w1gone'])
    expect(readReportedRuns(cwd)).toEqual(['wf_resolved'])
    expect(readGivenUpTasks(cwd)).toEqual(['w1gone'])
  })
})
