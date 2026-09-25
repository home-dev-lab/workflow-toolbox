import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { appendSupervisorJournal, classifyLane, inspectProcess, latestWorktreeWrite, processEvidenceStatus, sameIdentity, supervisionUnavailableMessage, terminateLane } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'
// @ts-expect-error runtime .mjs launcher helper
import { inspectLauncherProcess, inspectStartedProcess } from '../../../../plugin/bin/wt-lane.mjs'

describe('lane supervisor safety core', () => {
  it('returns unknown without a readable attributed record', () => {
    expect(classifyLane(null)).toMatchObject({ status: 'unknown', reason: 'invalid-record' })
  })

  it('classifies worker and child only by their recorded pid and argv identities', () => {
    const worker = { pid: 40, argv: ['node', 'wt-lane.mjs', '--worker'], startTime: 400 }
    const child = { pid: 41, argv: ['opencode', 'run'], startTime: 410 }
    const record = { runId: '40-1', state: 'running', workerPid: worker.pid, workerArgv: worker.argv, workerStartTime: worker.startTime, childPid: child.pid, childArgv: child.argv, childStartTime: child.startTime, worktree: '/work' }
    const inspect = (pid: number) => pid === worker.pid ? worker : pid === child.pid ? child : null
    expect(classifyLane(record, { platform: 'linux', inspect })).toMatchObject({ status: 'running', worker: 'running', child: 'running' })
    expect(classifyLane({ ...record, state: 'decision-needed' }, { platform: 'linux', inspect })).toMatchObject({ status: 'decision-needed' })
    expect(classifyLane({ ...record, state: 'abandoned' }, { platform: 'linux', inspect })).toMatchObject({ status: 'unknown', reason: 'inconsistent-record' })
    expect(classifyLane({ ...record, state: 'abandoned' }, { platform: 'linux', inspect: (pid: number) => pid === worker.pid ? worker : null, processExists: () => false })).toMatchObject({ status: 'terminal' })
    expect(classifyLane(record, { platform: 'linux', inspect: (pid: number) => pid === child.pid ? child : null, processExists: () => false })).toMatchObject({ status: 'worker-gone-child-alive' })
    expect(classifyLane(record, { platform: 'linux', inspect: () => null, processExists: () => false })).toMatchObject({ status: 'gone' })
    expect(classifyLane(record, { platform: 'linux', inspect: (pid: number) => pid === worker.pid ? { ...worker, argv: ['unrelated'] } : child })).toMatchObject({ status: 'unknown', reason: 'identity-unreadable' })
    expect(classifyLane(record, { platform: 'linux', inspect: (pid: number) => pid === worker.pid ? { ...worker, startTime: 401 } : child })).toMatchObject({ status: 'worker-gone-child-alive' })
  })

  it('classifies a gone worker that never spawned a child as gone', () => {
    const record = { runId: '40-1', state: 'launching', workerPid: 40, workerArgv: ['node'], workerStartTime: 400, childPid: null, childArgv: null, childStartTime: null, worktree: '/work' }
    expect(classifyLane(record, { platform: 'linux', inspect: () => null, processExists: () => false })).toMatchObject({ status: 'gone', reason: 'worker-gone-no-child' })
  })

  it('classifies a live worker that has not spawned its child as launching', () => {
    const worker = { pid: 40, argv: ['node'], startTime: 400 }
    const record = { runId: '40-1', state: 'launching', workerPid: 40, workerArgv: worker.argv, workerStartTime: worker.startTime, childPid: null, childArgv: null, childStartTime: null, worktree: '/work' }
    expect(classifyLane(record, { platform: 'linux', inspect: () => worker })).toMatchObject({ status: 'launching', child: 'not-spawned' })
  })

  it('keeps an unreadable live identity unknown through the injected process-existence seam', () => {
    const record = { runId: '40-1', state: 'running', workerPid: 40, workerArgv: ['node'], workerStartTime: 400, childPid: 41, childArgv: ['opencode'], childStartTime: 410, worktree: '/work' }
    expect(classifyLane(record, { platform: 'linux', inspect: () => null, processExists: () => true })).toMatchObject({ status: 'unknown', reason: 'identity-unreadable' })
  })

  it('classifies a live pid with an unavailable recorded start time as unknown, never gone', () => {
    const record = { runId: '40-1', state: 'running', workerPid: 40, workerArgv: ['node'], workerStartTime: null, childPid: null, childArgv: null, childStartTime: null, worktree: '/work' }
    expect(classifyLane(record, { platform: 'linux', inspect: () => ({ pid: 40, argv: ['node'], startTime: 400 }), processExists: () => true })).toMatchObject({ status: 'unknown', worker: 'unknown' })
  })

  it('names the Darwin evidence source when ps cannot be read', () => {
    const record = { runId: '40-1', state: 'running', workerPid: 40, workerArgv: ['node'], workerStartTime: 400, childPid: 41, childArgv: ['opencode'], childStartTime: 410, worktree: '/work' }
    expect(classifyLane(record, { platform: 'darwin', inspect: () => null, processExists: () => null })).toMatchObject({ status: 'unknown', reason: 'identity-unreadable-ps', worker: 'unknown', child: 'unknown' })
  })

  it('reuses one complete Darwin process table when inspection switches to another present pid', () => {
    const start = 'Wed Sep 16 12:34:56 2026'
    const execFile = vi.fn((command: string) => command === 'ps'
      ? { status: 0, stdout: `  100 ${start}   100 S node launcher.mjs\n  432 ${start}   432 S node worker.mjs\n` }
      : { status: 1, stdout: '' })
    expect(inspectProcess(100, { platform: 'darwin', spawnSync: execFile, captureCwd: false })).not.toBeNull()
    expect(inspectProcess(432, { platform: 'darwin', spawnSync: execFile, captureCwd: false })).not.toBeNull()
    expect(execFile.mock.calls.filter(([program]) => program === 'ps')).toHaveLength(1)
  })

  it('ages a slow Darwin cwd snapshot from provider completion instead of invocation', () => {
    vi.useFakeTimers()
    try {
      const execFile = vi.fn((program: string) => {
        if (program === 'lsof') vi.advanceTimersByTime(150)
        return program === 'ps'
          ? { status: 0, stdout: '  432 Wed Sep 16 12:34:56 2026   431 S /usr/local/bin/node worker.mjs\n' }
          : { status: 0, stdout: 'p432\nfcwd\nn/Users/runner/work/lane\n' }
      })
      expect(inspectProcess(432, { platform: 'darwin', spawnSync: execFile })).not.toBeNull()
      expect(inspectProcess(432, { platform: 'darwin', spawnSync: execFile })).not.toBeNull()
      // Both snapshots remain fresh when the provider duration is below the shared TTL.
      expect(execFile.mock.calls.filter(([program]) => program === 'ps')).toHaveLength(1)
      expect(execFile.mock.calls.filter(([program]) => program === 'lsof')).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it('names the Windows evidence source when PowerShell cannot be read', () => {
    const record = { runId: '40-1', state: 'running', workerPid: 40, workerArgv: ['node'], workerStartTime: 400, childPid: 41, childArgv: ['opencode'], childStartTime: 410, worktree: 'C:\\work' }
    expect(classifyLane(record, { platform: 'win32', inspect: () => null, processExists: () => null })).toMatchObject({ status: 'unknown', reason: 'identity-unreadable-powershell', worker: 'unknown', child: 'unknown' })
  })

  it('reads repeated Darwin ps and lsof transcripts into one stable identity', () => {
    const execFile = vi.fn((command: string) => command === 'ps'
      ? { status: 0, stdout: '  432 Wed Sep 16 12:34:56 2026   431 S /usr/local/bin/node worker.mjs --flag\n' }
      : { status: 0, stdout: 'p432\nfcwd\nn/Users/runner/work/lane\n' })
    const expected = {
      pid: 432,
      argv: ['/usr/local/bin/node worker.mjs --flag'],
      startTime: Math.floor(Date.parse('Wed Sep 16 12:34:56 2026') / 1000),
      groupId: 431,
      cwd: '/Users/runner/work/lane',
    }
    expect(inspectProcess(432, { platform: 'darwin', spawnSync: execFile })).toEqual(expected)
    expect(inspectProcess(432, { platform: 'darwin', spawnSync: execFile })).toEqual(expected)
    expect(execFile).toHaveBeenCalledWith('ps', ['-ww', '-axo', 'pid=,lstart=,pgid=,state=,command='], expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C' }) }))
    expect(execFile.mock.calls.filter(([program]) => program === 'ps')).toHaveLength(1)
    expect(execFile.mock.calls.filter(([program]) => program === 'lsof')).toHaveLength(1)
  })

  it('keeps a long Darwin argv identical across wide two-read transcripts', () => {
    const command = `/usr/local/bin/node worker.mjs --brief-receipt ${'a'.repeat(500)}`
    const execFile = vi.fn((program: string) => program === 'ps'
      ? { status: 0, stdout: `  432 Wed Sep 16 12:34:56 2026   431 S ${command}\n` }
      : { status: 0, stdout: 'p432\nfcwd\nn/Users/runner/work/lane\n' })
    const first = inspectProcess(432, { platform: 'darwin', spawnSync: execFile })
    const second = inspectProcess(432, { platform: 'darwin', spawnSync: execFile })
    expect(first?.argv).toEqual([command])
    expect(second).toEqual(first)
    expect(execFile.mock.calls.filter(([program]) => program === 'ps')).toHaveLength(1)
  })

  it('bounds Darwin forks by the 500 ms snapshot TTL under a 10 ms identity poll', () => {
    vi.useFakeTimers()
    try {
      const execFile = vi.fn((program: string) => program === 'ps'
        ? { status: 0, stdout: '  432 Wed Sep 16 12:34:56 2026   431 S /usr/local/bin/node worker.mjs\n' }
        : { status: 0, stdout: 'p432\nfcwd\nn/Users/runner/work/lane\n' })
      for (let tick = 0; tick < 100; tick += 1) {
        expect(inspectProcess(432, { platform: 'darwin', spawnSync: execFile })).not.toBeNull()
        vi.advanceTimersByTime(10)
      }
      expect(execFile.mock.calls.filter(([program]) => program === 'ps')).toHaveLength(2)
      expect(execFile.mock.calls.filter(([program]) => program === 'lsof')).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })

  it('refreshes a cached Darwin snapshot when a requested pid appeared within its TTL', () => {
    vi.useFakeTimers()
    try {
      let includeSpawnedPid = false
      const execFile = vi.fn((program: string) => program === 'ps'
        ? { status: 0, stdout: `  431 Wed Sep 16 12:34:55 2026   431 S /usr/local/bin/node parent.mjs\n${includeSpawnedPid ? '  432 Wed Sep 16 12:34:56 2026   431 S /usr/local/bin/node worker.mjs\n' : ''}` }
        : { status: 0, stdout: `p431\nfcwd\nn/Users/runner/work/parent\n${includeSpawnedPid ? 'p432\nfcwd\nn/Users/runner/work/lane\n' : ''}` })
      expect(inspectProcess(431, { platform: 'darwin', spawnSync: execFile })).not.toBeNull()
      vi.advanceTimersByTime(10)
      includeSpawnedPid = true
      vi.advanceTimersByTime(10)

      expect(inspectProcess(432, { platform: 'darwin', spawnSync: execFile })).toMatchObject({ pid: 432, cwd: '/Users/runner/work/lane' })
      expect(execFile.mock.calls.filter(([program]) => program === 'ps')).toHaveLength(2)
      expect(execFile.mock.calls.filter(([program]) => program === 'lsof')).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })

  it('bounds fresh-on-miss Darwin reads for a dead pid to once per TTL', () => {
    vi.useFakeTimers()
    try {
      const execFile = vi.fn(() => ({ status: 0, stdout: '' }))
      for (let tick = 0; tick < 100; tick += 1) {
        expect(inspectProcess(999, { platform: 'darwin', spawnSync: execFile })).toBeNull()
        vi.advanceTimersByTime(10)
      }
      expect(execFile).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('keeps a Darwin identity readable when lsof is absent and marks cwd unreadable', () => {
    const execFile = vi.fn((command: string) => command === 'ps'
      ? { status: 0, stdout: '  432 Wed Sep 16 12:34:56 2026   431 S /usr/local/bin/node worker.mjs\n' }
      : { status: null, stdout: '', error: Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }) })
    expect(inspectProcess(432, { platform: 'darwin', spawnSync: execFile })).toMatchObject({ pid: 432, cwd: null })
  })

  it('matches two Darwin lsof cwd spellings only when they resolve to the same directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-darwin-cwd-'))
    const canonical = join(root, 'private', 'var', 'lane')
    const alias = join(root, 'var')
    mkdirSync(canonical, { recursive: true })
    symlinkSync(join(root, 'private', 'var'), alias, 'dir')
    const cwds = [alias + '/lane', canonical]
    const execFile = vi.fn((program: string) => program === 'ps'
      ? { status: 0, stdout: '  432 Wed Sep 16 12:34:56 2026   431 S /usr/local/bin/node worker.mjs\n' }
      : { status: 0, stdout: `p432\nfcwd\nn${cwds.shift()}\n` })
    try {
      const recorded = inspectProcess(432, { platform: 'darwin', spawnSync: execFile })!
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 501)
      const actual = inspectProcess(432, { platform: 'darwin', spawnSync: execFile })!
      expect(recorded.cwd).not.toBe(actual.cwd)
      expect(sameIdentity(recorded, actual)).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reads a Windows Get-Process transcript while retaining spawn-recorded argv', () => {
    const argv = ['node.exe', 'worker.mjs', '--flag']
    const execFile = vi.fn(() => ({ status: 0, stdout: '{"Id":432,"ProcessName":"node","Path":"C:\\\\Program Files\\\\nodejs\\\\node.exe","StartTime":1789587296789}\r\n' }))
    expect(inspectProcess(432, { platform: 'win32', spawnSync: execFile, recordedArgv: argv })).toEqual({
      pid: 432,
      argv,
      startTime: 1_789_587_296_789,
      image: { name: 'node', path: 'C:\\Program Files\\nodejs\\node.exe' },
      groupId: null,
      cwd: null,
    })
    expect(execFile).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-Command', expect.stringContaining('Get-Process -Id 432')]),
      expect.objectContaining({ timeout: 5_000 }),
    )
  })

  it('captures launcher identity while every injected CIM call stalls', () => {
    const execFile = vi.fn((_program: string, args: string[]) => {
      const script = args.at(-1) ?? ''
      if (script.includes('Get-CimInstance')) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_000)
        return { status: 0, stdout: '[]' }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      return { status: 0, stdout: JSON.stringify({ Id: 432, ProcessName: 'node', Path: 'C:\\node.exe', StartTime: 1_789_587_296_000 }) }
    })
    const inspect = (pid: number, options: Record<string, unknown>) => inspectProcess(pid, { ...options, spawnSync: execFile })
    const started = Date.now()

    expect(inspectLauncherProcess(inspect, 432, { platform: 'win32', recordedArgv: ['node.exe', 'wt-lane.mjs'] })).toMatchObject({ pid: 432, argv: ['node.exe', 'wt-lane.mjs'] })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(String(execFile.mock.calls[0]?.[1]?.at(-1))).toContain('Get-Process -Id 432')
    expect(String(execFile.mock.calls[0]?.[1]?.at(-1))).not.toContain('Get-CimInstance')
  })

  it('returns unavailable within the configured bound when the full Windows table never answers', () => {
    const execFile = ((_program: string, _args: string[], options: Parameters<typeof spawnSync>[2]) =>
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], options)) as typeof spawnSync
    const started = Date.now()

    expect(inspectProcess(432, { platform: 'win32', spawnSync: execFile, timeoutMs: 100 })).toBeNull()
    expect(Date.now() - started).toBeLessThan(750)
  })

  it('retries a transient empty Windows process read within one total timeout budget', () => {
    const argv = ['node.exe', 'worker.mjs']
    const row = { Id: 433, ProcessName: 'node', Path: 'C:\\node.exe', StartTime: 1_789_587_296_000 }
    const execFile = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(row) })

    expect(inspectProcess(433, { platform: 'win32', spawnSync: execFile, recordedArgv: argv, timeoutMs: 200 })).toMatchObject({ pid: 433, argv })
    expect(execFile).toHaveBeenCalledTimes(2)
    expect(execFile.mock.calls.reduce((total, call) => total + Number(call[2]?.timeout), 0)).toBeLessThanOrEqual(200)
  })

  it('captures a Windows command shim from one timeout-bounded Get-Process read', () => {
    const argv = ['cmd.exe', '/d', '/s', '/c', String.raw`"C:\Program^ Files\opencode\opencode.CMD run"`]
    const execFile = vi.fn(() => ({ status: 0, stdout: JSON.stringify({ Id: 432, ProcessName: 'cmd', Path: 'C:\\Windows\\System32\\cmd.exe', StartTime: 1_789_587_296_000 }) }))
    const inspect = (pid: number, options: Record<string, unknown>) => inspectProcess(pid, { ...options, spawnSync: execFile })

    expect(inspectStartedProcess(inspect, 432, { platform: 'win32', timeoutMs: 250, expectedCommand: 'cmd.exe', expectedArgv: argv }).identity).toMatchObject({
      pid: 432,
      argv,
      startTime: 1_789_587_296_000,
      image: { name: 'cmd', path: 'C:\\Windows\\System32\\cmd.exe' },
    })
    expect(execFile).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-Command', expect.stringContaining('Get-Process -Id 432')]),
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
  })

  it('falls back to a flagged spawn-time identity when the bounded Windows read is unavailable', () => {
    const execFile = ((_program: string, _args: string[], options: Parameters<typeof spawnSync>[2]) =>
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], options)) as typeof spawnSync
    const inspect = (pid: number, options: Record<string, unknown>) => inspectProcess(pid, { ...options, spawnSync: execFile })
    const started = Date.now()

    expect(inspectStartedProcess(inspect, 432, { platform: 'win32', timeoutMs: 100, expectedCommand: 'opencode.CMD', expectedArgv: ['opencode.CMD', 'run'], spawnedAt: 123_456 }))
      .toEqual({ identity: { pid: 432, argv: ['opencode.CMD', 'run'], startTime: 123_456, startTimeApproximate: true, image: { name: 'opencode', path: null }, groupId: null, cwd: null }, unavailable: 'unavailable (powershell); using spawn-time identity' })
    expect(Date.now() - started).toBeLessThan(750)
  })

  it('caches one Windows PID read and refreshes after its 500 ms staleness bound', () => {
    vi.useFakeTimers()
    try {
      const row = { Id: 432, ProcessName: 'node', Path: 'C:\\node.exe', StartTime: 1_789_587_296_000 }
      const execFile = vi.fn()
        .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(row) })
        .mockReturnValueOnce({ status: 0, stdout: '' })
      expect(inspectProcess(432, { platform: 'win32', spawnSync: execFile })).not.toBeNull()
      expect(inspectProcess(432, { platform: 'win32', spawnSync: execFile })).not.toBeNull()
      expect(execFile).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(501)
      expect(inspectProcess(432, { platform: 'win32', spawnSync: execFile })).toBeNull()
      expect(execFile).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('classifies both Windows lane pids from bounded per-pid native reads', () => {
    const rows = [
      { Id: 40, ProcessName: 'node', Path: 'C:\\node.exe', StartTime: 1_789_587_296_000 },
      { Id: 41, ProcessName: 'opencode', Path: 'C:\\opencode.exe', StartTime: 1_789_587_297_000 },
    ]
    const execFile = vi.fn((_program: string, args: string[]) => ({ status: 0, stdout: JSON.stringify(String(args.at(-1)).includes('-Id 40 ') ? rows[0] : rows[1]) }))
    const inspect = (pid: number, options: Record<string, unknown>) => inspectProcess(pid, { ...options, spawnSync: execFile })
    const record = { runId: '40-1', state: 'running', workerPid: 40, workerArgv: ['node.exe', 'worker.mjs'], workerStartTime: 1_789_587_296_000, workerImage: { name: 'node', path: 'C:\\node.exe' }, childPid: 41, childArgv: ['opencode.exe', 'run'], childStartTime: 1_789_587_297_000, childImage: { name: 'opencode', path: 'C:\\opencode.exe' } }
    expect(classifyLane(record, { platform: 'win32', inspect })).toMatchObject({ status: 'running', worker: 'running', child: 'running' })
    expect(execFile).toHaveBeenCalledTimes(2)
  })

  it('rejects a reused Windows pid when its native image changes', () => {
    const expected = { pid: 432, argv: ['node.exe', 'worker.mjs'], startTime: 1_789_587_296_000, image: { name: 'node', path: 'C:\\node.exe' } }
    expect(sameIdentity(expected, { ...expected, image: { name: 'other', path: 'C:\\other.exe' } })).toBe(false)
    expect(sameIdentity(expected, { ...expected, image: { name: 'node', path: null } })).toBe(false)
  })

  it('rejects a reused Windows pid outside the exact or explicitly approximate start-time contract', () => {
    const expected = { pid: 432, argv: ['node.exe', 'worker.mjs'], startTime: 1_789_587_296_000, image: { name: 'node', path: 'C:\\node.exe' } }
    expect(sameIdentity(expected, { ...expected, startTime: expected.startTime + 1 })).toBe(false)
    expect(sameIdentity({ ...expected, startTimeApproximate: true }, { ...expected, startTime: expected.startTime + 2_000 })).toBe(true)
    expect(sameIdentity({ ...expected, startTimeApproximate: true }, { ...expected, startTime: expected.startTime + 2_001 })).toBe(false)
    const record = { runId: '432-1', state: 'launching', workerPid: expected.pid, workerArgv: expected.argv, workerStartTime: expected.startTime, workerStartTimeApproximate: true, workerImage: expected.image, childPid: null, childArgv: null }
    expect(classifyLane(record, { platform: 'win32', inspect: () => ({ ...expected, startTime: expected.startTime + 2_000 }) })).toMatchObject({ status: 'launching', worker: 'running' })
  })

  it.each(['darwin', 'win32'])('classifies %s running and gone from injected provider evidence', (platform) => {
    const worker = { pid: 40, argv: ['node worker.mjs'], startTime: 1_789_555_696, groupId: 39, cwd: null }
    const child = { pid: 41, argv: ['opencode run'], startTime: 1_789_555_697, groupId: 40, cwd: null }
    const record = { runId: '40-1', state: 'running', workerPid: worker.pid, workerArgv: worker.argv, workerStartTime: worker.startTime, childPid: child.pid, childArgv: child.argv, childStartTime: child.startTime, worktree: '/work' }
    const inspect = (pid: number) => pid === worker.pid ? worker : pid === child.pid ? child : null
    expect(classifyLane(record, { platform, inspect })).toMatchObject({ status: 'running', worker: 'running', child: 'running' })
    expect(classifyLane(record, { platform, inspect: () => null, processExists: () => false })).toMatchObject({ status: 'gone', worker: 'gone', child: 'gone' })
  })

  it('re-verifies both identities immediately before terminating and refuses a reused pid', () => {
    const kill = vi.fn()
    const record = { runId: '76-1', state: 'running', worktree: '/lane', workerPid: 76, workerArgv: ['node', 'wt-lane'], workerStartTime: 760, childPid: 77, childArgv: ['opencode'], childStartTime: 770 }
    let workerReads = 0
    const result = terminateLane(record, {
      platform: 'linux',
      inspect: (pid: number) => pid === 76
        ? { pid: 76, argv: ['node', 'wt-lane'], startTime: ++workerReads === 1 ? 760 : 761, groupId: 76 }
        : { pid: 77, argv: ['opencode'], startTime: 770, groupId: 76 },
      kill,
      graceMs: 0,
    })
    expect(result).toMatchObject({ killed: false, reason: 'identity-changed' })
    expect(kill).not.toHaveBeenCalled()
  })

  it('terminates the verified worker group and journals what it killed without reading host pids', () => {
    const kill = vi.fn()
    const journal = vi.fn()
    const workerPid = process.pid
    const childPid = workerPid + 1
    const record = { runId: `${workerPid}-1`, state: 'running', worktree: '/lane', workerPid, workerArgv: ['node'], workerStartTime: workerPid * 10, childPid, childArgv: ['opencode'], childStartTime: childPid * 10 }
    let live = true
    const inspect = (pid: number) => live ? { pid, argv: pid === workerPid ? ['node'] : ['opencode'], startTime: pid * 10, groupId: workerPid, cwd: '/lane' } : null
    kill.mockImplementation((_pid, signal) => { if (signal === 'SIGKILL') live = false })
    expect(terminateLane(record, { platform: 'linux', inspect, kill, journal, graceMs: 0, processExists: () => false, source: 'test', recordWorktree: '/lane' })).toMatchObject({ killed: true, reason: 'terminated' })
    expect(kill.mock.calls).toEqual([[-workerPid, 'SIGTERM'], [-workerPid, 'SIGKILL']])
    expect(journal).toHaveBeenCalledWith(expect.objectContaining({ event: 'terminated', runId: `${workerPid}-1`, source: 'test', workerPid, childPid }))
  })

  it('worker-owned clean termination journals completion without SIGKILLing its own group', () => {
    const journal = vi.fn()
    const kill = vi.fn((pid: number, signal: string | number) => { if (pid === 77 && signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    const ownedChild = { pid: 77, kill: vi.fn() }
    const record = { runId: '76-1', state: 'exited', worktree: '/lane', workerPid: 76, workerArgv: ['node'], workerStartTime: 760, childPid: 77, childArgv: ['opencode'], childStartTime: 770 }
    expect(terminateLane(record, { kill, journal, graceMs: 0, platform: 'darwin', source: 'worker', ownedChild })).toMatchObject({ killed: true, reason: 'terminated' })
    expect(kill.mock.calls).toEqual([[-76, 'SIGTERM'], [77, 0]])
    expect(journal).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'terminated' }))
  })

  it('refuses external Windows tree termination legibly', () => {
    const kill = vi.fn()
    const worker = { pid: 76, argv: ['node wt-lane'], startTime: 760, groupId: 1, cwd: null }
    const child = { pid: 77, argv: ['opencode run'], startTime: 770, groupId: 76, cwd: null }
    const record = { runId: '76-1', state: 'running', worktree: 'C:\\lane', workerPid: 76, workerArgv: worker.argv, workerStartTime: worker.startTime, childPid: 77, childArgv: child.argv, childStartTime: child.startTime }
    const inspect = (pid: number) => pid === worker.pid ? worker : child
    expect(terminateLane(record, { platform: 'win32', inspect, kill, graceMs: 0, source: 'control', recordWorktree: record.worktree })).toMatchObject({ killed: false, reason: 'external-tree-termination-unavailable-win32' })
    expect(kill).not.toHaveBeenCalled()
  })

  it('refuses an external kill when the record origin or child cwd is outside the worktree', () => {
    const kill = vi.fn()
    const journal = vi.fn()
    const root = mkdtempSync(join(tmpdir(), 'lane-paths-'))
    const lane = join(root, 'lane'); const other = join(root, 'other'); const forged = join(root, 'forged')
    mkdirSync(lane); mkdirSync(other); mkdirSync(forged)
    try {
      const record = { runId: '76-1', state: 'abandoned', worktree: lane, workerPid: 76, workerArgv: ['node'], workerStartTime: 760, childPid: 77, childArgv: ['opencode'], childStartTime: 770 }
      const inspect = (pid: number) => pid === 76 ? null : { pid, argv: ['opencode'], startTime: 770, groupId: 76, cwd: other }
      expect(terminateLane(record, { platform: 'linux', inspect, kill, journal, graceMs: 0, processExists: () => false, source: 'control', recordWorktree: lane })).toMatchObject({ killed: false, reason: 'child-cwd-outside-worktree' })
      expect(terminateLane({ ...record, worktree: forged }, { platform: 'linux', inspect, kill, journal, graceMs: 0, processExists: () => false, source: 'watcher', recordWorktree: lane })).toMatchObject({ killed: false, reason: 'record-worktree-mismatch' })
      expect(kill).not.toHaveBeenCalled()
      expect(journal).toHaveBeenCalledWith(expect.objectContaining({ event: 'termination-refused' }))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('distinguishes an unreadable child cwd from an outside cwd', () => {
    const record = { runId: '76-1', state: 'abandoned', worktree: '/lane', workerPid: 76, workerArgv: ['node'], workerStartTime: 760, childPid: 77, childArgv: ['opencode'], childStartTime: 770 }
    const inspect = (pid: number) => pid === 76 ? null : { pid, argv: ['opencode'], startTime: 770, groupId: 76, cwd: null }
    expect(terminateLane(record, { platform: 'linux', inspect, kill: vi.fn(), graceMs: 0, processExists: () => false, source: 'control', recordWorktree: '/lane' })).toMatchObject({ killed: false, reason: 'child-cwd-unreadable' })
  })

  it('refuses an in-worktree Linux target when identity evidence changes', () => {
    const kill = vi.fn()
    const record = { runId: '76-1', state: 'abandoned', worktree: '/lane', workerPid: 76, workerArgv: ['node'], workerStartTime: 760, childPid: 77, childArgv: ['opencode'], childStartTime: 770 }
    const inspect = (pid: number) => pid === 76 ? null : { pid, argv: ['changed'], startTime: 770, groupId: 76, cwd: '/lane/subdir' }
    expect(terminateLane(record, { platform: 'linux', inspect, kill, graceMs: 0, source: 'control', recordWorktree: '/lane' })).toMatchObject({ killed: false, reason: 'identity-unreadable' })
    expect(kill).not.toHaveBeenCalled()
  })

  it('names a bounded worktree scan unknown and reports non-Linux availability', () => {
    expect(latestWorktreeWrite('/unused', { maxEntries: -1 })).toMatchObject({ at: null, bounded: true, status: 'unknown' })
    expect(supervisionUnavailableMessage('darwin')).toBe('lane supervision unavailable on darwin')
    expect(processEvidenceStatus(77, { platform: 'darwin', inspect: () => null, processExists: () => null })).toBe('unknown')
  })

  it('rotates the 10 MiB journal and keeps one previous file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-journal-'))
    const journal = join(dir, 'lane-supervisor.jsonl')
    writeFileSync(journal, Buffer.alloc(10 * 1024 * 1024))
    appendSupervisorJournal(dir, { event: 'test' })
    expect(readFileSync(`${journal}.1`)).toHaveLength(10 * 1024 * 1024)
    expect(readFileSync(journal, 'utf8')).toContain('"event":"test"')
    rmSync(dir, { recursive: true, force: true })
  })
})
