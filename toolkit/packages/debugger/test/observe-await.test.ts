import { describe, it, expect } from 'vitest'
import { classifyAwaitTick, extractAwaitOutcome, awaitExitCode, truncateAwaitError, AWAIT_ERROR_MAX_CHARS } from '../src/observe-await.js'

// observe-await.ts — the pure decision core of `wt-observe await <runId>` (launch-and-notify
// card #1812476922312000519): one poll tick's observations in, one verdict out. The CLI shell
// owns the HTTP + sleep loop; everything here is deterministic and unit-tested.

describe('classifyAwaitTick', () => {
  const base = { live: null, recallStatus: null, elapsedMs: 0, timeoutMs: 60_000, missingGraceMs: 30_000 }

  it('times out once elapsed exceeds the budget while the run is still going', () => {
    expect(classifyAwaitTick({ ...base, elapsedMs: 60_001, live: { finished: false, status: 'running' } })).toEqual({
      kind: 'timeout',
    })
  })

  it('a terminal observation on the boundary tick WINS over the timeout (pr-review round 3)', () => {
    expect(classifyAwaitTick({ ...base, elapsedMs: 60_001, live: { finished: true, status: 'completed' } })).toEqual({
      kind: 'done',
      status: 'completed',
    })
    expect(classifyAwaitTick({ ...base, elapsedMs: 60_001, recallStatus: 'failed' })).toEqual({
      kind: 'done',
      status: 'failed',
    })
  })

  it('never parrots a stale non-terminal status for a FINISHED registry entry (stopped runs)', () => {
    expect(classifyAwaitTick({ ...base, live: { finished: true, status: 'running' } })).toEqual({
      kind: 'done',
      status: 'unknown',
    })
  })

  it('a live registry entry not yet finished is pending', () => {
    expect(classifyAwaitTick({ ...base, live: { finished: false, status: 'running' } })).toEqual({ kind: 'pending' })
  })

  it('a finished live registry entry is done, carrying its status', () => {
    expect(classifyAwaitTick({ ...base, live: { finished: true, status: 'completed' } })).toEqual({
      kind: 'done',
      status: 'completed',
    })
  })

  it('a finished live entry with a null status still resolves done (status unknown)', () => {
    expect(classifyAwaitTick({ ...base, live: { finished: true, status: null } })).toEqual({
      kind: 'done',
      status: 'unknown',
    })
  })

  it('with no live entry, a terminal recall status is done (registry evicted / attached run)', () => {
    expect(classifyAwaitTick({ ...base, recallStatus: 'completed' })).toEqual({ kind: 'done', status: 'completed' })
    expect(classifyAwaitTick({ ...base, recallStatus: 'failed' })).toEqual({ kind: 'done', status: 'failed' })
  })

  it('with no live entry, a running recall status is pending', () => {
    expect(classifyAwaitTick({ ...base, recallStatus: 'running' })).toEqual({ kind: 'pending' })
  })

  it('a run visible NOWHERE stays pending within the grace window, then reports missing', () => {
    expect(classifyAwaitTick({ ...base, elapsedMs: 29_000 })).toEqual({ kind: 'pending' })
    expect(classifyAwaitTick({ ...base, elapsedMs: 30_001 })).toEqual({ kind: 'missing' })
  })
})

describe('extractAwaitOutcome', () => {
  it('pulls status and io.result from a recall payload', () => {
    const recall = { runId: 'wf_x', status: 'completed', io: { result: { verdict: 'approve' } } }
    expect(extractAwaitOutcome(recall)).toEqual({ status: 'completed', result: { verdict: 'approve' }, error: null })
  })

  it('relays the top-level error reason for a failed run (0-agent boot failure has no other source)', () => {
    const recall = {
      runId: 'wf_x',
      status: 'failed',
      io: { result: null },
      error: 'coverage-audit: "provenance" must be a NON-EMPTY array of { sources, docs } entries',
    }
    expect(extractAwaitOutcome(recall)).toEqual({
      status: 'failed',
      result: null,
      error: 'coverage-audit: "provenance" must be a NON-EMPTY array of { sources, docs } entries',
    })
  })

  it('degrades to nulls on a malformed payload (never throws)', () => {
    expect(extractAwaitOutcome(null)).toEqual({ status: null, result: null, error: null })
    expect(extractAwaitOutcome({ io: 'nope' })).toEqual({ status: null, result: null, error: null })
    expect(extractAwaitOutcome({ error: 123 })).toEqual({ status: null, result: null, error: null })
  })
})

describe('truncateAwaitError', () => {
  it('passes a short reason through unchanged', () => {
    expect(truncateAwaitError('boom')).toBe('boom')
  })

  it('truncates an over-long reason (a full stack) and points at the durable record', () => {
    const long = 'x'.repeat(AWAIT_ERROR_MAX_CHARS + 500)
    const out = truncateAwaitError(long)
    expect(out.length).toBeLessThan(long.length)
    expect(out.startsWith('x'.repeat(AWAIT_ERROR_MAX_CHARS))).toBe(true)
    expect(out).toContain('full error in the run record')
  })
})

describe('awaitExitCode', () => {
  it('maps outcomes to stable exit codes (0 completed, 2 other terminal, 3 timeout, 4 missing)', () => {
    expect(awaitExitCode({ kind: 'done', status: 'completed' })).toBe(0)
    expect(awaitExitCode({ kind: 'done', status: 'failed' })).toBe(2)
    expect(awaitExitCode({ kind: 'done', status: 'unknown' })).toBe(2)
    expect(awaitExitCode({ kind: 'timeout' })).toBe(3)
    expect(awaitExitCode({ kind: 'missing' })).toBe(4)
  })
})
