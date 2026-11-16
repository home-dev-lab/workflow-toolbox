import { appendFileSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
const { createLaneDeadline } = await import(process.env.WT_SILENCE_DEADLINE_MODULE ?? new URL('../../../../plugin/bin/lib/host/lane-deadline-worker.mjs', import.meta.url).href)
// @ts-expect-error ESM runtime module
import { createBrokerQueueState } from '../../../../plugin/bin/lib/host/lane-suite-queue.mjs'
// @ts-expect-error ESM runtime module
import { createSilenceTracker } from '../../../../plugin/bin/lib/host/lane-silence-worker.mjs'
// @ts-expect-error ESM runtime module
import { createBaseIdleWatch, createIdleWatch } from '../../../../plugin/bin/lib/host/lane-idle-worker.mjs'

function replayTicks(kind: string, now: number) {
  return kind === 'busy' ? now * 0.03 : kind === 'cooled' ? 162000 : kind === 'old-burst' ? Math.min(now, 300000) : Math.floor(now / 5520000 * 4500)
}

function replayCpu(kind: string, now: number) {
  if (kind === 'throws') throw new Error('CPU read failed')
  if (kind === 'unknown') return { supported: false }
  const ticks = replayTicks(kind, now)
  const rootTicks = kind === 'reaped' && now >= 4800000 ? 1000000 : 0
  const child = kind === 'legacy' || (kind === 'reaped' && now >= 4800000) ? [] : [{ pid: 5, ppid: 4, command: 'opencode', startIdentity: 2, cpuTicks: kind === 'reaped' ? 1000000 : ticks }]
  return { processes: [{ pid: 4, ppid: 1, command: 'bwrap', startIdentity: 1, cpuTicks: rootTicks }, ...child] }
}

function replay(kind = 'silent', maxExtensions = 3, idleTimeout = 0, decisionGrace = 300) {
  vi.useFakeTimers()
  let now = 0, watchTick = () => {}, brokerStatus = 'running'
  const setWatchInterval = globalThis.setInterval
  vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
    watchTick = callback as () => void
    return setWatchInterval(() => {}, 1e9)
  })
  const root = mkdtempSync(join(tmpdir(), 'lane-silence-'))
  const log = join(root, 'run.log'); writeFileSync(log, 'last lane output\n')
  if (kind === 'fingerprint') { writeFileSync(join(root, 'future'), 'fixed'); utimesSync(join(root, 'future'), 2e9, 2e9); writeFileSync(join(root, 'editing'), '') }
  let state: Record<string, unknown> = { extensions: [] }
  const records: Record<string, unknown>[] = []
  const cpu = () => replayCpu(kind, now)
  const authorizeTimeout = vi.fn(async () => ({ terminate: kind !== 'protected' }))
  const endGroup = vi.fn((_code, result) => { state = { ...state, ...result.terminal } })
  const child = { pid: 4, laneSandbox: { suiteBroker: kind === 'no-broker' ? null : { connected: true }, endpoints: kind === 'relayed' ? [{ host: '127.0.0.1', port: 1234 }] : [] } }
  const deadline = createLaneDeadline({ child, childPid: 4, args: [], runId: 'replay', launchedAtMs: 0, transitionBoundMs: 0,
    opts: { dir: root, log, timeout: 5400, decisionGrace, idleWindow: 1200, idleTimeout, maxExtensions },
    monotonicNow: () => now, decisionFile: join(root, 'decision.json'), readSilenceSnapshot: cpu,
    readSuiteQueue: async () => ({ runId: 'replay', status: brokerStatus, inFlight: kind === 'offload' ? 1 : 0, since: Date.now(), observedAt: Date.now(), queuedMs: 0 }),
    authorizeTimeout, cancelTimeout: async () => ({ cancelled: true }), current: () => state,
    writeState: (extra: Record<string, unknown>) => { state = { ...state, ...extra }; records.push(state) },
    appendLine: (line: string) => { appendFileSync(log, `${line}\n`); return true }, endGroup, cleanupBrief() {}, journal() {},
    modules: { latestWorktreeWrite: () => kind === 'legacy' || kind === 'fingerprint' ? { status: 'known', at: 2e12 } : kind === 'worktree' ? { status: 'known', at: now, fingerprint: String(now) } : { at: null, bounded: true, status: 'unknown' }, hostAdapter: { readProcessSnapshot: cpu }, argvSummary: () => ['bwrap', 'opencode'], readLogTail: () => 'last lane output', processEvidenceStatus: () => 'live' },
  })
  const advance = async (until: number) => {
    while (now < until) {
      now += 60000
      brokerStatus = kind === 'queued' ? 'queued' : 'running'
      if (kind === 'growth' || (kind === 'resumed' && now > 5400000)) appendFileSync(log, 'lane output\n')
      if (kind === 'fingerprint') appendFileSync(join(root, 'editing'), 'edit\n')
      watchTick()
      await vi.advanceTimersByTimeAsync(100)
    }
  }
  const cleanup = () => { deadline.clear(); vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) }
  const jump = async (at: number, output = '') => { now = at; if (output) appendFileSync(log, output); await vi.advanceTimersByTimeAsync(100) }
  return { advance, jump, setKind: (next: string) => { kind = next }, cleanup, records, state: () => state, text: () => readFileSync(log, 'utf8'), endGroup, authorizeTimeout }
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
      await h.advance(5700000)
      expect(h.endGroup).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })
})

