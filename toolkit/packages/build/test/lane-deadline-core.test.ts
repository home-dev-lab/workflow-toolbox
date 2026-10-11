import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error ESM worker module
import { createIdleWatch } from '../../../../plugin/bin/lib/host/lane-idle-worker.mjs'
// @ts-expect-error ESM worker module
import { createLaneDeadline } from '../../../../plugin/bin/lib/host/lane-deadline-worker.mjs'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
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

function idleHarness(createWatch = createIdleWatch) {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(0)
  const root = mkdtempSync(join(tmpdir(), 'lane-idle-core-'))
  const log = join(root, 'run.log')
  writeFileSync(log, '')
  const stop = vi.fn()
  const writeState = vi.fn()
  const readSnapshot = vi.fn((): unknown => ({ processes: [{ pid: 4, parentPid: 1 }] }))
  const latestWrite = vi.fn(() => ({ status: 'known', at: 0, bounded: false }))
  const monotonicNow = vi.fn(() => performance.now())
  const appendLine = vi.fn((line: string) => { appendFileSync(log, `${line}\n`); return true })
  const watch = createWatch({ opts: { dir: root, log, idleWindow: 1, idleTimeout: 2 }, childPid: 4, launchedAtMs: 0, monotonicNow, writeState, stop, readSnapshot, latestWrite, appendLine })
  const cleanup = () => { watch.clear(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) }
  return { log, watch, stop, writeState, readSnapshot, latestWrite, appendLine, monotonicNow, cleanup }
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
  it('dates a future-mtime change by its observation tick rather than the file timestamp', () => {
    const h = idleHarness()
    try {
      h.latestWrite.mockReturnValue({ status: 'known', at: 1250, bounded: false })
      h.readSnapshot.mockReturnValue({ processes: [{ pid: 4, ppid: 1 }, { pid: 5, parentPid: 4 }] })
      vi.advanceTimersByTime(250)
      expect(h.writeState.mock.lastCall?.[0].idle.lastActivityAt).toBe(new Date(250).toISOString())
    } finally { h.cleanup() }
  })
})

async function diagnosticWorkers() {
  const stderr = process.stderr
  const listeners = stderr.listeners('error')
  vi.resetModules()
  // @ts-expect-error ESM worker module
  const deadline = await import('../../../../plugin/bin/lib/host/lane-deadline-worker.mjs')
  // @ts-expect-error ESM worker module
  const idle = await import('../../../../plugin/bin/lib/host/lane-idle-worker.mjs')
  // @ts-expect-error ESM worker module
  const diagnostics = await import('../../../../plugin/bin/lib/host/lane-diagnostics.mjs')
  const cleanup = () => {
    for (const listener of stderr.listeners('error')) {
      if (!listeners.includes(listener)) stderr.removeListener('error', listener as (error: Error) => void)
    }
  }
  return { ...deadline, ...idle, ...diagnostics, cleanup }
}

describe('idle diagnostic failures', () => {
  it.each(['state', 'receipt'])('keeps the idle timer enforcing when a %s write throws', async (kind) => {
    const workers = await diagnosticWorkers()
    const h = idleHarness(workers.createIdleWatch)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      if (kind === 'state') h.writeState.mockImplementation(() => { throw new Error('idle state unavailable') })
      else h.appendLine.mockImplementation(() => { throw new Error('idle receipt unavailable') })
      expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
      expect(h.stop).toHaveBeenCalledTimes(1)
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^wt-lane: .*unavailable\n$/))
    } finally { stderr.mockRestore(); h.cleanup(); workers.cleanup() }
  })
})

describe('monotonic idle silence', () => {
  it('does not stop after a forward wall-clock jump of an hour', () => {
    const h = idleHarness()
    try {
      vi.advanceTimersByTime(500)
      vi.setSystemTime(Date.now() + 3600_000)
      vi.advanceTimersByTime(250)
      expect(h.watch.refresh()).toMatchObject({ silentSeconds: 0.75, warn: false, stop: false })
      expect(h.stop).not.toHaveBeenCalled()
      expect(h.monotonicNow).toHaveBeenCalled()
    } finally { h.cleanup() }
  })

  it('waits a fresh silent window when evidence recovers after idleTimeout', () => {
    const h = idleHarness()
    try {
      h.readSnapshot.mockReturnValue(null)
      vi.advanceTimersByTime(4000)
      h.readSnapshot.mockReturnValue({ processes: [{ pid: 4, ppid: 1 }] })
      vi.advanceTimersByTime(250)
      expect(h.watch.refresh()).toMatchObject({ silentSeconds: 0, warn: false, stop: false })
      expect(h.stop).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2000)
      expect(h.stop).toHaveBeenCalledTimes(1)
    } finally { h.cleanup() }
  })

  it.each([3600_000, -3600_000])('re-arms once for an mtime change to %s without using its absolute date', (at) => {
    const h = idleHarness()
    try {
      vi.advanceTimersByTime(750)
      h.latestWrite.mockReturnValue({ status: 'known', at, bounded: false })
      vi.advanceTimersByTime(250)
      expect(h.watch.refresh()).toMatchObject({ silentSeconds: 0, warn: false, stop: false })
      expect(h.watch.lastActivityAt()).toBe(new Date(1000).toISOString())
      vi.advanceTimersByTime(2000)
      expect(h.stop).toHaveBeenCalledTimes(1)
    } finally { h.cleanup() }
  })
})

