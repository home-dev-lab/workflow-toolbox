import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { classifyLane } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { sessionBackgroundTaskInFlight, sessionLaneInFlight } from '../../../../plugin/bin/lib/wake-floor-in-flight.mjs'
// @ts-expect-error ESM runtime module
import { laneHostDir } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'

type RecordValue = Record<string, unknown>

const projectDir = path.resolve('/project')
const worktree = path.join(projectDir, 'lane\nwith-newline')
const runId = '123-456'
const supervisionDir = path.join(laneHostDir(worktree), 'supervision')
const recordPath = path.join(supervisionDir, `${runId}.json`)
const realProcessRoots: string[] = []
const realProcessChildren: ChildProcess[] = []
const fixturePlatform = (process.env.WT_WAKE_FLOOR_FIXTURE_PLATFORM ?? 'linux') as NodeJS.Platform

if (!['linux', 'darwin', 'win32'].includes(fixturePlatform)) {
  throw new Error(`unsupported WT_WAKE_FLOOR_FIXTURE_PLATFORM: ${fixturePlatform}`)
}

afterEach(() => {
  for (const child of realProcessChildren.splice(0)) child.kill('SIGKILL')
  for (const root of realProcessRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function dirent(name: string, directory = true) {
  return { name, isDirectory: () => directory, isSymbolicLink: () => false }
}

function projectSlug(dir: string): string {
  return path.resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
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
  platform?: NodeJS.Platform
  backgroundTaskProbe?: (options: { projectDir: string; sessionId: unknown }) => { status: string; reason?: string }
} = {}) {
  const value = Object.hasOwn(options, 'value') ? options.value : record()
  const reads = options.reads ?? new Map([[recordPath, JSON.stringify(value)]])
  const readdirImpl = vi.fn((dirPath: string) => {
    if (dirPath === path.join(projectDir, '.claude', 'worktrees')) {
      if (options.umbrella instanceof Error) throw options.umbrella
      return options.umbrella ?? []
    }
    if (dirPath === path.join(laneHostDir(projectDir), 'supervision')) {
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
    backgroundTaskProbe: options.backgroundTaskProbe ?? ((probeOptions) => sessionBackgroundTaskInFlight({
      ...probeOptions,
      platform: options.platform ?? fixturePlatform,
      getuidImpl: () => 1000,
    })),
    maxWorktrees: options.maxWorktrees,
    maxUmbrellaEntries: options.maxUmbrellaEntries,
    maxRecords: options.maxRecords,
  })
  return { classify, readdirImpl, result, spawnSyncImpl }
}

describe('sessionLaneInFlight', () => {
  it('finds an owned lane in a slot-scoped supervision directory', () => {
    const slotDir = path.join(laneHostDir(projectDir), 'supervision-critic-Z')
    const slotRecord = path.join(slotDir, `${runId}.json`)
    const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
    const result = sessionLaneInFlight({
      projectDir,
      sessionId: 'session-under-test',
      spawnSyncImpl: () => ({ status: 0, stdout: `worktree ${projectDir}\0HEAD abc\0\0`, stderr: '' }),
      readdirImpl: ((dirPath: string) => {
        if (dirPath === path.join(projectDir, '.claude', 'worktrees')) return []
        if (dirPath === laneHostDir(projectDir)) return [dirent('supervision-critic-Z')]
        if (dirPath === slotDir) return [dirent(`${runId}.json`, false)]
        return missing()
      }) as unknown as typeof import('node:fs').readdirSync,
      readFileImpl: ((filePath: string) => filePath === slotRecord ? JSON.stringify(record()) : missing()) as typeof import('node:fs').readFileSync,
      classify: () => ({ status: 'running' }),
      backgroundTaskProbe: () => ({ status: 'none' }),
    })

    expect(result.status).toBe('in-flight')
  })

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
    expect(fixture({ value, platform: 'linux' }).result).toMatchObject({ status: 'unknown', reason: 'lane ownership unattributable' })
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
    expect(fixture({ git, platform: 'linux' }).result).toMatchObject({ status: 'unknown', reason })
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

  it('lets an attested session background task suppress the floor', () => {
    const backgroundTaskProbe = vi.fn(() => ({ status: 'in-flight', reason: 'verified task writer' }))
    const { classify, result } = fixture({ backgroundTaskProbe })
    expect(result).toMatchObject({ status: 'in-flight', reason: 'verified task writer' })
    expect(classify).not.toHaveBeenCalled()
  })

  it('keeps inconclusive background-task evidence when no lane is live', () => {
    const backgroundTaskProbe = vi.fn(() => ({ status: 'unknown', reason: 'process table unreadable' }))
    expect(fixture({ backgroundTaskProbe, supervision: [] }).result).toMatchObject({
      status: 'unknown',
      reason: 'process table unreadable',
    })
  })

  it.each<NodeJS.Platform>(['darwin', 'win32'])('preserves a conclusive lane verdict when background-task inspection is unsupported on %s', (platform) => {
    expect(fixture({ platform, value: record({ owner: 'pilot' }) }).result).toEqual({
      status: 'none',
      reason: 'no live owned lane',
    })
  })

  it.each<NodeJS.Platform>(['darwin', 'win32'])('names unsupported background-task inspection when lane evidence is inconclusive on %s', (platform) => {
    expect(fixture({
      platform,
      git: { status: 1, stdout: '', stderr: 'fatal: other error' },
      supervision: [],
    }).result).toEqual({
      status: 'unknown',
      reason: 'git worktree list unavailable; background task inspection requires Linux procfs',
    })
  })

  it('converts a classifier throw to unknown', () => {
    expect(fixture({ platform: 'linux', classify: () => { throw new Error('boom') } }).result).toMatchObject({ status: 'unknown', reason: 'lane classification threw' })
  })
})

const taskSessionId = 'session-under-test'
const tasksDir = path.join('/tmp', 'claude-1000', projectSlug(projectDir), taskSessionId, 'tasks')
const taskOutput = path.join(tasksDir, 'abc123.output')
const procDir = path.join('/proc', '42')
const taskProcStat = `42 (zsh) S ${Array.from({ length: 19 }, (_, index) => index === 18 ? '98765' : '0').join(' ')}`
const missingFile = () => Object.assign(new Error('missing'), { code: 'ENOENT' })

type TaskOptions = {
  holderSessionId?: string
  outputOpen?: boolean
  fdChanges?: boolean
  processChangesAfterAttribution?: boolean
  procError?: Error
  argv?: string
  uid?: number
}

function taskReaddir(options: TaskOptions) {
  return vi.fn((dirPath: string) => {
    if (dirPath === tasksDir) return [dirent('abc123.output', false)]
    if (dirPath === '/proc') {
      if (options.procError) throw options.procError
      return ['42']
    }
    if (dirPath === `${procDir}/fd`) return [dirent('1', false)]
    throw missingFile()
  })
}

function taskReadFile(options: TaskOptions) {
  let statReads = 0
  return vi.fn((filePath: string) => {
    if (filePath === `${procDir}/stat`) {
      statReads += 1
      return options.processChangesAfterAttribution && statReads > 2 ? taskProcStat.replace('98765', '98766') : taskProcStat
    }
    if (filePath === `${procDir}/fdinfo/1`) return 'pos:\t0\nflags:\t0100001\n'
    if (filePath === `${procDir}/environ`) return `PATH=/usr/bin\0CLAUDE_CODE_SESSION_ID=${options.holderSessionId ?? taskSessionId}\0`
    if (filePath === `${procDir}/cmdline`) return options.argv ?? '/usr/bin/zsh\0-c\0sleep 90\0'
    throw missingFile()
  })
}

function taskReadlink(options: TaskOptions) {
  let readlinks = 0
  return vi.fn(() => {
    readlinks += 1
    return options.outputOpen === false || (options.fdChanges && readlinks > 1) ? '/dev/null' : taskOutput
  })
}

function taskFixture(options: TaskOptions = {}) {
  const result = sessionBackgroundTaskInFlight({
    projectDir,
    sessionId: taskSessionId,
    platform: 'linux',
    tmpdirImpl: () => '/tmp',
    getuidImpl: () => 1000,
    readdirImpl: taskReaddir(options),
    readFileImpl: taskReadFile(options),
    readlinkImpl: taskReadlink(options),
    statImpl: vi.fn(() => ({ uid: options.uid ?? 1000 })),
  })
  return { result }
}

// Mimics Node on a /proc that reports entries of unknown type: asking for Dirent types lstats
// every entry, so one pid that exits mid-scan fails the whole listing.
function vanishingProcListing(dirPath: string, options?: { withFileTypes?: boolean }) {
  if (dirPath === tasksDir) return [dirent('abc123.output', false)]
  if (options?.withFileTypes) throw Object.assign(new Error("ENOENT: no such file or directory, lstat '/proc/77'"), { code: 'ENOENT' })
  return ['1', '77', 'self', 'uptime']
}

function registerHolderCases() {
  it('treats a stable same-session writer on a task output as in flight', () => {
    expect(taskFixture().result).toMatchObject({ status: 'in-flight' })
  })
  it('does not treat a fresh leftover output file without a writer as in flight', () => {
    expect(taskFixture({ outputOpen: false }).result.status).toBe('none')
  })
  it('ignores a task output writer from another session', () => {
    expect(taskFixture({ holderSessionId: 'foreign-session' }).result.status).toBe('none')
  })
  it('ignores a task output writer owned by another user', () => {
    expect(taskFixture({ uid: 1001 }).result.status).toBe('none')
  })
  it('does not count a monitor process even if an unexpected host shape gives it a task output fd', () => {
    expect(taskFixture({ argv: 'node\0/plugin/bin/wt-wake-floor.mjs\0' }).result.status).toBe('none')
  })
}

function registerChangeCases() {
  it('does not attest a process without argv', () => {
    expect(taskFixture({ argv: '' }).result).toMatchObject({ status: 'unknown', reason: 'background task argv unreadable' })
  })
  it('returns unknown when the matched fd changes during attribution', () => {
    expect(taskFixture({ fdChanges: true }).result).toMatchObject({ status: 'unknown', reason: 'background task fd identity changed' })
  })
  it('returns unknown when the process identity changes during final descriptor attribution', () => {
    expect(taskFixture({ processChangesAfterAttribution: true }).result).toMatchObject({ status: 'unknown', reason: 'background task process identity changed' })
  })
  it('returns unknown when proc cannot be inspected', () => {
    const procError = Object.assign(new Error('denied'), { code: 'EACCES' })
    expect(taskFixture({ procError }).result).toMatchObject({ status: 'unknown', reason: 'process table unreadable' })
  })
}

function registerVanishedPidCase() {
  it('reads a pid that exits during the process listing as gone, not as an unreadable table', () => {
    const gone = () => { throw missingFile() }
    expect(sessionBackgroundTaskInFlight({
      projectDir, sessionId: taskSessionId, platform: 'linux', tmpdirImpl: () => '/tmp', getuidImpl: () => 1000,
      readdirImpl: vanishingProcListing, readFileImpl: gone, readlinkImpl: gone, statImpl: gone,
    })).toEqual({ status: 'none' })
  })
  it('reads each option once, as parameter destructuring did', () => {
    let maxFdsReads = 0
    const options = {
      projectDir, sessionId: taskSessionId, platform: 'linux', tmpdirImpl: () => '/tmp', getuidImpl: () => 1000,
      readdirImpl: taskReaddir({}), readFileImpl: taskReadFile({}), readlinkImpl: taskReadlink({}), statImpl: vi.fn(() => ({ uid: 1000 })),
      get maxFds() { maxFdsReads += 1; return maxFdsReads === 1 ? 1_024 : 0 },
    }
    expect(sessionBackgroundTaskInFlight(options)).toMatchObject({ status: 'in-flight' })
    expect(maxFdsReads).toBe(1)
  })
}

// The fixture must not depend on how many descriptors other processes hold (card 1871442113510508198).
// Two machine dependencies are removed. First, the probe's /proc listing is scoped to the fixture's own
// children, so an unrelated same-uid process over the fd cap cannot turn an expected 'none' into
// 'unknown'. Second, every child closes the descriptors it INHERITED from whatever launched the suite
// (non-CLOEXEC, so they survive exec) before signalling ready on fd 3; otherwise a launcher holding
// more than 1,024 of them caps the writer itself and 'in-flight' reads 'unknown'.
const SHED_INHERITED = [
  "for (const name of fs.readdirSync('/proc/self/fd')) {",
  '  const fd = Number(name)',
  '  if (fd <= 3) continue',
  '  let info',
  "  try { info = fs.readFileSync('/proc/self/fdinfo/' + name, 'utf8') } catch { continue }",
  '  const flags = /^flags:\\s*([0-7]+)$/m.exec(info)',
  '  if (flags && (Number.parseInt(flags[1], 8) & 0o2000000) === 0) try { fs.closeSync(fd) } catch {}',
  '}',
  "fs.writeSync(3, 'ready')",
  'setInterval(() => {}, 1000)',
].join('\n')
const CHILD_SCRIPT = `const fs = require('node:fs')\n${SHED_INHERITED}`

async function startFixtureChild(fixturePids: Set<string>, session: string, command: string, args: string[], stdio: Array<'ignore' | number>) {
  const child = spawn(command, args, { env: { CLAUDE_CODE_SESSION_ID: session }, stdio: [...stdio, 'pipe'] })
  realProcessChildren.push(child)
  if (child.pid === undefined) throw new Error('fixture child did not start')
  fixturePids.add(String(child.pid))
  const ready = child.stdio[3]
  if (!ready) throw new Error('fixture child has no ready pipe')
  await new Promise<void>((resolve, reject) => {
    ready.once('data', () => resolve())
    child.once('exit', (code, signal) => reject(new Error(`fixture child exited before ready: ${code ?? signal}`)))
  })
  return child
}

async function stopFixtureChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await exited
}

function realProcFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'wt-background-task-proc-'))
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'wt-background-task-project-'))
  realProcessRoots.push(root, projectRoot)
  const sessionId = randomUUID()
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Linux uid unavailable')
  const realTasksDir = path.join(root, `claude-${uid}`, projectSlug(projectRoot), sessionId, 'tasks')
  mkdirSync(realTasksDir, { recursive: true })
  const fixturePids = new Set<string>()
  const scopedReaddir = (dir: string, options: { withFileTypes: true }) => dir === '/proc'
    ? readdirSync(dir).filter((name) => fixturePids.has(name))
    : readdirSync(dir, options)
  const probe = (candidateSessionId = sessionId, maxFds?: number) => sessionBackgroundTaskInFlight({
    projectDir: projectRoot,
    sessionId: candidateSessionId,
    platform: 'linux',
    tmpdirImpl: () => root,
    readdirImpl: scopedReaddir,
    ...(maxFds === undefined ? {} : { maxFds }),
  })
  const start = (command: string, args: string[], stdio: Array<'ignore' | number>) => startFixtureChild(fixturePids, sessionId, command, args, stdio)
  return { root, output: path.join(realTasksDir, 'task.output'), probe, start }
}

