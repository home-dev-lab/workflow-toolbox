import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    const worker = { pid: 40, argv: ['node', 'wt-lane.mjs', '--worker'] }
    const child = { pid: 41, argv: ['opencode', 'run'] }
    const record = { runId: '40-1', state: 'running', workerPid: worker.pid, workerArgv: worker.argv, childPid: child.pid, childArgv: child.argv, worktree: '/work' }
    const inspect = (pid: number) => pid === worker.pid ? worker : pid === child.pid ? child : null
    expect(classifyLane(record, { inspect })).toMatchObject({ status: 'running', worker: 'running', child: 'running' })
    expect(classifyLane({ ...record, state: 'decision-needed' }, { inspect })).toMatchObject({ status: 'decision-needed' })
    expect(classifyLane({ ...record, state: 'abandoned' }, { inspect })).toMatchObject({ status: 'unknown', reason: 'inconsistent-record' })
    expect(classifyLane({ ...record, state: 'abandoned' }, { inspect: (pid: number) => pid === worker.pid ? worker : null })).toMatchObject({ status: 'terminal' })
    expect(classifyLane(record, { inspect: (pid: number) => pid === child.pid ? child : null })).toMatchObject({ status: 'worker-gone-child-alive' })
    expect(classifyLane(record, { inspect: () => null })).toMatchObject({ status: 'gone' })
    expect(classifyLane(record, { inspect: (pid: number) => pid === worker.pid ? { ...worker, argv: ['unrelated'] } : child })).toMatchObject({ status: 'worker-gone-child-alive' })
  })

  it('is unknown off Linux even when neither pid can be inspected', () => {
    const record = { runId: '40-1', state: 'running', workerPid: 40, workerArgv: ['node'], childPid: 41, childArgv: ['opencode'], worktree: '/work' }
    expect(classifyLane(record, { platform: 'darwin', inspect: () => null })).toMatchObject({ status: 'unknown', worker: 'unknown', child: 'unknown' })
  })

  it('re-verifies both identities immediately before terminating and refuses a reused pid', () => {
    const kill = vi.fn()
    const record = { runId: '76-1', state: 'running', worktree: '/lane', workerPid: 76, workerArgv: ['node', 'wt-lane'], childPid: 77, childArgv: ['opencode'] }
    const result = terminateLane(record, {
      inspect: (pid: number) => pid === 76 ? { pid: 76, argv: ['unrelated'] } : { pid: 77, argv: ['opencode'] },
      kill,
      graceMs: 0,
    })
    expect(result).toMatchObject({ killed: false, reason: 'identity-changed' })
    expect(kill).not.toHaveBeenCalled()
  })

  it('terminates the verified worker group and journals what it killed', () => {
    const kill = vi.fn()
    const journal = vi.fn()
    const record = { runId: '76-1', state: 'running', worktree: '/lane', workerPid: 76, workerArgv: ['node'], childPid: 77, childArgv: ['opencode'] }
    let live = true
    const inspect = (pid: number) => live ? { pid, argv: pid === 76 ? ['node'] : ['opencode'], groupId: 76 } : null
    kill.mockImplementation((_pid, signal) => { if (signal === 'SIGKILL') live = false })
    expect(terminateLane(record, { inspect, kill, journal, graceMs: 0, source: 'test' })).toMatchObject({ killed: true, reason: 'terminated' })
    expect(kill.mock.calls).toEqual([[-76, 'SIGTERM'], [-76, 'SIGKILL']])
    expect(journal).toHaveBeenCalledWith(expect.objectContaining({ event: 'terminated', runId: '76-1', source: 'test', workerPid: 76, childPid: 77 }))
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
