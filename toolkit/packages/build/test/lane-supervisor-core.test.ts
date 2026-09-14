import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { classifyLane, classifyBroker, terminateVerified } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'

describe('lane supervisor safety core', () => {
  it('never authorizes an unattributed process', () => {
    expect(classifyLane({ process: { pid: 41, argv: ['opencode', 'run'] }, record: null })).toEqual({ action: 'warn', reason: 'unknown-owner' })
  })

  it('authorizes only terminal-log or launcher-gone lane orphans', () => {
    const process = { pid: 41, argv: ['opencode', 'run', '--dir', '/work'] }
    const record = { childPid: 41, workerPid: 40, worktree: '/work', childArgv: process.argv }
    expect(classifyLane({ process, record, terminalExit: null, launcherAlive: true })).toEqual({ action: 'keep', reason: 'live-lane' })
    expect(classifyLane({ process, record, terminalExit: '0', launcherAlive: true })).toEqual({ action: 'clean', reason: 'terminal-lane-log' })
    expect(classifyLane({ process, record, terminalExit: null, launcherAlive: false })).toEqual({ action: 'clean', reason: 'launcher-gone' })
  })

  it('cleans a broker only when idle beyond the threshold with no running task', () => {
    expect(classifyBroker({ elapsedMs: 31 * 60_000, idleMs: 31 * 60_000, hasRunningTask: false }, 30 * 60_000)).toEqual({ action: 'clean', reason: 'idle-broker' })
    expect(classifyBroker({ elapsedMs: 90 * 60_000, idleMs: 31 * 60_000, hasRunningTask: true }, 30 * 60_000)).toEqual({ action: 'keep', reason: 'broker-has-running-task' })
  })

  it('re-verifies identity immediately before kill and refuses a reused pid', () => {
    const kill = vi.fn()
    const expected = { pid: 77, argv: ['opencode', 'run', '--dir', '/lane'], cwd: '/lane' }
    const result = terminateVerified(expected, {
      inspect: () => ({ pid: 77, argv: ['node', 'unrelated.mjs'], cwd: '/other' }),
      kill,
    })
    expect(result).toEqual({ killed: false, reason: 'identity-changed' })
    expect(kill).not.toHaveBeenCalled()
  })

  it('kills by exact pid only after argv and cwd still match', () => {
    const kill = vi.fn()
    const expected = { pid: 77, argv: ['opencode', 'run', '--dir', '/lane'], cwd: '/lane' }
    expect(terminateVerified(expected, { inspect: () => expected, kill })).toEqual({ killed: true, reason: 'terminated' })
    expect(kill).toHaveBeenCalledWith(77, 'SIGTERM')
  })
})
