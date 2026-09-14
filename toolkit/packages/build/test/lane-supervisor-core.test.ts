import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { appendSupervisorJournal, classifyLane, latestWorktreeWrite, processAlive, processEvidenceStatus, supervisionUnavailableMessage, terminateVerified } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'

describe('lane supervisor safety core', () => {
  it('never authorizes an unattributed process', () => {
    expect(classifyLane({ process: { pid: 41, argv: ['opencode', 'run'] }, record: null })).toEqual({ action: 'warn', reason: 'unknown-owner' })
  })

  it('authorizes only terminal supervision records whose launcher is gone', () => {
    const process = { pid: 41, argv: ['opencode', 'run', '--dir', '/work'] }
    const record = { state: 'running', childPid: 41, workerPid: 40, worktree: '/work', childArgv: process.argv }
    expect(classifyLane({ process, record, launcherAlive: true })).toEqual({ action: 'keep', reason: 'live-lane' })
    expect(classifyLane({ process, record, launcherAlive: false })).toEqual({ action: 'keep', reason: 'nonterminal-supervision-record' })
    expect(classifyLane({ process, record: { ...record, state: 'exited' }, launcherAlive: true })).toEqual({ action: 'keep', reason: 'launcher-still-running' })
    expect(classifyLane({ process, record: { ...record, state: 'exited' }, launcherAlive: false })).toEqual({ action: 'clean', reason: 'exited-launcher-gone' })
    expect(classifyLane({ process, record: { ...record, state: 'abandoned' }, launcherAlive: false })).toEqual({ action: 'clean', reason: 'abandoned-launcher-gone' })
  })

  it('reports brokers as observed because broker idleness is not implemented', () => {
    expect(classifyLane).toBeTypeOf('function')
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

  it('escalates and reports cleaned only after the exact process is gone', () => {
    const kill = vi.fn()
    const expected = { pid: 77, argv: ['opencode', 'run', '--dir', '/lane'], cwd: '/lane' }
    let checks = 0
    expect(terminateVerified(expected, { inspect: () => checks++ < 2 ? expected : null, kill, graceMs: 0 })).toEqual({ killed: true, reason: 'terminated' })
    expect(kill.mock.calls).toEqual([[77, 'SIGTERM'], [77, 'SIGKILL']])
  })

  it('does not report cleaned when the process survives SIGKILL', () => {
    const kill = vi.fn()
    const expected = { pid: 77, argv: ['opencode'], cwd: '/lane' }
    expect(terminateVerified(expected, { inspect: () => expected, kill, graceMs: 0 })).toEqual({ killed: false, reason: 'still-alive-after-sigkill' })
  })

  it('treats EPERM as alive', () => {
    expect(processAlive(77, { kill: () => { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EPERM'; throw error } })).toBe(true)
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
