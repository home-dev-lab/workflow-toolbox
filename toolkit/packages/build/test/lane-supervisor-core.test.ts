import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { appendSupervisorJournal, classifyLane, latestWorktreeWrite, processEvidenceStatus, supervisionUnavailableMessage, terminateLane } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'

describe('lane supervisor safety core', () => {
  it('returns unknown without a readable attributed record', () => {
    expect(classifyLane(null)).toMatchObject({ status: 'unknown', reason: 'invalid-record' })
  })

  it('classifies worker and child only by their recorded pid and argv identities', () => {
    const worker = { pid: 40, argv: ['node', 'wt-lane.mjs', '--worker'], startTime: 400 }
    const child = { pid: 41, argv: ['opencode', 'run'], startTime: 410 }
    const record = { runId: '40-1', state: 'running', workerPid: worker.pid, workerArgv: worker.argv, workerStartTime: worker.startTime, childPid: child.pid, childArgv: child.argv, childStartTime: child.startTime, worktree: '/work' }
    const inspect = (pid: number) => pid === worker.pid ? worker : pid === child.pid ? child : null
    expect(classifyLane(record, { inspect })).toMatchObject({ status: 'running', worker: 'running', child: 'running' })
    expect(classifyLane({ ...record, state: 'decision-needed' }, { inspect })).toMatchObject({ status: 'decision-needed' })
    expect(classifyLane({ ...record, state: 'abandoned' }, { inspect })).toMatchObject({ status: 'unknown', reason: 'inconsistent-record' })
    expect(classifyLane({ ...record, state: 'abandoned' }, { inspect: (pid: number) => pid === worker.pid ? worker : null, processExists: () => false })).toMatchObject({ status: 'terminal' })
    expect(classifyLane(record, { inspect: (pid: number) => pid === child.pid ? child : null, processExists: () => false })).toMatchObject({ status: 'worker-gone-child-alive' })
    expect(classifyLane(record, { inspect: () => null, processExists: () => false })).toMatchObject({ status: 'gone' })
    expect(classifyLane(record, { inspect: (pid: number) => pid === worker.pid ? { ...worker, argv: ['unrelated'] } : child })).toMatchObject({ status: 'unknown', reason: 'identity-unreadable' })
    expect(classifyLane(record, { inspect: (pid: number) => pid === worker.pid ? { ...worker, startTime: 401 } : child })).toMatchObject({ status: 'worker-gone-child-alive' })
  })

  it('classifies a gone worker that never spawned a child as gone', () => {
    const record = { runId: '40-1', state: 'launching', workerPid: 40, workerArgv: ['node'], workerStartTime: 400, childPid: null, childArgv: null, childStartTime: null, worktree: '/work' }
    expect(classifyLane(record, { inspect: () => null, processExists: () => false })).toMatchObject({ status: 'gone', reason: 'worker-gone-no-child' })
  })

  it('classifies a live worker that has not spawned its child as launching', () => {
    const worker = { pid: 40, argv: ['node'], startTime: 400 }
    const record = { runId: '40-1', state: 'launching', workerPid: 40, workerArgv: worker.argv, workerStartTime: worker.startTime, childPid: null, childArgv: null, childStartTime: null, worktree: '/work' }
    expect(classifyLane(record, { inspect: () => worker })).toMatchObject({ status: 'launching', child: 'not-spawned' })
  })

  it('keeps an unreadable live identity unknown through the injected process-existence seam', () => {
    const record = { runId: '40-1', state: 'running', workerPid: 40, workerArgv: ['node'], workerStartTime: 400, childPid: 41, childArgv: ['opencode'], childStartTime: 410, worktree: '/work' }
    expect(classifyLane(record, { inspect: () => null, processExists: () => true })).toMatchObject({ status: 'unknown', reason: 'identity-unreadable' })
  })

  it('classifies a live pid with an unavailable recorded start time as unknown, never gone', () => {
    const record = { runId: '40-1', state: 'running', workerPid: 40, workerArgv: ['node'], workerStartTime: null, childPid: null, childArgv: null, childStartTime: null, worktree: '/work' }
    expect(classifyLane(record, { inspect: () => ({ pid: 40, argv: ['node'], startTime: 400 }), processExists: () => true })).toMatchObject({ status: 'unknown', worker: 'unknown' })
  })

  it('is unknown off Linux even when neither pid can be inspected', () => {
    const record = { runId: '40-1', state: 'running', workerPid: 40, workerArgv: ['node'], childPid: 41, childArgv: ['opencode'], worktree: '/work' }
    expect(classifyLane(record, { platform: 'darwin', inspect: () => null })).toMatchObject({ status: 'unknown', worker: 'unknown', child: 'unknown' })
  })

  it('re-verifies both identities immediately before terminating and refuses a reused pid', () => {
    const kill = vi.fn()
    const record = { runId: '76-1', state: 'running', worktree: '/lane', workerPid: 76, workerArgv: ['node', 'wt-lane'], workerStartTime: 760, childPid: 77, childArgv: ['opencode'], childStartTime: 770 }
    let workerReads = 0
    const result = terminateLane(record, {
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
    expect(terminateLane(record, { inspect, kill, journal, graceMs: 0, processExists: () => false, source: 'test', recordWorktree: '/lane' })).toMatchObject({ killed: true, reason: 'terminated' })
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

  it('refuses an external kill when the record origin or child cwd is outside the worktree', () => {
    const kill = vi.fn()
    const journal = vi.fn()
    const root = mkdtempSync(join(tmpdir(), 'lane-paths-'))
    const lane = join(root, 'lane'); const other = join(root, 'other'); const forged = join(root, 'forged')
    mkdirSync(lane); mkdirSync(other); mkdirSync(forged)
    try {
      const record = { runId: '76-1', state: 'abandoned', worktree: lane, workerPid: 76, workerArgv: ['node'], workerStartTime: 760, childPid: 77, childArgv: ['opencode'], childStartTime: 770 }
      const inspect = (pid: number) => pid === 76 ? null : { pid, argv: ['opencode'], startTime: 770, groupId: 76, cwd: other }
      expect(terminateLane(record, { inspect, kill, journal, graceMs: 0, processExists: () => false, source: 'control', recordWorktree: lane })).toMatchObject({ killed: false, reason: 'child-cwd-outside-worktree' })
      expect(terminateLane({ ...record, worktree: forged }, { inspect, kill, journal, graceMs: 0, processExists: () => false, source: 'watcher', recordWorktree: lane })).toMatchObject({ killed: false, reason: 'record-worktree-mismatch' })
      expect(kill).not.toHaveBeenCalled()
      expect(journal).toHaveBeenCalledWith(expect.objectContaining({ event: 'termination-refused' }))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('distinguishes an unreadable child cwd from an outside cwd', () => {
    const record = { runId: '76-1', state: 'abandoned', worktree: '/lane', workerPid: 76, workerArgv: ['node'], workerStartTime: 760, childPid: 77, childArgv: ['opencode'], childStartTime: 770 }
    const inspect = (pid: number) => pid === 76 ? null : { pid, argv: ['opencode'], startTime: 770, groupId: 76, cwd: null }
    expect(terminateLane(record, { inspect, kill: vi.fn(), graceMs: 0, processExists: () => false, source: 'control', recordWorktree: '/lane' })).toMatchObject({ killed: false, reason: 'child-cwd-unreadable' })
  })

  it('refuses an in-worktree Linux target when identity evidence changes', () => {
    const kill = vi.fn()
    const record = { runId: '76-1', state: 'abandoned', worktree: '/lane', workerPid: 76, workerArgv: ['node'], workerStartTime: 760, childPid: 77, childArgv: ['opencode'], childStartTime: 770 }
    const inspect = (pid: number) => pid === 76 ? null : { pid, argv: ['changed'], startTime: 770, groupId: 76, cwd: '/lane/subdir' }
    expect(terminateLane(record, { inspect, kill, graceMs: 0, source: 'control', recordWorktree: '/lane' })).toMatchObject({ killed: false, reason: 'identity-unreadable' })
    expect(kill).not.toHaveBeenCalled()
  })

  it('names a bounded worktree scan unknown and reports non-Linux availability', () => {
    expect(latestWorktreeWrite('/unused', { maxEntries: -1 })).toMatchObject({ at: null, bounded: true, status: 'unknown' })
    expect(supervisionUnavailableMessage('darwin')).toBe('lane supervision unavailable on darwin')
    expect(processEvidenceStatus(77, { platform: 'darwin' })).toBe('unknown')
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