function deadlineHarness(active = true, createDeadline = createLaneDeadline, idleTimeout = 0) {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(0)
  const root = mkdtempSync(join(tmpdir(), 'lane-deadline-worker-'))
  const log = join(root, 'run.log')
  const decisionFile = join(root, 'decision.json')
  writeFileSync(log, '')
  let state: Record<string, unknown> = { runId: 'test-run', state: 'running', extensions: [] }
  const writeState = vi.fn((extra: Record<string, unknown>) => { state = { ...state, ...extra } })
  const endGroup = vi.fn()
  const appendLine = vi.fn((line: string) => { appendFileSync(log, `${line}\n`); return true })
  const rows = [{ pid: 4, ppid: 1 }, ...(active ? [{ pid: 5, ppid: 4 }] : [])]
  const readProcessSnapshot = vi.fn((): unknown => ({ processes: rows }))
  const modules = { argvSummary: () => 'test child', latestWorktreeWrite: () => ({ status: 'known', at: 0 }), readLogTail: () => '', processEvidenceStatus: () => 'live', hostAdapter: { readProcessSnapshot } }
  const deadline = createDeadline({ opts: { dir: root, log, timeout: 2, decisionGrace: 5, maxExtensions: 3, idleWindow: 1, idleTimeout }, runId: 'test-run', child: { pid: 4 }, childPid: 4, args: [], launchedAtMs: 0, monotonicNow: () => performance.now(), transitionBoundMs: 0, decisionFile, modules, current: () => state, writeState, journal: vi.fn(), cleanupBrief: vi.fn(), endGroup, appendLine })
  const cleanup = () => { deadline.clear(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) }
  return { log, decisionFile, current: () => state, writeState, endGroup, appendLine, readProcessSnapshot, cleanup }
}

describe('deadline diagnostic failures', () => {
  it.each(['LANE_DECISION_NEEDED', 'LANE_EXTENDED'])('extends through a failing %s receipt without abandonment', async (kind) => {
    const workers = await diagnosticWorkers()
    const h = deadlineHarness(true, workers.createLaneDeadline)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      h.appendLine.mockImplementation((line) => { if (line.startsWith(kind)) throw new Error('receipt unavailable'); return true })
      expect(() => vi.advanceTimersByTime(7000)).not.toThrow()
      expect(h.current()).toMatchObject({ state: 'running', extensionCount: 1, decisionSource: 'grace-default' })
      expect(h.endGroup).not.toHaveBeenCalled()
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^wt-lane: .*receipt unavailable\n$/))
    } finally { stderr.mockRestore(); h.cleanup(); workers.cleanup() }
  })

  it('keeps an owner extension when its receipt throws from the poll callback', async () => {
    const workers = await diagnosticWorkers()
    const h = deadlineHarness(true, workers.createLaneDeadline)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      vi.advanceTimersByTime(2000)
      writeFileSync(h.decisionFile, JSON.stringify({ runId: 'test-run', timeoutAt: h.current().timeoutAt, decision: 'extend', extendSeconds: 10 }))
      h.appendLine.mockImplementation(() => { throw new Error('owner receipt unavailable') })
      expect(() => vi.advanceTimersByTime(100)).not.toThrow()
      expect(h.current()).toMatchObject({ state: 'running', extensionCount: 1, decisionSource: 'owner', extensions: [{ source: 'owner' }] })
      expect(h.endGroup).not.toHaveBeenCalled()
      vi.advanceTimersByTime(5000)
      expect(h.endGroup).not.toHaveBeenCalled()
    } finally { stderr.mockRestore(); h.cleanup(); workers.cleanup() }
  })
})

