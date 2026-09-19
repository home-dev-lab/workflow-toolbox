import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { classifyLane } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { sessionLaneInFlight } from '../../../../plugin/bin/lib/wake-floor-in-flight.mjs'

type RecordValue = Record<string, unknown>

const projectDir = path.resolve('/project')
const worktree = path.join(projectDir, 'lane\nwith-newline')
const runId = '123-456'
const supervisionDir = path.join(worktree, '.lane', 'supervision')
const recordPath = path.join(supervisionDir, `${runId}.json`)

function dirent(name: string, directory = true) {
  return { name, isDirectory: () => directory, isSymbolicLink: () => false }
}

function record(overrides: RecordValue = {}): RecordValue {
  return {
    runId,
    state: 'running',
    owner: 'session',
    ownerSessionId: 'session-under-test',
    workerPid: 10,
    workerArgv: ['node', 'worker'],
    workerStartTime: 100,
    childPid: 11,
    childArgv: ['node', 'child'],
    childStartTime: 101,
    ...overrides,
  }
}

function fixture(options: {
  value?: unknown
  classify?: (value: RecordValue) => { status: string; reason?: string }
  git?: Record<string, unknown>
  umbrella?: unknown[] | Error
  supervision?: unknown[] | Error
  reads?: Map<string, string | Error>
  maxWorktrees?: number
  maxUmbrellaEntries?: number
  maxRecords?: number
  sessionId?: unknown
} = {}) {
  const value = Object.hasOwn(options, 'value') ? options.value : record()
  const reads = options.reads ?? new Map([[recordPath, JSON.stringify(value)]])
  const readdirImpl = vi.fn((dirPath: string) => {
    if (dirPath === path.join(projectDir, '.claude', 'worktrees')) {
      if (options.umbrella instanceof Error) throw options.umbrella
      return options.umbrella ?? []
    }
    if (dirPath === path.join(projectDir, '.lane', 'supervision')) {
      const error = Object.assign(new Error('missing'), { code: 'ENOENT' })
      throw error
    }
    if (dirPath === supervisionDir) {
      if (options.supervision instanceof Error) throw options.supervision
      return options.supervision ?? [dirent(`${runId}.json`, false)]
    }
    const error = Object.assign(new Error('missing'), { code: 'ENOENT' })
    throw error
  })
  const readFileImpl = vi.fn((filePath: string) => {
    const value = reads.get(filePath)
    if (value instanceof Error) throw value
    if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return value
  })
  const spawnSyncImpl = vi.fn(() => options.git ?? {
    status: 0,
    stdout: `worktree ${projectDir}\0HEAD abc\0\0worktree ${worktree}\0HEAD def\0\0`,
    stderr: '',
  })
  const classify = vi.fn(options.classify ?? (() => ({ status: 'running' })))
  const result = sessionLaneInFlight({
    projectDir,
    sessionId: options.sessionId === undefined ? 'session-under-test' : options.sessionId,
    readdirImpl,
    readFileImpl,
    spawnSyncImpl,
    classify,
    maxWorktrees: options.maxWorktrees,
    maxUmbrellaEntries: options.maxUmbrellaEntries,
    maxRecords: options.maxRecords,
  })
  return { classify, readdirImpl, result, spawnSyncImpl }
}