type RealProcFixture = ReturnType<typeof realProcFixture>

async function checkWriterScenario({ output, probe, start }: RealProcFixture) {
  const fd = openSync(output, 'w')
  const writer = await start(process.execPath, ['-e', CHILD_SCRIPT], ['ignore', fd, fd])
  closeSync(fd)
  expect(probe().status).toBe('in-flight')
  // The production fail-safe stays: a writer holding more descriptors than the cap reads 'unknown'.
  expect(probe(undefined, 3)).toEqual({ status: 'unknown', reason: 'process fd scan capped at 3' })
  expect(probe(randomUUID()).status).toBe('none')
  await stopFixtureChild(writer)
  expect(probe()).toEqual({ status: 'none' })
}

async function checkReaderScenario({ output, probe, start }: RealProcFixture) {
  const fd = openSync(output, 'r')
  const reader = await start(process.execPath, ['-e', CHILD_SCRIPT], [fd, 'ignore', 'ignore'])
  closeSync(fd)
  expect(probe().status).toBe('none')
  await stopFixtureChild(reader)
}

async function checkMonitorScenario({ root, output, probe, start }: RealProcFixture) {
  const monitor = path.join(root, 'wt-wake-floor.mjs')
  writeFileSync(monitor, `import fs from 'node:fs'\n${SHED_INHERITED}\n`)
  const fd = openSync(output, 'w')
  const monitorChild = await start(process.execPath, [monitor], ['ignore', fd, fd])
  closeSync(fd)
  expect(probe().status).toBe('none')
  await stopFixtureChild(monitorChild)
}

