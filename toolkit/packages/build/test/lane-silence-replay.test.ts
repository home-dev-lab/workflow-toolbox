import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error ESM runtime module
import { createLaneDeadline } from '../../../../plugin/bin/lib/host/lane-deadline-worker.mjs'
// @ts-expect-error ESM runtime module
import { createBrokerQueueState } from '../../../../plugin/bin/lib/host/lane-suite-queue.mjs'
// @ts-expect-error ESM runtime module
import { createSilenceTracker } from '../../../../plugin/bin/lib/host/lane-silence-worker.mjs'

function replayCpu(kind: string, now: number) {
  if (kind === 'throws') throw new Error('CPU read failed')
  if (kind === 'unknown') return { supported: false }
  const ticks = kind === 'busy' ? now * 0.03 : kind === 'old-burst' ? Math.min(now, 300000) : Math.floor(now / 5520000 * 4500)
  const rootTicks = kind === 'reaped' && now >= 4800000 ? 1000000 : 0
  const child = kind === 'reaped' && now >= 4800000 ? [] : [{ pid: 5, ppid: 4, command: 'opencode', startIdentity: 2, cpuTicks: kind === 'reaped' ? 1000000 : ticks }]
  return { processes: [{ pid: 4, ppid: 1, command: 'bwrap', startIdentity: 1, cpuTicks: rootTicks }, ...child] }
}

function replay(kind = 'silent', maxExtensions = 3, idleTimeout = 0) {
  vi.useFakeTimers()
  let now = 0, watchTick = () => {}, brokerStatus = 'running'
  const setWatchInterval = globalThis.setInterval
  vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
    watchTick = callback as () => void
    return setWatchInterval(() => {}, 1e9)
  })
  const root = mkdtempSync(join(tmpdir(), 'lane-silence-'))
  const log = join(root, 'run.log'); writeFileSync(log, 'last lane output\n')
  let state: Record<string, unknown> = { extensions: [] }
  const records: Record<string, unknown>[] = []
  const cpu = () => replayCpu(kind, now)
  const authorizeTimeout = vi.fn(async () => ({ terminate: kind !== 'protected' }))
  const endGroup = vi.fn((_code, result) => { state = { ...state, ...result.terminal } })
  const child = { pid: 4, laneSandbox: { suiteBroker: kind === 'no-broker' ? null : { connected: true }, endpoints: kind === 'relayed' ? [{ host: '127.0.0.1', port: 1234 }] : [] } }
  const deadline = createLaneDeadline({ child, childPid: 4, args: [], runId: 'replay', launchedAtMs: 0, transitionBoundMs: 0,
    opts: { dir: root, log, timeout: 5400, decisionGrace: 300, idleWindow: 1200, idleTimeout, maxExtensions },
    monotonicNow: () => now, decisionFile: join(root, 'decision.json'), readSilenceSnapshot: cpu,
    readSuiteQueue: async () => ({ runId: 'replay', status: brokerStatus, inFlight: kind === 'offload' ? 1 : 0, since: Date.now(), observedAt: Date.now(), queuedMs: 0 }),
    authorizeTimeout, cancelTimeout: async () => ({ cancelled: true }), current: () => state,
    writeState: (extra: Record<string, unknown>) => { state = { ...state, ...extra }; records.push(state) },
    appendLine: (line: string) => { appendFileSync(log, `${line}\n`); return true }, endGroup, cleanupBrief() {}, journal() {},
    modules: { latestWorktreeWrite: () => kind === 'worktree' ? { status: 'known', at: now, fingerprint: String(now) } : { at: null, bounded: true, status: 'unknown' }, hostAdapter: { readProcessSnapshot: cpu }, argvSummary: () => ['bwrap', 'opencode'], readLogTail: () => 'last lane output', processEvidenceStatus: () => 'live' },
  })
  const advance = async (until: number) => {
    while (now < until) {
      now += 60000
      brokerStatus = kind === 'queued' ? 'queued' : 'running'
      if (kind === 'growth' || (kind === 'resumed' && now > 5400000)) appendFileSync(log, 'lane output\n')
      watchTick()
      await vi.advanceTimersByTimeAsync(100)
    }
  }
  const cleanup = () => { deadline.clear(); vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) }
  return { advance, cleanup, records, state: () => state, text: () => readFileSync(log, 'utf8'), endGroup, authorizeTimeout }
}

