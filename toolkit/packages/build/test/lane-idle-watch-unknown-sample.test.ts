import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const { createBaseIdleWatch, createIdleWatch } = await import(new URL('../../../../plugin/bin/lib/host/lane-idle-worker.mjs', import.meta.url).href)
const { createLaneDeadline } = await import(new URL('../../../../plugin/bin/lib/host/lane-deadline-worker.mjs', import.meta.url).href)
const watches = [['CPU watch', createIdleWatch], ['base watch', createBaseIdleWatch]] as const

function unknownSnapshotHarness(createWatch = createIdleWatch, knownAtMs = 1375) {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(0)
  const root = mkdtempSync(join(tmpdir(), 'lane-unknown-sample-'))
  const log = join(root, 'run.log')
  writeFileSync(log, '')
  const readSnapshot = vi.fn((): unknown => performance.now() < knownAtMs
    ? { supported: false, reason: 'injected unavailable snapshot', processes: [] }
    : { processes: [{ pid: 4, ppid: 1, cpuTicks: 0 }] })
  const writeState = vi.fn()
  const stop = vi.fn()
  const options = {
    opts: { dir: root, log, idleWindow: 0.5, idleTimeout: 0, timeout: 1.5, decisionGrace: 5, maxExtensions: 1 },
    childPid: 4, launchedAtMs: 0, monotonicNow: () => performance.now(), readSnapshot, writeState, stop,
    latestWrite: () => ({ status: 'known', at: 0 }),
    appendLine: (line: string) => { appendFileSync(log, `${line}\n`); return true },
  }
  const watch = createWatch(options)
  const text = () => readFileSync(log, 'utf8')
  const cleanup = () => { watch.clear(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) }
  return { root, options, watch, readSnapshot, writeState, stop, text, cleanup }
}

function restartsAfterInitialUnknownCase(_name: string, createWatch: typeof createIdleWatch) {
  const h = unknownSnapshotHarness(createWatch)
  try {
    vi.advanceTimersByTime(1250)
    expect(h.writeState.mock.lastCall?.[0].idle).toMatchObject({ status: 'unknown', maxSilentSeconds: 0 })
    expect(h.text().match(/^LANE_IDLE_UNKNOWN /gm)).toHaveLength(1)
    vi.advanceTimersByTime(125)
    expect(h.writeState.mock.lastCall?.[0].idle).toMatchObject({ status: 'known', maxSilentSeconds: 0 })
    vi.advanceTimersByTime(425)
    expect(h.text()).not.toContain('LANE_IDLE_WARN')
    expect(h.writeState.mock.lastCall?.[0].idle.maxSilentSeconds).toBe(0.375)
    vi.advanceTimersByTime(74)
    expect(h.watch.refresh()).toMatchObject({ silentSeconds: 0.499, warn: false, stop: false })
    vi.advanceTimersByTime(1)
    expect(h.watch.refresh()).toMatchObject({ silentSeconds: 0.5, warn: true, stop: false })
    expect(h.text().match(/^LANE_IDLE_WARN /gm)).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(h.writeState.mock.lastCall?.[0].idle.maxSilentSeconds).toBeGreaterThan(1)
    expect(h.text().match(/^LANE_IDLE_WARN /gm)).toHaveLength(1)
    expect(h.stop).not.toHaveBeenCalled()
  } finally { h.cleanup() }
}

function discardsInterruptedWindowCase(_name: string, createWatch: typeof createIdleWatch) {
  const h = unknownSnapshotHarness(createWatch, 0)
  try {
    vi.advanceTimersByTime(375)
    expect(h.watch.refresh().silentSeconds).toBe(0.375)
    h.readSnapshot.mockReturnValue({ supported: false, reason: 'interrupted snapshot', processes: [] })
    vi.advanceTimersByTime(125)
    expect(h.watch.refresh()).toMatchObject({ silentSeconds: 0, warn: false })
    h.readSnapshot.mockReturnValue({ processes: [{ pid: 4, ppid: 1, cpuTicks: 0 }] })
    vi.advanceTimersByTime(125)
    expect(h.watch.refresh()).toMatchObject({ silentSeconds: 0, warn: false })
    vi.advanceTimersByTime(499)
    expect(h.text()).not.toContain('LANE_IDLE_WARN')
    vi.advanceTimersByTime(1)
    expect(h.text().match(/^LANE_IDLE_WARN /gm)).toHaveLength(1)
    expect(h.watch.refresh().silentSeconds).toBe(0.5)
  } finally { h.cleanup() }
}

function presenceOnlyEvidenceCase(_name: string, createWatch: typeof createIdleWatch) {
  const h = unknownSnapshotHarness(createWatch, 0)
  try {
    // macOS and Windows adapters return process presence without cpuTicks.
    h.readSnapshot.mockReturnValue({ processes: [{ pid: 4, ppid: 1 }] })
    h.watch.refresh()
    vi.advanceTimersByTime(2000)
    const base = createWatch === createBaseIdleWatch
    expect(h.writeState.mock.lastCall?.[0].idle.status).toBe(base ? 'known' : 'unknown')
    expect(h.text().match(/^LANE_IDLE_WARN /gm) ?? []).toHaveLength(base ? 1 : 0)
    if (!base) expect(h.writeState.mock.lastCall?.[0].idle.reason).toBe('process CPU time unavailable for pid 4')
    expect(h.stop).not.toHaveBeenCalled()
  } finally { h.cleanup() }
}

async function boundedExtensionsCase(knownAtMs: number) {
  const h = unknownSnapshotHarness(createBaseIdleWatch, knownAtMs)
  h.watch.clear()
  let state: Record<string, unknown> = { state: 'running', extensions: [] }
  const endGroup = vi.fn()
  const deadline = createLaneDeadline({
    ...h.options, runId: 'unknown-sample', child: { pid: 4 }, args: [], transitionBoundMs: 0,
    decisionFile: join(h.root, 'decision.json'), current: () => state,
    writeState: (extra: Record<string, unknown>) => { state = { ...state, ...extra } },
    modules: { latestWorktreeWrite: h.options.latestWrite, hostAdapter: { readProcessSnapshot: h.readSnapshot }, argvSummary: () => 'silent child', readLogTail: () => '', processEvidenceStatus: () => 'live' },
    journal: vi.fn(), cleanupBrief: vi.fn(), endGroup,
  })
  try {
    await vi.advanceTimersByTimeAsync(1500)
    expect(state).toMatchObject({ state: 'decision-needed', defaultDecision: 'extend' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(state).toMatchObject({ state: 'running', extensionCount: 1, decisionSource: 'grace-default' })
    expect(h.text()).toContain('LANE_EXTENDED count=1/1 source=grace-default')
    await vi.advanceTimersByTimeAsync(6500)
    expect(endGroup).toHaveBeenCalledWith(126, expect.objectContaining({ receiptLines: ['TERMINATION=timeout'] }))
  } finally { deadline.clear(); h.cleanup() }
}

describe('idle watchdog unknown-snapshot recovery', () => {
  it.each(watches)('%s restarts known silence after initially unknown samples', restartsAfterInitialUnknownCase)
  it.each(watches)('%s discards an interrupted known window and restarts on recovery', discardsInterruptedWindowCase)
  it.each(watches)('%s distinguishes presence-only snapshots from CPU evidence', presenceOnlyEvidenceCase)
  it.each([1375, Infinity])('bounds stalled-lane extensions when snapshots stay unknown until %sms', boundedExtensionsCase)
})