describe('silence grace, CPU accounting and broker state', () => {
  it.each(['old-burst'])('does not count %s CPU in the trailing window', async (kind) => {
    const h = replay(kind)
    try { await h.advance(5400000); expect(h.state()).toMatchObject({ defaultDecision: 'abandon', evidence: { silence: { cpuFraction: 0, status: 'silent' } } }) }
    finally { h.cleanup() }
  })
  it('protects a reaped family until the membership change leaves the window', async () => {
    const h = replay('reaped')
    try { await h.advance(5700000); expect(h.state()).toMatchObject({ state: 'running', extensionCount: 1 }); expect(h.endGroup).not.toHaveBeenCalled() }
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
})

describe('in-flight broker phases', () => {
  it('reports every in-flight phase, including acquiring offloads', () => {
    const queue = createBrokerQueueState('run')
    expect(queue.snapshot('run').inFlight).toBe(0)
    const request = queue.track()
    expect(queue.snapshot('run')).toMatchObject({ status: 'running', inFlight: 1 })
    request.waiting(); expect(queue.snapshot('run')).toMatchObject({ status: 'queued', inFlight: 1 })
     request.holding(); expect(queue.snapshot('run')).toMatchObject({ status: 'running', inFlight: 1 })
     request.requeued(); expect(queue.snapshot('run')).toMatchObject({ status: 'queued', inFlight: 1 })
     request.releasing(); expect(queue.snapshot('run')).toMatchObject({ status: 'running', inFlight: 1 })
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
  it('keeps known fingerprint changes when the newest path cannot be resolved', () => {
    const h = tracker(); h.sample(0)
    h.watch.observe({ size: 0, worktree: { status: 'known', at: 1, fingerprint: 'first', path: 'run.log' } }, 0)
    h.watch.observe({ size: 0, worktree: { status: 'known', at: 1, fingerprint: 'second', path: 'run.log' } }, 500)
    expect(h.sample(1000).status).toBe('active')
  })
  it('observes known fingerprint changes even behind an unchanged maximum timestamp', () => {
    const h = tracker(); h.sample(0)
    h.watch.observe({ size: 0, worktree: { status: 'known', at: 1, fingerprint: 'first' } }, 0)
    h.sample(500)
    h.watch.observe({ size: 0, worktree: { status: 'known', at: 1, fingerprint: 'second' } }, 500)
    expect(h.sample(1000).status).toBe('active')
  })
})

function logTracker() {
  const root = mkdtempSync(join(tmpdir(), 'lane-silence-newest-')), log = join(root, 'run.log')
  writeFileSync(log, '')
  const watch = createSilenceTracker({ opts: { idleWindow: 1, log }, childPid: 4, monotonicNow: () => 0, readSilenceSnapshot: () => ({ processes: [{ pid: 4, ppid: 1, startIdentity: 1, cpuTicks: 0 }] }) }, 0)
  return { watch, log, done: () => rmSync(root, { recursive: true, force: true }) }
}

describe('silence tracker review round 2', () => {
  it('keeps a fingerprint change visible when the newest file is the real log itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'lane-silence-alias-')), log = join(root, 'run.log')
    writeFileSync(log, '')
    let now = 0
    const watch = createSilenceTracker({ opts: { idleWindow: 1, log }, childPid: 4, monotonicNow: () => now, readSilenceSnapshot: () => ({ processes: [{ pid: 4, ppid: 1, startIdentity: 1, cpuTicks: 0 }] }) }, 0)
    try {
      watch.observe({ size: 0, worktree: { status: 'known', at: 1, fingerprint: 'first', path: log } }, 0)
      now = 500; watch.observe({ size: 0, worktree: { status: 'known', at: 1, fingerprint: 'second', path: log } }, 500)
      now = 1000; watch.observe({ size: 0, worktree: { status: 'known', at: 1, fingerprint: 'second', path: log } }, 1000)
      expect(watch.verdict().status).toBe('active')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('ignores a moved log mtime when the log is newest and its fingerprint is unchanged', () => {
    const { watch, log, done } = logTracker()
    try {
      for (const [at, mtime] of [[0, 1], [500, 2], [1200, 3]]) watch.observe({ size: 0, worktree: { status: 'known', at: mtime, fingerprint: 'same', path: log } }, at)
      expect(watch.verdict()).toMatchObject({ status: 'silent' })
    } finally { done() }
  })
  it('does not count a first log-newest scan without a fingerprint as activity', () => {
    const { watch, log, done } = logTracker()
    try {
      watch.observe({ size: 0, worktree: { status: 'unknown', bounded: true } }, 0)
      for (const at of [500, 1200]) watch.observe({ size: 0, worktree: { status: 'known', at, path: log } }, at)
      expect(watch.verdict()).toMatchObject({ status: 'silent' })
    } finally { done() }
  })
  it('does not count a switch of the newest path between the log and another file as activity', () => {
    const { watch, log, done } = logTracker()
    try {
      for (const at of [0, 250, 500, 750, 1000, 1250]) watch.observe({ size: 0, worktree: { status: 'known', at: 1, fingerprint: 'F', path: at % 500 === 0 ? join(log, '..', 'other') : log } }, at)
      expect(watch.verdict()).toMatchObject({ status: 'silent' })
    } finally { done() }
  })
})

describe('silence tracker review round 2, newest time and CPU window', () => {
  it('counts a moving newest time as activity when the newest file is not the log and no fingerprint exists', () => {
    const { watch, log, done } = logTracker()
    try {
      for (const at of [0, 500, 1000]) watch.observe({ size: 0, worktree: { status: 'known', at: at + 1, path: join(log, '..', 'other') } }, at)
      expect(watch.verdict()).toMatchObject({ status: 'active' })
    } finally { done() }
  })
  it('does not let old CPU leave the trailing window on a clock advance with no new sample', () => {
    let now = 0, ticks = 0
    const watch = createSilenceTracker({ opts: { idleWindow: 1, log: 'run.log' }, childPid: 4, monotonicNow: () => now, readSilenceSnapshot: () => ({ processes: [{ pid: 4, ppid: 1, startIdentity: 1, cpuTicks: ticks }] }) }, 0)
    for (const [at, cpu] of [[0, 0], [250, 5], [500, 5], [750, 5], [1050, 5]] as Array<[number, number]>) { now = at; ticks = cpu; watch.observe({ size: 0, worktree: { status: 'unknown', bounded: true } }, at) }
    expect(watch.verdict()).toMatchObject({ status: 'active', reason: 'family CPU active in trailing window' })
    now = 1251
    expect(watch.verdict()).toMatchObject({ status: 'active', reason: 'family CPU active in trailing window', cpuFraction: 0.05 })
    for (const at of [1300, 1550, 1800, 2050, 2300]) { now = at; watch.observe({ size: 0, worktree: { status: 'unknown', bounded: true } }, at) }
    expect(watch.verdict().status).toBe('silent')
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
    expect(h.sample(1000)).toMatchObject({ status: 'active', cpuFraction: 0, reason: 'process family changed in trailing window' })
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

describe('grace decisions between observation ticks', () => {
  it('uses installed opt-in fingerprints despite a fixed deadline maximum timestamp', async () => {
    const h = replay('fingerprint', 3, 999999)
    try {
      await h.advance(5400000); expect(h.state()).toMatchObject({ defaultDecision: 'extend', evidence: { silence: { status: 'active' } } })
      await h.advance(5700000); expect(h.endGroup).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })
  it.each([0, 999999])('reads child output after the last tick at grace expiry, idleTimeout=%s', async (idleTimeout) => {
    const h = replay('silent', 3, idleTimeout, 1)
    try {
      await h.advance(5400000); expect(h.state().defaultDecision).toBe('abandon')
      await h.jump(5401000, 'resumed between ticks\n')
      expect(h.state()).toMatchObject({ state: 'running', extensionCount: 1 })
      expect(h.endGroup).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })
  it('keeps an advertised extend when CPU becomes silent during grace', async () => {
    const h = replay('busy', 3, 0, 1500)
    try {
      await h.advance(5400000); expect(h.state().defaultDecision).toBe('extend')
      h.setKind('cooled'); await h.advance(6900000)
      expect(h.state()).toMatchObject({ state: 'running', extensionCount: 1 })
      expect(h.endGroup).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })
})

describe('legacy idle grace retries', () => {
  it('refreshes the legacy idle warning on each protected grace attempt', async () => {
    const h = replay('legacy', 3, 0, 1)
    try {
      h.authorizeTimeout.mockResolvedValue({ terminate: false })
      await h.advance(5400000); expect(h.state().defaultDecision).toBe('abandon')
      await h.jump(5401000); expect(h.authorizeTimeout).toHaveBeenCalledTimes(1)
      h.authorizeTimeout.mockResolvedValue({ terminate: true })
      await h.jump(5401100, 'legacy output resumes\n')
      expect(h.state()).toMatchObject({ state: 'running', extensionCount: 1 })
      expect(h.endGroup).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })
})

function familyRows(childTicks: number, parentTicks = 0, state = 'S') {
  return { processes: [{ pid: 4, ppid: 1, startIdentity: 1, cpuTicks: parentTicks }, { pid: 5, ppid: 4, startIdentity: 2, cpuTicks: childTicks, state }] }
}

describe('stable CPU family certification', () => {
  it('does not erase parent CPU when a child turns zombie', () => {
    const h = tracker(); h.readSilenceSnapshot.mockReturnValue(familyRows(100000)); h.sample(0)
    h.readSilenceSnapshot.mockReturnValue(familyRows(100000, 30, 'Z'))
    expect(h.sample(1000)).toMatchObject({ status: 'active', cpuFraction: 0.3, reason: 'process family changed in trailing window' })
  })
  it('protects zombie then delayed reap until the changed anchor leaves the window', () => {
    const h = tracker(); h.readSilenceSnapshot.mockReturnValue(familyRows(100000)); h.sample(0)
    h.readSilenceSnapshot.mockReturnValue(familyRows(100000, 0, 'Z')); h.sample(500)
    h.readSilenceSnapshot.mockReturnValue(familyRows(100000, 100000, 'Z'))
    expect(h.sample(1000)).toMatchObject({ status: 'active', reason: 'process family changed in trailing window' })
    h.sample(1500); expect(h.sample(2000).status).toBe('silent')
  })
  it('prunes vanished identities rather than retaining an old lower-bound counter', () => {
    const h = tracker(); h.readSilenceSnapshot.mockReturnValue(familyRows(100000)); h.sample(0)
    h.readSilenceSnapshot.mockReturnValue(familyRows(100000, 0, 'Z')); h.sample(500)
    h.readSilenceSnapshot.mockReturnValue(familyRows(0)); h.sample(1000)
    h.sample(1500); expect(h.sample(2000).status).toBe('silent')
  })
})

function receiptWatch(factory: typeof createIdleWatch, alias: string) {
  const root = mkdtempSync(join(tmpdir(), 'lane-receipts-')), log = join(root, 'run.log'), newest = join(root, 'alias')
  writeFileSync(log, '')
  if (alias === 'hardlink') linkSync(log, newest)
  else symlinkSync(log, newest)
  let now = 0
  const watch = factory({ opts: { dir: root, log, idleWindow: 1, idleTimeout: 0 }, childPid: 4, launchedAtMs: 0,
    monotonicNow: () => now, latestWrite: () => ({ status: 'known', at: now, path: newest }),
    readSnapshot: () => familyRows(0), writeState() {}, stop() {}, appendLine: (line: string) => { appendFileSync(log, `${line}\n`); return true } })
  return { watch, advance: () => { now += 1000; watch.refresh() }, cleanup: () => { watch.clear(); rmSync(root, { recursive: true, force: true }) } }
}

describe('watch receipt emitters and log aliases', () => {
  it.each([['base', createBaseIdleWatch], ['idle', createIdleWatch]])('%s ignores hardlink and symlink receipts through its emitter', (_name, factory) => {
    for (const alias of ['hardlink', 'symlink']) {
      const h = receiptWatch(factory, alias)
      try { h.watch.emit('supervisor receipt'); h.advance(); expect(h.watch.silence().status).toBe('silent') }
      finally { h.cleanup() }
    }
  })
})