describe('sessionLaneInFlight', () => {
  it.each(['running', 'decision-needed', 'launching'])('treats an owned %s lane as in flight', (status) => {
    expect(fixture({ classify: () => ({ status }) }).result.status).toBe('in-flight')
  })

  it.each([
    ['pilot', record({ owner: 'pilot' })],
    ['foreign', record({ ownerSessionId: 'other-session' })],
  ])('ignores a live %s lane without classifying it', (_label, value) => {
    const { classify, result } = fixture({ value })
    expect(result.status).toBe('none')
    expect(classify).not.toHaveBeenCalled()
  })

  it.each(['gone', 'terminal', 'worker-gone-child-alive'])('does not suppress for %s', (status) => {
    expect(fixture({ classify: () => ({ status }) }).result.status).toBe('none')
  })

  it('classifies launch-failed before missing ownership', () => {
    expect(fixture({ value: { runId, state: 'launch-failed' } }).result.status).toBe('none')
  })

  it.each([
    record({ owner: 'robot' }),
    record({ owner: 42 }),
    record({ owner: null }),
    record({ owner: undefined }),
    record({ owner: 'Session' }),
    record({ ownerSessionId: null }),
    record({ ownerSessionId: 42 }),
    record({ ownerSessionId: {} }),
    record({ ownerSessionId: ['session-under-test'] }),
    record({ ownerSessionId: true }),
  ])('treats live malformed ownership as unknown', (value) => {
    expect(fixture({ value }).result).toMatchObject({ status: 'unknown', reason: 'lane ownership unattributable' })
  })

  it('ignores malformed ownership only when the lane is provably terminal', () => {
    expect(fixture({ value: record({ owner: 'robot' }), classify: () => ({ status: 'terminal' }) }).result.status).toBe('none')
  })

  it('treats a missing current session id as unknown for a live session lane', () => {
    expect(fixture({ sessionId: '' }).result.status).toBe('unknown')
  })

  it('does not silence for incomplete recorded process identity', () => {
    const value = record({ workerArgv: null, workerStartTime: null, workerIdentity: 'unavailable (proc)' })
    expect(fixture({ value, classify: classifyLane }).result.status).toBe('unknown')
  })

  it.each([
    [{ error: new Error('spawn') }, 'git worktree list unavailable'],
    [{ status: 1, stdout: '', stderr: 'fatal: other error' }, 'git worktree list unavailable'],
    [{ status: 0, stdout: '', stderr: '' }, 'git worktree list unavailable'],
  ])('fires unknown when git discovery is unavailable', (git, reason) => {
    expect(fixture({ git }).result).toMatchObject({ status: 'unknown', reason })
  })

  it('uses C locale and NUL-delimited git porcelain', () => {
    const { spawnSyncImpl } = fixture()
    expect(spawnSyncImpl).toHaveBeenCalledWith('git', ['-C', projectDir, 'worktree', 'list', '--porcelain', '-z'], expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C' }) }))
  })

  it('discovers supervision records through host-native paths', () => {
    const { readdirImpl, result } = fixture()
    expect(result.status).toBe('in-flight')
    expect(readdirImpl).toHaveBeenCalledWith(supervisionDir, { withFileTypes: true })
  })

  it('accepts a non-git umbrella project as known empty', () => {
    const git = { status: 128, stdout: '', stderr: 'fatal: not a git repository' }
    expect(fixture({ git, supervision: [] }).result.status).toBe('none')
  })

  it.each([
    ['umbrella unreadable', { umbrella: Object.assign(new Error('denied'), { code: 'EACCES' }), supervision: [] }],
    ['supervision unreadable', { supervision: Object.assign(new Error('denied'), { code: 'EACCES' }) }],
    ['record unreadable', { reads: new Map([[recordPath, new Error('denied')]]) }],
    ['record malformed', { reads: new Map([[recordPath, '{bad']]) }],
    ['record array', { value: [] }],
    ['record null', { value: null }],
  ])('returns unknown when %s', (_label, options) => {
    expect(fixture(options).result.status).toBe('unknown')
  })

  it('reports each bounded discovery as unknown', () => {
    expect(fixture({ umbrella: [dirent('a'), dirent('b')], maxUmbrellaEntries: 1, supervision: [] }).result.reason).toContain('umbrella scan capped')
    expect(fixture({ maxWorktrees: 1, supervision: [] }).result.reason).toContain('worktree scan capped')
    expect(fixture({ supervision: [dirent('1-1.json', false), dirent('2-2.json', false)], maxRecords: 1 }).result.reason).toContain('record scan capped')
  })

  it('prioritises current.json so a live current lane wins over capped history', () => {
    const current = `${supervisionDir}/current.json`
    const reads = new Map<string, string | Error>([
      [current, JSON.stringify({ runId })],
      [recordPath, JSON.stringify(record())],
    ])
    const supervision = [dirent('current.json', false), dirent(`${runId}.json`, false), ...Array.from({ length: 5 }, (_, i) => dirent(`${i + 1}-${i + 1}.json`, false))]
    expect(fixture({ reads, supervision, maxRecords: 2 }).result.status).toBe('in-flight')
  })

  it('treats a current pointer whose record is missing as unknown', () => {
    const current = `${supervisionDir}/current.json`
    const reads = new Map<string, string | Error>([[current, JSON.stringify({ runId })]])
    expect(fixture({ reads, supervision: [dirent('current.json', false)] }).result.status).toBe('unknown')
  })

  it('lets a positive owned lane win over other unknown evidence', () => {
    const umbrella = Object.assign(new Error('denied'), { code: 'EACCES' })
    expect(fixture({ umbrella }).result.status).toBe('in-flight')
  })

  it('converts a classifier throw to unknown', () => {
    expect(fixture({ classify: () => { throw new Error('boom') } }).result).toMatchObject({ status: 'unknown', reason: 'lane classification threw' })
  })
})