describe('bounded-worktree silence replay', () => {
  it('abandons the flat-log low-CPU replay through timeout authorization, without extensions', async () => {
    const h = replay()
    try {
      await h.advance(5400000)
      expect(h.state()).toMatchObject({ state: 'decision-needed', defaultDecision: 'abandon', idle: { status: 'unknown', maxSilentSeconds: 0, reason: 'worktree scan bounded or unknown' }, evidence: { activityBounded: true, silence: { status: 'silent' } } })
      expect(h.text()).toContain('LANE_NOT_EXTENDED reason=silent')
      await h.advance(5700000)
      expect(h.state()).toMatchObject({ state: 'abandoned', extensionCount: 0, extensions: [] })
      expect(h.authorizeTimeout).toHaveBeenCalledTimes(1)
      expect(h.endGroup).toHaveBeenCalledWith(126, expect.objectContaining({ receiptLines: ['TERMINATION=timeout'] }))
    } finally { h.cleanup() }
  })
  it.each(['growth', 'worktree', 'busy', 'unknown', 'offload', 'no-broker', 'relayed', 'throws', 'queued'])('protects %s activity or uncertainty', async (kind) => {
    const h = replay(kind)
    try {
      await h.advance(5400000)
      if (kind === 'queued') expect(h.state().state).toBe('running')
      else expect(h.state()).toMatchObject({ defaultDecision: 'extend' })
      if (['unknown', 'no-broker', 'relayed', 'throws'].includes(kind)) expect(h.text()).toContain('silence=log-silent')
      expect(h.endGroup).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })
})

describe('silence grace, CPU accounting and broker state', () => {
  it.each(['old-burst', 'reaped'])('does not count %s CPU in the trailing window', async (kind) => {
    const h = replay(kind)
    try { await h.advance(5400000); expect(h.state()).toMatchObject({ defaultDecision: 'abandon', evidence: { silence: { cpuFraction: 0, status: 'silent' } } }) }
    finally { h.cleanup() }
  })
  it('rechecks activity during grace', async () => {
    const h = replay('resumed')
    try {
      await h.advance(5400000); expect(h.state().defaultDecision).toBe('abandon')
      await h.advance(5700000); expect(h.state()).toMatchObject({ state: 'running', extensionCount: 1 })
      expect(h.endGroup).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })
  it('uses the separate silence channel with opt-in idle enforcement too', async () => {
    const h = replay('silent', 3, 999999)
    try {
      await h.advance(5700000)
      expect(h.state()).toMatchObject({ state: 'abandoned', extensionCount: 0, evidence: { silence: { status: 'silent' } } })
      expect(h.text()).not.toContain('LANE_IDLE_STOP')
    } finally { h.cleanup() }
  })
  it('preserves holder protection and the extension ceiling', async () => {
    const h = replay('protected')
    try { await h.advance(5700000); expect(h.authorizeTimeout).toHaveBeenCalled(); expect(h.endGroup).not.toHaveBeenCalled() }
    finally { h.cleanup() }
    const capped = replay('busy', 0)
    try { await capped.advance(5700000); expect(capped.state()).toMatchObject({ state: 'abandoned', extensionCount: 0 }) }
    finally { capped.cleanup() }
  })
  it('reports every in-flight phase, including acquiring offloads', () => {
    const queue = createBrokerQueueState('run')
    expect(queue.snapshot('run').inFlight).toBe(0)
    const request = queue.track()
    expect(queue.snapshot('run')).toMatchObject({ status: 'running', inFlight: 1 })
    request.waiting(); expect(queue.snapshot('run')).toMatchObject({ status: 'queued', inFlight: 1 })
    request.holding(); expect(queue.snapshot('run')).toMatchObject({ status: 'running', inFlight: 1 })
    request.done(); expect(queue.snapshot('run').inFlight).toBe(0)
  })
})

function tracker() {
  let now = 0
  const readSilenceSnapshot = vi.fn((): unknown => ({ processes: [{ pid: 4, ppid: 1, startIdentity: 1, cpuTicks: 0 }] }))
  const watch = createSilenceTracker({ opts: { idleWindow: 1, log: 'run.log' }, childPid: 4, monotonicNow: () => now, readSilenceSnapshot }, 0)
  const sample = (at: number, size: number | null = 0) => { now = at; watch.observe({ size, worktree: { status: 'unknown', bounded: true } }, now); return watch.verdict() }
  return { watch, sample, readSilenceSnapshot }
}

describe('silence tracker uncertainty and identities', () => {
  it('never certifies an unreadable run log', () => {
    const h = tracker(); h.sample(0)
    expect(h.sample(1000, null)).toMatchObject({ status: 'log-silent', reason: 'run log size unavailable' })
  })
  it('does not count a receipt as worktree activity when the newest file is the run log', () => {
    const h = tracker(); h.sample(0)
    h.watch.receipt(100)
    h.sample(1000, 100)
    h.watch.observe({ size: 100, worktree: { status: 'known', at: 1000, path: 'run.log' } }, 1000)
    expect(h.watch.verdict().status).toBe('silent')
  })
  it('observes known fingerprint changes even behind an unchanged maximum timestamp', () => {
    const h = tracker(); h.sample(0)
    h.watch.observe({ size: 0, worktree: { status: 'known', at: 1, fingerprint: 'first' } }, 0)
    h.sample(500)
    h.watch.observe({ size: 0, worktree: { status: 'known', at: 1, fingerprint: 'second' } }, 500)
    expect(h.sample(1000).status).toBe('active')
  })
})

describe('silence tracker CPU baselines and recovery', () => {
  it('does not count receipts as output or reset CPU baselines on activity', () => {
    const h = tracker(); h.sample(0)
    h.watch.receipt(100); expect(h.sample(1000, 100).status).toBe('silent')
    h.watch.markActivity('suite'); expect(h.watch.verdict().status).toBe('active')
    h.readSilenceSnapshot.mockReturnValue({ processes: [{ pid: 4, ppid: 1, startIdentity: 1, cpuTicks: 30 }] })
    expect(h.sample(2000, 100)).toMatchObject({ status: 'active', cpuFraction: 0.3 })
  })
  it('counts a reused PID from zero rather than the prior identity', () => {
    const h = tracker()
    h.readSilenceSnapshot.mockReturnValue({ processes: [{ pid: 4, ppid: 1, startIdentity: 1, cpuTicks: 1000 }] })
    h.sample(0)
    h.readSilenceSnapshot.mockReturnValue({ processes: [{ pid: 4, ppid: 1, startIdentity: 2, cpuTicks: 30 }] })
    expect(h.sample(1000)).toMatchObject({ status: 'active', cpuFraction: 0.3 })
  })
  it('keeps a read error unknown until it leaves the trailing window', () => {
    const h = tracker(); h.sample(0)
    h.readSilenceSnapshot.mockImplementationOnce(() => { throw new Error('unreadable') })
    expect(h.sample(500).status).toBe('active')
    expect(h.sample(1000).status).toBe('log-silent')
    h.sample(1500)
    expect(h.sample(2000).status).toBe('silent')
  })
})
