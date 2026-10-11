import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error ESM worker module
import { createIdleWatch } from '../../../../plugin/bin/lib/host/lane-idle-worker.mjs'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error ESM runtime module
import { activityEvidence, idleVerdict, liveDescendants, unattendedMaxSeconds } from '../../../../plugin/bin/lib/lane-deadline-core.mjs'

describe('lane deadline core', () => {
  it('calculates the unattended default maximum including every grace window', () => {
    expect(unattendedMaxSeconds({ timeout: 5400, decisionGrace: 300, maxExtensions: 3 })).toBe(22800)
    expect(unattendedMaxSeconds({ timeout: 0.1, decisionGrace: 0.2, maxExtensions: 0 })).toBeCloseTo(0.3)
  })

  it.each(['ppid', 'parentPid'])('follows deep %s ancestry without unrelated processes or the root', (parent) => {
    const rows = [[7, 6], [6, 5], [5, 4], [4, 1], [8, 2]].map(([pid, ppid]) => ({ pid, [parent]: ppid }))
    expect(liveDescendants(rows, 4)).toEqual([5, 6, 7])
  })

  it('terminates ancestry cycles and accepts mixed parent field names', () => {
    expect(liveDescendants([{ pid: 1, ppid: 3 }, { pid: 2, parentPid: 1 }, { pid: 3, ppid: 2 }], 1)).toEqual([2, 3])
  })

  it('never warns or stops on unknown evidence, even after both thresholds', () => {
    expect(idleVerdict({ nowMs: 5000, lastActivityMs: 0, windowSeconds: 1, enforceSeconds: 2, status: 'unknown' })).toEqual({ silentSeconds: 5, warn: false, stop: false })
  })

  it('observes without enforcing and compares unrounded seconds at the threshold', () => {
    const input = { lastActivityMs: 0, windowSeconds: 1, enforceSeconds: 2, status: 'known' }
    expect(idleVerdict({ ...input, nowMs: 1999.9 })).toEqual({ silentSeconds: 1.9999, warn: true, stop: false })
    expect(idleVerdict({ ...input, nowMs: 2000 }).stop).toBe(true)
    expect(idleVerdict({ ...input, nowMs: 5000, enforceSeconds: 0 }).stop).toBe(false)
  })

  it.each([
    { snapshot: null, worktree: { status: 'known' } },
    { snapshot: { supported: false, processes: [] }, worktree: { status: 'known' } },
    { snapshot: { processes: [] }, worktree: { status: 'known' } },
    { snapshot: { processes: [{ pid: 4, ppid: 1 }] }, worktree: { status: 'unknown', bounded: true } },
    { snapshot: { processes: [{ pid: 4 }] }, worktree: { status: 'known' } },
  ])('names unavailable activity instead of deriving a stop from it: %j', (input) => {
    expect(activityEvidence({ ...input, rootPid: 4 })).toMatchObject({ status: 'unknown', reason: expect.any(String) })
  })
  it('retains known descendant activity when the worktree scan is bounded', () => {
    expect(activityEvidence({ snapshot: { processes: [{ pid: 4, ppid: 1 }, { pid: 5, parentPid: 4 }] }, worktree: { status: 'unknown', bounded: true }, rootPid: 4 })).toMatchObject({ status: 'unknown', descendants: [5] })
  })
})

function idleHarness() {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const root = mkdtempSync(join(tmpdir(), 'lane-idle-core-'))
  const log = join(root, 'run.log')
  writeFileSync(log, '')
  const stop = vi.fn()
  const writeState = vi.fn()
  const readSnapshot = vi.fn((): unknown => ({ processes: [{ pid: 4, parentPid: 1 }] }))
  const latestWrite = vi.fn(() => ({ status: 'known', at: 0, bounded: false }))
  const watch = createIdleWatch({ opts: { dir: root, log, idleWindow: 1, idleTimeout: 2 }, childPid: 4, launchedAtMs: 0, writeState, stop, readSnapshot, latestWrite, appendLine: (line: string) => { appendFileSync(log, `${line}\n`); return true } })
  const cleanup = () => { watch.clear(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) }
  return { log, watch, stop, writeState, readSnapshot, latestWrite, cleanup }
}

describe('idle activity sampling', () => {
  it.each(['throw', 'empty', 'bounded'])('warns once about %s evidence and never enforces it', (kind) => {
    const h = idleHarness()
    try {
      if (kind === 'throw') h.readSnapshot.mockImplementation(() => { throw new Error('provider failed') })
      else if (kind === 'empty') h.readSnapshot.mockReturnValue(null)
      else h.latestWrite.mockReturnValue({ status: 'unknown', at: 0, bounded: true })
      vi.advanceTimersByTime(4000)
      const text = readFileSync(h.log, 'utf8')
      expect(text.match(/^LANE_IDLE_UNKNOWN /gm)).toHaveLength(1)
      expect(text).not.toMatch(/LANE_IDLE_(WARN|STOP)/)
      expect(h.stop).not.toHaveBeenCalled()
      expect(h.writeState.mock.lastCall?.[0].idle).toMatchObject({ status: 'unknown', reason: expect.any(String) })
    } finally { h.cleanup() }
  })

  it('does not count its warning as child output or delay an enforced stop', () => {
    const h = idleHarness()
    try {
      vi.advanceTimersByTime(2000)
      const text = readFileSync(h.log, 'utf8')
      expect(text.match(/^LANE_IDLE_WARN /gm)).toHaveLength(1)
      expect(text).toContain('LANE_IDLE_STOP silentSeconds=2')
      expect(h.stop).toHaveBeenCalledTimes(1)
      expect(h.writeState.mock.lastCall?.[0].idle.maxSilentSeconds).toBe(2)
    } finally { h.cleanup() }
  })
})

describe('idle activity rearming', () => {
  it.each(['log', 'worktree', 'descendant'])('re-arms a silent stretch after %s activity', (kind) => {
    const h = idleHarness()
    try {
      vi.advanceTimersByTime(1000)
      if (kind === 'log') appendFileSync(h.log, 'child output\n')
      else if (kind === 'worktree') h.latestWrite.mockReturnValue({ status: 'known', at: 1250, bounded: false })
      else h.readSnapshot.mockReturnValue({ processes: [{ pid: 4, ppid: 1 }, { pid: 5, parentPid: 4 }] })
      vi.advanceTimersByTime(250)
      h.readSnapshot.mockReturnValue({ processes: [{ pid: 4, ppid: 1 }] })
      vi.advanceTimersByTime(1000)
      expect(readFileSync(h.log, 'utf8').match(/^LANE_IDLE_WARN /gm)).toHaveLength(2)
      expect(h.stop).not.toHaveBeenCalled()
      expect(h.writeState.mock.lastCall?.[0].idle.lastActivityAt).toBe(new Date(1250).toISOString())
      h.watch.clear()
      const calls = h.writeState.mock.calls.length
      vi.advanceTimersByTime(4000)
      expect(h.writeState).toHaveBeenCalledTimes(calls)
    } finally { h.cleanup() }
  })
  it('keeps the newest source timestamp when a descendant sample is earlier', () => {
    const h = idleHarness()
    try {
      h.latestWrite.mockReturnValue({ status: 'known', at: 1250, bounded: false })
      h.readSnapshot.mockReturnValue({ processes: [{ pid: 4, ppid: 1 }, { pid: 5, parentPid: 4 }] })
      vi.advanceTimersByTime(250)
      expect(h.writeState.mock.lastCall?.[0].idle.lastActivityAt).toBe(new Date(1250).toISOString())
    } finally { h.cleanup() }
  })
})