describe('sessionBackgroundTaskInFlight', () => {
  describe.skipIf(process.platform !== 'linux')('Linux procfs descriptor attribution (requires Linux path semantics)', () => {
    registerHolderCases()
    registerChangeCases()
    registerVanishedPidCase()
  })

  it.each(['darwin', 'win32'])('returns legible unknown on %s without inspecting procfs', (platform) => {
    const readdirImpl = vi.fn()
    expect(sessionBackgroundTaskInFlight({ projectDir, sessionId: taskSessionId, platform, readdirImpl })).toEqual({
      status: 'unknown',
      reason: 'background task inspection requires Linux procfs',
    })
    expect(readdirImpl).not.toHaveBeenCalled()
  })

  it('rejects a session id that could escape its task directory', () => {
    const readdirImpl = vi.fn()
    expect(sessionBackgroundTaskInFlight({
      projectDir,
      sessionId: '../other-session',
      platform: 'linux',
      getuidImpl: () => 1000,
      readdirImpl,
    })).toEqual({ status: 'unknown', reason: 'session id invalid' })
    expect(readdirImpl).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform !== 'linux')('attests only a live same-session non-monitor writer through real procfs', async () => {
    const env = realProcFixture()
    await checkWriterScenario(env)
    await checkReaderScenario(env)
    await checkMonitorScenario(env)
  })
})