describe('asynchronous diagnostic sink supervision', () => {
  it('survives asynchronous stderr errors and still applies a grace-default extension', async () => {
    const sink = new Writable({ write(_chunk, _encoding, callback) { queueMicrotask(() => callback(new Error('stderr unavailable'))) } })
    const uncaught: unknown[] = []
    const emit = sink.emit.bind(sink)
    // Capture otherwise-uncaught stream errors at the event boundary to protect the test worker.
    vi.spyOn(sink, 'emit').mockImplementation((event, ...args) => {
      try { return emit(event, ...args) } catch (error) { uncaught.push(error); return false }
    })
    const stderr = vi.spyOn(process, 'stderr', 'get').mockReturnValue(sink as typeof process.stderr)
    const workers = await diagnosticWorkers()
    const h = deadlineHarness(true, workers.createLaneDeadline)
    try {
      h.appendLine.mockImplementation(() => { throw new Error('receipt unavailable') })
      vi.advanceTimersByTime(2000)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(uncaught, 'diagnostic stderr errors must not escape supervision').toEqual([])
      vi.advanceTimersByTime(5000)
      expect(h.current()).toMatchObject({ state: 'running', extensionCount: 1, decisionSource: 'grace-default' })
      expect(h.endGroup).not.toHaveBeenCalled()
      expect(sink.listenerCount('error')).toBe(1)
    } finally { h.cleanup(); workers.cleanup(); stderr.mockRestore(); sink.destroy() }
  })
})

describe('bounded diagnostic feedback', () => {
  it('reaches TERMINATION=idle despite repeated idle-state failures feeding the sampled log', async () => {
    const workers = await diagnosticWorkers()
    const h = deadlineHarness(false, workers.createLaneDeadline, 2)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { appendFileSync(h.log, String(chunk)); return true })
    const writeState = h.writeState.getMockImplementation()!
    try {
      h.writeState.mockImplementation((extra) => {
        if (extra.idle) throw new Error('idle state unavailable')
        writeState(extra)
      })
      vi.advanceTimersByTime(2250)
      expect(h.endGroup).not.toHaveBeenCalled()
      vi.advanceTimersByTime(250)
      expect(h.endGroup, 'silent lane must reach its idle stop after at most one diagnostic reset').toHaveBeenCalledWith(126, expect.objectContaining({ receiptLines: ['TERMINATION=idle'] }))
      expect(stderr).toHaveBeenCalledTimes(1)
      expect(readFileSync(h.log, 'utf8').match(/^wt-lane: idle state write failed:/gm)).toHaveLength(1)
      expect(readFileSync(h.log, 'utf8')).toContain('LANE_IDLE_STOP silentSeconds=2')
    } finally { stderr.mockRestore(); h.cleanup(); workers.cleanup() }
  })

  it('reports each distinct label once while continuing to retry writes', async () => {
    const workers = await diagnosticWorkers()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const write = vi.fn(() => { throw new Error('sink unavailable') })
    try {
      for (const label of ['first sink', 'first sink', 'second sink', 'second sink']) {
        expect(workers.bestEffortLaneDiagnostic(label, write)).toBe(false)
      }
      expect(write).toHaveBeenCalledTimes(4)
      expect(stderr).toHaveBeenCalledTimes(2)
      expect(workers.bestEffortLaneDiagnostic('first sink', () => true)).toBe(true)
    } finally { stderr.mockRestore(); workers.cleanup() }
  })
})

describe('deadline grace activity refresh', () => {
  it('extends instead of abandoning when a descendant appears during idle grace', () => {
    const h = deadlineHarness(false)
    try {
      vi.advanceTimersByTime(2000)
      expect(h.current()).toMatchObject({ state: 'decision-needed', defaultDecision: 'abandon' })
      h.readProcessSnapshot.mockReturnValue({ processes: [{ pid: 4, parentPid: 1 }, { pid: 5, parentPid: 4 }] })
      vi.advanceTimersByTime(5000)
      expect(h.current()).toMatchObject({ state: 'running', extensionCount: 1, decisionSource: 'grace-default' })
      expect(readFileSync(h.log, 'utf8')).toContain('LANE_EXTENDED count=1/3 source=grace-default')
      expect(h.endGroup).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })

  it('does not abandon at the deadline after a forward wall-clock jump', () => {
    const h = deadlineHarness(false)
    try {
      vi.advanceTimersByTime(1250)
      appendFileSync(h.log, 'child progress\n')
      vi.advanceTimersByTime(250)
      vi.setSystemTime(Date.now() + 3600_000)
      vi.advanceTimersByTime(500)
      expect(h.current()).toMatchObject({ state: 'decision-needed', defaultDecision: 'extend' })
      vi.advanceTimersByTime(5000)
      expect(h.current()).toMatchObject({ state: 'running', extensionCount: 1 })
      expect(h.endGroup).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })
})
