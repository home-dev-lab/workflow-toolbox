import { appendFileSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const lib = process.env.WT_IDLE_REVIEW_LIB ?? new URL('../../../../plugin/bin/lib/', import.meta.url).href
const { readLinuxIdleProcProcesses: readLinuxProcProcesses } = await import(new URL('host/linux.mjs', lib).href)
const { createIdleWatch } = await import(new URL('host/lane-idle-worker.mjs', lib).href)
const { createLaneDeadline } = await import(new URL('host/lane-deadline-worker.mjs', lib).href)
const { latestWorktreeWrite } = await import(new URL('lane-supervisor-core.mjs', lib).href)
const { activityEvidence } = await import(new URL('lane-deadline-core.mjs', lib).href)
const scanner = await import(new URL('host/lane-worktree-scan.mjs', lib).href)

// Fall back only for the pre-fix red run, so the exact old scanner is exercised.
const idleScan = scanner.scanIdleWorktree ?? scanner.scanWorktree

function procSnapshot(childUser = '0', childSystem = '0', parent = '4', { readLink = () => String(process.pid), state = 'S' } = {}) {
  return readLinuxProcProcesses({
    readLink,
    readDirectory: () => ['4', '5'].map((name) => ({ name, isDirectory: () => true })),
    observedAt: 20_000,
    readFile: (file: string) => {
      if (file === '/proc/uptime') return '10 1\n'
      if (file.endsWith('/cmdline')) return 'model\0'
      const pid = file.split('/')[2]
      const fields = [pid === '4' ? 'S' : state, pid === '4' ? '1' : parent, ...Array<string>(18).fill('0')]
      fields[13] = pid === '4' ? childUser : '0'
      fields[14] = pid === '4' ? childSystem : '0'
      fields[19] = '100'
      return `${pid} (model) ${fields.join(' ')}\n`
    },
  })
}

function harness(idleTimeout = 8, snapshot = procSnapshot('0', '0', '1')) {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(0)
  const root = mkdtempSync(join(tmpdir(), 'lane-idle-review-'))
  const worktree = join(root, 'worktree')
  mkdirSync(worktree)
  const log = join(root, 'run.log')
  writeFileSync(log, '')
  const stop = vi.fn()
  const writeState = vi.fn()
  const latestWrite = vi.fn(() => latestWorktreeWrite(worktree))
  // Silent filesystem controls have no lane descendant; presence cases supply their family.
  const readSnapshot = vi.fn(() => snapshot)
  const opts = { dir: worktree, log, idleWindow: 4, idleTimeout, timeout: 2, decisionGrace: 5, maxExtensions: 3 }
  const options = { opts, childPid: 4, launchedAtMs: 0, monotonicNow: () => performance.now(), readSnapshot, latestWrite, stop, writeState, appendLine: (line: string) => { appendFileSync(log, `${line}\n`); return true } }
  const watch = createIdleWatch(options)
  const cleanup = () => { watch.clear(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) }
  return { root, worktree, log, stop, writeState, readSnapshot, latestWrite, watch, options, cleanup }
}

describe('idle proc namespace validation', () => {
  it.each(['mismatch', 'unreadable', 'malformed'])('names %s proc self evidence unknown and never stops', (kind) => {
    const readLink = vi.fn(() => {
      if (kind === 'unreadable') throw Object.assign(new Error('no proc'), { code: 'ENOENT' })
      return kind === 'mismatch' ? String(process.pid + 1) : 'not-a-pid'
    })
    const snapshot = procSnapshot('0', '0', '1', { readLink })
    const h = harness(8, snapshot)
    try {
      vi.advanceTimersByTime(20_000)
      expect(h.writeState.mock.lastCall?.[0].idle).toMatchObject({ status: 'unknown', reason: expect.stringContaining('/proc PID namespace mismatch') })
      expect(h.stop).not.toHaveBeenCalled()
      expect(readFileSync(h.log, 'utf8')).not.toMatch(/LANE_IDLE_(WARN|STOP)/)
      expect(readLink).toHaveBeenCalledWith('/proc/self')
    } finally { h.cleanup() }
  })

  it('keeps matching proc self evidence known and stops a silent descendant-free lane', () => {
    const readLink = vi.fn(() => String(process.pid))
    const snapshot = procSnapshot('0', '0', '1', { readLink })
    expect(snapshot).toEqual(procSnapshot('0', '0', '1'))
    expect(activityEvidence({ snapshot, rootPid: 4, worktree: { status: 'known' } }).status).toBe('known')
    const h = harness(8, snapshot)
    try {
      vi.advanceTimersByTime(8000)
      expect(h.stop).toHaveBeenCalledTimes(1)
      expect(readFileSync(h.log, 'utf8')).toContain('LANE_IDLE_STOP silentSeconds=8')
      expect(readLink).toHaveBeenCalledWith('/proc/self')
    } finally { h.cleanup() }
  })

  it('accepts PID 1 PPID 0 in CPU evidence without exempting other missing parents', () => {
    const processes = [{ pid: 1, ppid: 0, cpuTicks: 0 }, { pid: 4, ppid: 1, cpuTicks: 0 }]
    const input = { snapshot: { processes }, rootPid: 4, worktree: { status: 'known' } }
    expect(activityEvidence(input)).toMatchObject({ status: 'known', descendants: [], cpuTimes: [{ pid: 4, cpuTicks: 0 }] })
    processes[0] = { pid: 5, ppid: 0, cpuTicks: 0 }
    expect(activityEvidence(input)).toMatchObject({ status: 'unknown', reason: 'process snapshot contains unreadable ancestry' })
  })
})

describe('idle living descendant states', () => {
  it.each(['Z', 'X'])('stops with only a %s descendant while the deadline still counts its presence', (state) => {
    const snapshot = procSnapshot('0', '0', '4', { state })
    expect(snapshot.processes.find((row: { pid: number }) => row.pid === 5)).toMatchObject({ state })
    const input = { snapshot, rootPid: 4, worktree: { status: 'known' } }
    expect(activityEvidence({ ...input, requireCpu: false })).toMatchObject({ status: 'known', descendants: [5] })
    const h = harness(8, snapshot)
    try {
      vi.advanceTimersByTime(8000)
      expect(h.stop).toHaveBeenCalledTimes(1)
      expect(readFileSync(h.log, 'utf8')).toContain('LANE_IDLE_WARN silentSeconds=4')
      expect(readFileSync(h.log, 'utf8')).toContain('LANE_IDLE_STOP silentSeconds=8')
      expect(activityEvidence(input)).toMatchObject({ status: 'known', descendants: [] })
    } finally { h.cleanup() }
  })

  it('keeps a living sleeping descendant protected with unchanged CPU counters', () => {
    const h = harness(8, procSnapshot())
    try {
      vi.advanceTimersByTime(24_000)
      expect(h.writeState.mock.lastCall?.[0].idle.status).toBe('known')
      expect(h.stop).not.toHaveBeenCalled()
      expect(readFileSync(h.log, 'utf8')).not.toMatch(/LANE_IDLE_(WARN|STOP)/)
    } finally { h.cleanup() }
  })
})

describe('idle review counterexamples', () => {
  it('counts CPU of reaped children between samples as progress', () => {
    const h = harness()
    try {
      h.readSnapshot.mockImplementation(() => procSnapshot(String(performance.now()), String(performance.now() / 2)))
      vi.advanceTimersByTime(20_000)
      expect(readFileSync(h.log, 'utf8'), 'reaped-child CPU must prevent idle warnings').not.toContain('LANE_IDLE_WARN')
      expect(h.stop).not.toHaveBeenCalled()
      h.readSnapshot.mockReturnValue(procSnapshot('20000', '10000'))
      vi.advanceTimersByTime(8000)
      expect(h.stop).not.toHaveBeenCalled()
      h.readSnapshot.mockReturnValue(procSnapshot('20000', '10000', '1'))
      vi.advanceTimersByTime(7750)
      expect(h.stop).not.toHaveBeenCalled()
      vi.advanceTimersByTime(250)
      expect(h.stop).toHaveBeenCalledTimes(1)
    } finally { h.cleanup() }
  })

  it.each(['bad', '-1', '9007199254740992'])('does not certify invalid waited-child CPU %s', (counter) => {
    const snapshot = procSnapshot(counter)
    expect(activityEvidence({ snapshot, worktree: { status: 'known' }, rootPid: 4 })).toMatchObject({ status: 'unknown' })
  })
})

describe('round-three activity union', () => {
  it.each([-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects injected non-positive or unsafe PPID %s', (ppid) => {
    const snapshot = { processes: [{ pid: 4, ppid: 1, cpuTicks: 0 }, { pid: 5, ppid, cpuTicks: 100 }] }
    expect(activityEvidence({ snapshot, rootPid: 4, worktree: { status: 'known' } })).toMatchObject({ status: 'unknown', reason: 'process snapshot contains unreadable ancestry' })
  })

  it('counts auto-reaped family fault counters between polls', () => {
    const h = harness()
    try {
      h.readSnapshot.mockImplementation(() => ({ processes: [{ pid: 4, ppid: 1, cpuTicks: 0, startIdentity: 100, activityTicks: performance.now() }] }))
      vi.advanceTimersByTime(20_000)
      expect(h.stop).not.toHaveBeenCalled()
      expect(readFileSync(h.log, 'utf8')).not.toContain('LANE_IDLE_WARN')
    } finally { h.cleanup() }
  })
})

describe('round-three filesystem counterexamples', () => {
  it.skipIf(process.platform === 'win32').each(['external-target', 'directory-churn'])('protects continuing %s work behind a future maximum', (kind) => {
    const h = harness()
    try {
      const working = join(h.root, 'output')
      writeFileSync(working, 'a')
      symlinkSync(working, join(h.worktree, 'output'))
      const scratch = join(h.worktree, 'scratch')
      mkdirSync(scratch)
      writeFileSync(join(h.worktree, 'future'), '')
      utimesSync(join(h.worktree, 'future'), 4e9, 4e9)
      h.latestWrite.mockImplementation(() => idleScan(h.worktree))
      h.watch.refresh()
      for (let second = 1; second <= 12; second++) {
        if (kind === 'external-target') { writeFileSync(working, String(second % 10)); utimesSync(working, second, second) }
        else { writeFileSync(join(scratch, 'temp'), 'work'); rmSync(join(scratch, 'temp')); utimesSync(scratch, second, second) }
        vi.advanceTimersByTime(1000)
      }
      expect(h.stop).not.toHaveBeenCalled()
      expect(readFileSync(h.log, 'utf8')).not.toContain('LANE_IDLE_WARN')
    } finally { h.cleanup() }
  })
})

describe('round-three supervisor identities', () => {
  it.skipIf(process.platform === 'win32').each(['hardlink', 'symlink'])('excludes a %s run-log alias by identity', (kind) => {
    const h = harness()
    try {
      if (kind === 'hardlink') linkSync(h.log, join(h.worktree, 'alias'))
      else symlinkSync(h.log, join(h.worktree, 'alias'))
      writeFileSync(join(h.worktree, 'future'), '')
      utimesSync(join(h.worktree, 'future'), 4e9, 4e9)
      h.latestWrite.mockImplementation(() => idleScan(h.worktree, { excludedFiles: [h.log] }))
      h.watch.refresh()
      vi.advanceTimersByTime(8000)
      expect(h.stop).toHaveBeenCalledTimes(1)
      expect(readFileSync(h.log, 'utf8')).toContain('LANE_IDLE_STOP silentSeconds=8')
    } finally { h.cleanup() }
  })

  it('makes an unreadable supervisor identity unknown', () => {
    const h = harness()
    try { expect(idleScan(h.worktree, { excludedFiles: [join(h.root, 'missing-state')] })).toMatchObject({ status: 'unknown' }) }
    finally { h.cleanup() }
  })
})

describe('installed idle scanner wiring', () => {
  it.skipIf(process.platform === 'win32')('excludes installed state, log and usage receipt aliases while accepting an encoded brief receipt', () => {
    const h = harness()
    h.watch.clear()
    const state = join(h.root, 'sample.json')
    const usage = `${h.log}.usage.json.launch.json`
    writeFileSync(state, '{}')
    writeFileSync(join(h.root, 'current.json'), '{}')
    writeFileSync(usage, '{}')
    linkSync(h.log, join(h.worktree, 'log-alias'))
    linkSync(usage, join(h.worktree, 'receipt-alias'))
    symlinkSync(state, join(h.worktree, 'state-alias'))
    writeFileSync(join(h.worktree, 'future'), '')
    utimesSync(join(h.worktree, 'future'), 4e9, 4e9)
    const endGroup = vi.fn()
    const deadline = createLaneDeadline({ ...h.options, opts: { ...h.options.opts, timeout: 100, briefReceipt: 'eyJwYXRoIjoiYnJpZWYifQ' }, child: { pid: 4 }, args: [], runId: 'test-run', transitionBoundMs: 0, decisionFile: join(h.root, 'sample.decision.json'), modules: { latestWorktreeWrite, hostAdapter: { readProcessSnapshot: h.readSnapshot }, argvSummary: () => 'child' }, current: () => ({}), writeState: (value: unknown) => { writeFileSync(state, JSON.stringify(value)); writeFileSync(usage, JSON.stringify(value)) }, endGroup, cleanupBrief: vi.fn(), journal: vi.fn() })
    try {
      vi.advanceTimersByTime(8000)
      expect(endGroup).toHaveBeenCalledTimes(1)
      expect(endGroup).toHaveBeenCalledWith(126, expect.objectContaining({ receiptLines: ['TERMINATION=idle'] }))
    } finally { deadline.clear(); h.cleanup() }
  })
})

describe('idle review counterexamples', () => {
  it.each(['bad', '-1', '1.5', '9007199254740992'])('names an unreadable parent %s unknown instead of dropping its process', (parent) => {
    const snapshot = procSnapshot('0', '0', parent)
    expect(snapshot.unknownPids, 'unreadable ancestry must mark the PID unknown').toContain(5)
    expect(activityEvidence({ snapshot, worktree: { status: 'known' }, rootPid: 4 })).toMatchObject({ status: 'unknown' })
  })

  it('rejects invalid ancestry even from an injected process snapshot', () => {
    expect(activityEvidence({ snapshot: { processes: [{ pid: 4, ppid: 1, cpuTicks: 0 }, { pid: 5, ppid: NaN, cpuTicks: 0 }] }, rootPid: 4, worktree: { status: 'known' } })).toMatchObject({ status: 'unknown', reason: 'process snapshot contains unreadable ancestry' })
  })
})

describe('idle review counterexamples', () => {
  it('names a missing worktree root unknown and never stops on it', () => {
    const h = harness()
    try {
      rmSync(h.worktree, { recursive: true })
      expect(latestWorktreeWrite(h.worktree), 'a failed root listing must be unknown').toMatchObject({ status: 'unknown' })
      vi.advanceTimersByTime(20_000)
      expect(h.writeState.mock.lastCall?.[0].idle.status).toBe('unknown')
      expect(h.stop).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })

  it.each(['directory', 'file'])('names a denied %s read unknown', (kind) => {
    const h = harness()
    try {
      const denied = join(h.worktree, 'denied')
      if (kind === 'directory') mkdirSync(denied)
      else writeFileSync(denied, 'content')
      const fail = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
      h.latestWrite.mockImplementation(() => latestWorktreeWrite(h.worktree, {
        readDirectory: (dir: string, options: { withFileTypes: true }) => dir === denied ? fail() : readdirSync(dir, options),
        readStat: (file: string) => file === denied && kind === 'file' ? fail() : lstatSync(file),
      }))
      expect(h.latestWrite(), 'a partial scan must be unknown').toMatchObject({ status: 'unknown' })
      vi.advanceTimersByTime(20_000)
      expect(h.stop).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })
})

describe('idle review counterexamples', () => {
  it.each(['write', 'create', 'delete', 'rename'])('detects %s activity behind a future maximum mtime', (kind) => {
    const h = harness()
    try {
      const future = join(h.worktree, 'future')
      writeFileSync(future, 'future')
      utimesSync(future, 4_000_000_000, 4_000_000_000)
      const working = join(h.worktree, 'working')
      writeFileSync(working, 'a')
      h.watch.refresh()
      for (let second = 1; second <= 12; second++) {
        if (kind === 'write') { writeFileSync(working, String(second % 10)); utimesSync(working, second, second) }
        else if (kind === 'create') writeFileSync(join(h.worktree, `new-${second}`), '')
        else if (kind === 'delete') {
          // Remove one of a pre-created family on every scan.
          if (second === 1) for (let index = 1; index <= 12; index++) writeFileSync(join(h.worktree, `old-${index}`), '')
          rmSync(join(h.worktree, `old-${second}`))
        } else { renameSync(working, join(h.worktree, `renamed-${second}`)); writeFileSync(working, 'a') }
        vi.advanceTimersByTime(1000)
      }
      expect(h.stop, 'non-maximum file activity must prevent idle stops').not.toHaveBeenCalled()
      expect(readFileSync(h.log, 'utf8')).not.toContain('LANE_IDLE_WARN')
      vi.advanceTimersByTime(8000)
      expect(h.stop).toHaveBeenCalledTimes(1)
    } finally { h.cleanup() }
  })
})

describe('idle review counterexamples', () => {
  it.skipIf(process.platform === 'win32')('does not count symlinked supervisor state publications as activity', () => {
    const h = harness()
    try {
      const state = join(h.root, 'supervisor.json')
      writeFileSync(state, '{}')
      symlinkSync(state, join(h.worktree, 'status.json'))
      h.writeState.mockImplementation((value) => { writeFileSync(state, JSON.stringify(value)); utimesSync(state, Date.now() / 1000, Date.now() / 1000) })
      h.watch.refresh()
      vi.advanceTimersByTime(8000)
      expect(h.stop, 'supervisor writes through aliases must not postpone idle').toHaveBeenCalledTimes(1)
      expect(readFileSync(h.log, 'utf8')).toContain('LANE_IDLE_STOP silentSeconds=8')
    } finally { h.cleanup() }
  })

  it('preserves timeout extensions for a stalled descendant with idle enforcement off', () => {
    const h = harness(0, procSnapshot())
    h.watch.clear()
    const endGroup = vi.fn()
    let state: Record<string, unknown> = { runId: 'test-run', extensions: [] }
    const deadline = createLaneDeadline({ ...h.options, opts: { ...h.options.opts, idleWindow: 1 }, child: { pid: 4 }, args: [], runId: 'test-run', transitionBoundMs: 0, decisionFile: join(h.root, 'decision.json'), modules: { latestWorktreeWrite: h.latestWrite, hostAdapter: { readProcessSnapshot: h.readSnapshot }, argvSummary: () => 'child', readLogTail: () => '', processEvidenceStatus: () => 'live' }, current: () => state, writeState: (extra: Record<string, unknown>) => { state = { ...state, ...extra } }, endGroup, cleanupBrief: vi.fn(), journal: vi.fn() })
    try {
      vi.advanceTimersByTime(7000)
      expect(state, 'stalled descendants must retain the base timeout default').toMatchObject({ state: 'running', extensionCount: 1, decisionSource: 'grace-default' })
      vi.advanceTimersByTime(14_000)
      expect(state).toMatchObject({ state: 'running', extensionCount: 3 })
      expect(endGroup).not.toHaveBeenCalled()
      vi.advanceTimersByTime(7000)
      expect(endGroup).toHaveBeenCalledWith(126, expect.objectContaining({ receiptLines: ['TERMINATION=timeout'] }))
    } finally { deadline.clear(); h.cleanup() }
  })
})

describe('kernel threads in idle ancestry', () => {
  it('accepts a PPID 0 row only when the kernel flags it as a kernel thread', () => {
    const processes = [{ pid: 1, ppid: 0, cpuTicks: 0 }, { pid: 2, ppid: 0, cpuTicks: 0, kernelThread: true }, { pid: 4, ppid: 1, cpuTicks: 0 }]
    const input = { snapshot: { processes }, rootPid: 4, worktree: { status: 'known' } }
    expect(activityEvidence(input)).toMatchObject({ status: 'known', descendants: [] })
    processes[1] = { pid: 2, ppid: 0, cpuTicks: 0, kernelThread: false }
    expect(activityEvidence(input)).toMatchObject({ status: 'unknown', reason: 'process snapshot contains unreadable ancestry' })
  })

  it('reads the kernel-thread flag from /proc stat on a full Linux host', () => {
    // kthreadd is PID 2 with PPID 0 and PF_KTHREAD (0x00200000); a namespace-foreign process lacks the flag.
    const rows: Record<string, { ppid: string; flags: string }> = { 1: { ppid: '0', flags: '4194560' }, 2: { ppid: '0', flags: '2129984' }, 4: { ppid: '1', flags: '4194304' } }
    const snapshot = readLinuxProcProcesses({
      readLink: () => String(process.pid),
      readDirectory: () => Object.keys(rows).map((name) => ({ name, isDirectory: () => true })),
      observedAt: 20_000,
      readFile: (file: string) => {
        if (file === '/proc/uptime') return '10 1\n'
        if (file.endsWith('/cmdline')) return ''
        const pid = file.split('/')[2]!
        const fields = ['S', rows[pid]!.ppid, '0', '0', '0', '0', rows[pid]!.flags, ...Array<string>(13).fill('0')]
        fields[19] = '100'
        return `${pid} (kthreadd) ${fields.join(' ')}\n`
      },
    })
    expect(snapshot.processes.map((row: { pid: number; kernelThread: boolean }) => [row.pid, row.kernelThread])).toEqual([[1, false], [2, true], [4, false]])
    expect(activityEvidence({ snapshot, rootPid: 4, worktree: { status: 'known' } })).toMatchObject({ status: 'known' })
  })
})

// NTFS file ids exceed Number.MAX_SAFE_INTEGER, so the number form collapses distinct files.
const ntfsBase = 2n ** 53n + 2n
const exactIno: Record<string, bigint> = { '/w': ntfsBase, '/w/run.log': ntfsBase + 1n, '/w/out.txt': ntfsBase + 2n }
type Swap = Record<string, string>
function fakeStat(exact: boolean, mtimes: Record<string, number>, swap: Swap = {}) {
  return (file: string, options?: { bigint?: boolean }) => {
    const seen = options?.bigint ? swap[file] ?? file : file
    const directory = seen === '/w'
    const time = mtimes[seen] ?? 1
    const kind = { isDirectory: () => directory, isSymbolicLink: () => false }
    if (options?.bigint && exact) return { ...kind, dev: 7n, ino: exactIno[seen]!, mode: BigInt(directory ? 0o40755 : 0o100644), size: 1n, mtimeNs: BigInt(time) * 1_000_000n, ctimeNs: BigInt(time) * 1_000_000n }
    return { ...kind, dev: 7, ino: Number(exactIno[seen]!), mode: directory ? 0o40755 : 0o100644, size: 1, mtimeMs: time, ctimeMs: time }
  }
}
const identityDirectory = (dir: string) => dir === '/w' ? ['run.log', 'out.txt'].map((name) => ({ name })) : []
const identityScan = (exact: boolean, mtimes: Record<string, number> = {}, swap: Swap = {}) => {
  const readStat = fakeStat(exact, mtimes, swap)
  return idleScan('/w', { readDirectory: identityDirectory, readStat, readTargetStat: readStat, excludedFiles: ['/w/run.log'] })
}

// The supervisor log's exact re-read lands on out.txt, equal in every field but `differ`.
function retargetedStat(differ: Record<string, bigint>) {
  return (file: string, options?: { bigint?: boolean }) => {
    const directory = file === '/w'
    const kind = { isDirectory: () => directory, isSymbolicLink: () => false }
    const mode = directory ? 0o40755 : 0o100644
    if (!options?.bigint) return { ...kind, dev: 7, ino: Number(exactIno[file]!), mode, size: 1, mtimeMs: 1, ctimeMs: 1 }
    const seen = file === '/w/run.log' ? '/w/out.txt' : file
    return { ...kind, dev: 7n, ino: exactIno[seen]!, mode: BigInt(mode), size: 1n, mtimeNs: 1_000_000n, ctimeNs: 1_000_000n, ...(seen === file ? {} : differ) }
  }
}

describe('idle filesystem identity beyond 2^53', () => {
  it('keeps the scan known with exact bigint identities and still excludes supervisor files', () => {
    expect(Number(exactIno['/w/run.log']!), 'the fixture must collapse in number form').toBe(Number(exactIno['/w/out.txt']!))
    const before = identityScan(true)
    expect(before).toMatchObject({ status: 'known' })
    expect(identityScan(true, { '/w/run.log': 99 }).fingerprint, 'an excluded log write is not activity').toBe(before.fingerprint)
    expect(identityScan(true, { '/w/out.txt': 99 }).fingerprint, 'a lane file write is activity').not.toBe(before.fingerprint)
  })

  it('stays unknown when no exact identity can be read', () => {
    expect(identityScan(false)).toMatchObject({ status: 'unknown', reason: 'idle filesystem read failed: filesystem identity unavailable' })
  })

  it('refuses an exact re-read that observes a different file than the first stat', () => {
    // A supervisor path retargeted between the two reads must not exclude the lane's own file.
    expect(identityScan(true, { '/w/out.txt': 20 }, { '/w/run.log': '/w/out.txt' })).toMatchObject({ status: 'unknown', reason: 'idle filesystem read failed: filesystem identity unavailable' })
    expect(identityScan(true, { '/w/out.txt': 20 }, { '/w/out.txt': '/w/run.log' })).toMatchObject({ status: 'unknown' })
  })

  it('refuses a re-read whose ctime matches but whose mode or mtime differs', () => {
    // Exact ids that round to one number and equal ctimes still name two files when another field differs.
    for (const differ of [{ mtimeNs: 5_000_000n }, { mode: 0o100600n }]) {
      const readStat = retargetedStat(differ)
      expect(idleScan('/w', { readDirectory: identityDirectory, readStat, readTargetStat: readStat, excludedFiles: ['/w/run.log'] }), JSON.stringify(differ, (_k, v) => typeof v === 'bigint' ? String(v) : v)).toMatchObject({ status: 'unknown' })
    }
  })
})
