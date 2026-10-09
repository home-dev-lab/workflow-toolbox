import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error ESM runtime module
import { parse, reportWorkerReturnedBeforeSpawn, spawnAndReportOpencode } from '../../../../plugin/bin/wt-lane.mjs'
// @ts-expect-error ESM runtime module
import { inspectProcess, readCurrentSupervision, supervisionPaths, supervisionSlots } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'
// @ts-expect-error ESM runtime module
import { makeReadableLaneBrief, readLifecycleRegular, readWorktreeRegular } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'
// @ts-expect-error ESM runtime module
import { appendLaunchFailure, awaitChildSpawn, ensureLaneHostDir, laneHostDir, laneHostStateRoot, laneWritablePath } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'

it.each(['spawn', 'error', 'timeout', 'null-error', 'undefined-error'])('settles child spawn on %s and clears its listeners and timer', async (event) => {
  vi.useFakeTimers()
  try {
    const child = new EventEmitter()
    const error = event === 'null-error' ? null : event === 'undefined-error' ? undefined : new Error('spawn unavailable')
    const result = awaitChildSpawn(child, { timeoutMs: 50 }).then(
      () => ({ status: 'spawned' }),
      (failure: Error | null | undefined) => ({ status: 'failed', failure }),
    )
    expect(vi.getTimerCount()).toBe(1)
    if (event === 'timeout') await vi.advanceTimersByTimeAsync(50)
    else child.emit(event.endsWith('-error') ? 'error' : event, error)
    const settled = await result
    if (event === 'spawn') expect(settled).toEqual({ status: 'spawned' })
    else if (event !== 'timeout') {
      expect(settled.status).toBe('failed')
      expect(settled.failure).toBe(error)
    }
    else expect(settled).toMatchObject({ status: 'failed', failure: { message: 'opencode reported neither spawn nor error within 0.05 s' } })
    expect(child.listenerCount('spawn')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

it('appends a launch failure once and leaves existing terminal logs untouched', () => {
  const log = join(fixture().dir, 'run.log')
  writeFileSync(log, 'stage=starting\n')
  appendLaunchFailure(log, 'worker stopped')
  appendLaunchFailure(log, 'worker stopped again')
  expect(readFileSync(log, 'utf8')).toBe('stage=starting\nwt-lane: launch-failed: worker stopped\nEXIT=1\n')
  writeFileSync(log, 'EXIT=0\n\n')
  appendLaunchFailure(log, 'late failure')
  expect(readFileSync(log, 'utf8')).toBe('EXIT=0\n\n')
})

it('reports to a missing log and tolerates unavailable log writes', () => {
  const { dir } = fixture()
  const log = join(dir, 'new.log')
  appendLaunchFailure(log, 'no child')
  expect(readFileSync(log, 'utf8')).toBe('wt-lane: launch-failed: no child\nEXIT=1\n')
  expect(() => appendLaunchFailure(dir, 'cannot write')).not.toThrow()
  expect(() => appendLaunchFailure(undefined, 'no log')).not.toThrow()
})

it.each(['spawn', 'error', 'throw'])('keeps worker spawn/report ordering for %s', async (event) => {
  const log = join(fixture().dir, 'run.log')
  writeFileSync(log, '')
  const child = new EventEmitter()
  const calls: string[] = []
  const error = new Error('unavailable')
  const spawned = await spawnAndReportOpencode({
    spawnOpencode: () => {
      calls.push('start')
      if (event === 'throw') throw error
      queueMicrotask(() => child.emit(event, error))
      return child
    },
    onChild: () => { calls.push('child') },
    onSpawn: () => { calls.push('spawned') },
    cleanup: () => { calls.push('cleanup') },
    writeFailure: (reason: string) => {
      expect(readFileSync(log, 'utf8')).toBe('')
      calls.push(reason)
    },
    log, timeoutMs: 50,
  })
  expect(spawned).toBe(event === 'spawn' ? child : null)
  expect(calls).toEqual(event === 'spawn' ? ['start', 'child', 'spawned'] : [
    'start', ...(event === 'error' ? ['child'] : []), 'cleanup', 'opencode spawn failed: unavailable',
  ])
  expect(readFileSync(log, 'utf8')).toBe(event === 'spawn' ? '' : 'wt-lane: launch-failed: opencode spawn failed: unavailable\nEXIT=1\n')
})

it('still logs and kills a timed-out child when writing supervision fails', async () => {
  vi.useFakeTimers()
  try {
    const log = join(fixture().dir, 'run.log')
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => { throw new Error('already gone') }) })
    const failure = new Error('record unavailable')
    const result = spawnAndReportOpencode({
      spawnOpencode: () => child, onChild: () => {}, onSpawn: () => {}, cleanup: () => {},
      writeFailure: () => { throw failure }, log, timeoutMs: 50,
    }).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(50)
    expect(await result).toBeNull()
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    const contents = readFileSync(log, 'utf8')
    expect(contents).toMatch(/within 0\.05 s; supervision record not written: record unavailable\nEXIT=1\n$/)
    expect(contents.match(/^EXIT=/gm)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

it('retains the spawn reason when cleanup throws', async () => {
  const log = join(fixture().dir, 'run.log')
  const reasons: string[] = []
  const result = await spawnAndReportOpencode({
    spawnOpencode: () => { throw new Error('spawn denied') }, onChild: () => {}, onSpawn: () => {},
    cleanup: () => { throw new Error('cleanup denied') }, writeFailure: (reason: string) => reasons.push(reason), log,
  }).catch((error: Error) => error)
  expect(result).toBeNull()
  expect(reasons).toEqual(['opencode spawn failed: spawn denied'])
  expect(readFileSync(log, 'utf8')).toBe('wt-lane: launch-failed: opencode spawn failed: spawn denied\nEXIT=1\n')
})

it('absorbs a late child error after successful spawn', async () => {
  const child = new EventEmitter()
  const result = await spawnAndReportOpencode({
    spawnOpencode: () => { queueMicrotask(() => child.emit('spawn')); return child },
    onChild: () => {}, onSpawn: () => {}, cleanup: () => {}, writeFailure: () => {},
    log: join(fixture().dir, 'run.log'),
  })
  expect(result).toBe(child)
  expect(() => child.emit('error', new Error('late'))).not.toThrow()
  expect((child as EventEmitter & { lateSpawnError: Error }).lateSpawnError.message).toBe('late')
})

it.each([undefined, 2])('reports a worker return or drain with exit code %s', (exitCode) => {
  const { dir, worktree } = fixture()
  const log = join(dir, 'run.log')
  reportWorkerReturnedBeforeSpawn({ dir: worktree, runId: '1-1', log, exitCode })
  const reason = exitCode === undefined ? "worker's event loop drained before opencode spawned (no exit code)" : 'worker returned before spawning opencode (exit code 2)'
  expect(readFileSync(log, 'utf8')).toBe(`wt-lane: launch-failed: ${reason}\nEXIT=1\n`)
})

it('reports a worker failure even when its host state cannot be resolved', () => {
  const { dir } = fixture()
  const log = join(dir, 'run.log')
  const previous = process.env.WT_LANE_HOST_STATE
  process.env.WT_LANE_HOST_STATE = 'relative-state-is-invalid'
  try {
    expect(() => reportWorkerReturnedBeforeSpawn({ dir: join(dir, 'missing'), runId: '1-1', log, exitCode: 1 })).not.toThrow()
    expect(readFileSync(log, 'utf8')).toBe('wt-lane: launch-failed: worker returned before spawning opencode (exit code 1)\nEXIT=1\n')
  } finally {
    if (previous === undefined) delete process.env.WT_LANE_HOST_STATE
    else process.env.WT_LANE_HOST_STATE = previous
  }
})

it.each([false, true])('bounds a never-spawning worker child with live handle=%s', (liveHandle) => {
  const { dir } = fixture()
  const script = join(dir, 'drain.mjs'), log = join(dir, 'run.log'), record = join(dir, 'record.json')
  const launcher = new URL('../../../../plugin/bin/wt-lane.mjs', import.meta.url).href
  const helper = new URL('../../../../plugin/bin/lib/host/lane-host-dir.mjs', import.meta.url).href
  writeFileSync(script, `
    import { EventEmitter } from 'node:events';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { spawnAndReportOpencode } from ${JSON.stringify(launcher)};
    import { appendLaunchFailure } from ${JSON.stringify(helper)};
    const log = ${JSON.stringify(log)}, record = ${JSON.stringify(record)};
    writeFileSync(log, ''); writeFileSync(record, JSON.stringify({ state: 'launching' }));
    process.once('beforeExit', () => {
      if (JSON.parse(readFileSync(record)).state !== 'launching') return;
      writeFileSync(record, JSON.stringify({ state: 'launch-failed', reason: 'worker drained' }));
      appendLaunchFailure(log, 'worker drained');
    });
    const handle = ${liveHandle} ? setInterval(() => {}, 1000) : null;
    const child = new EventEmitter();
    child.kill = signal => { clearInterval(handle); writeFileSync(${JSON.stringify(join(dir, 'killed'))}, signal); };
    const spawned = await spawnAndReportOpencode({
      spawnOpencode: () => child, onChild: () => {}, onSpawn: () => {}, cleanup: () => {}, log, timeoutMs: 50,
      writeFailure: reason => { writeFileSync(record, JSON.stringify({ state: 'launch-failed', reason })); }
    });
    process.exitCode = spawned ? 0 : 1; process.stdout.write('settled\\n');
  `)
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(1)
  expect(result.stdout).toBe('settled\n')
  expect(JSON.parse(readFileSync(record, 'utf8')).reason).toBe('opencode spawn failed: opencode reported neither spawn nor error within 0.05 s')
  expect(readFileSync(join(dir, 'killed'), 'utf8')).toBe('SIGKILL')
  expect(readFileSync(log, 'utf8')).toBe('wt-lane: launch-failed: opencode spawn failed: opencode reported neither spawn nor error within 0.05 s\nEXIT=1\n')
})

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) { rmSync(laneHostDir(join(dir, 'worktree')), { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }) } })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lane-host-state-'))
  dirs.push(dir)
  const worktree = join(dir, 'worktree')
  mkdirSync(join(worktree, '.lane'), { recursive: true })
  writeFileSync(join(worktree, 'brief.md'), '# brief\n')
  return { dir, worktree }
}

it.skipIf(process.platform === 'win32')('keys canonical worktrees identically and stores supervision outside the worktree', () => {
  const { dir, worktree } = fixture()
  const alias = join(dir, 'alias')
  symlinkSync(worktree, alias)
  const options = { base: join(dir, 'state') }
  expect(laneHostDir(alias, options)).toBe(laneHostDir(worktree, options))
  expect(supervisionPaths(worktree, '1-1').record).not.toContain(join(worktree, '.lane'))
})

it.skipIf(process.platform === 'win32')('keeps the host-state key when a worktree disappears beneath an aliased parent', () => {
  const { dir, worktree } = fixture()
  const alias = join(dir, 'parent-alias')
  symlinkSync(dir, alias, 'dir')
  const options = { base: join(dir, 'state'), platform: 'darwin' }
  const before = laneHostDir(worktree, options)
  rmSync(worktree, { recursive: true })
  expect(laneHostDir(join(alias, 'worktree'), options)).toBe(before)
  expect(laneHostDir(worktree, options)).toBe(before)
})

it('reads an existing terminal host record after the worktree is removed', () => {
  const { worktree } = fixture()
  const paths = supervisionPaths(worktree, '1-1')
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.pointer, JSON.stringify({ runId: '1-1' }))
  writeFileSync(paths.record, JSON.stringify({ runId: '1-1', state: 'exited', exit: 7 }))
  rmSync(worktree, { recursive: true })
  expect(readCurrentSupervision(worktree)).toMatchObject({ runId: '1-1', exit: 7 })
})

it('ignores forged lane supervision records and decisions', () => {
  const { worktree } = fixture()
  const legacy = join(worktree, '.lane', 'supervision')
  mkdirSync(legacy)
  writeFileSync(join(legacy, 'current.json'), JSON.stringify({ runId: '1-1' }))
  writeFileSync(join(legacy, '1-1.json'), JSON.stringify({ runId: '1-1', childPid: process.pid }))
  writeFileSync(join(legacy, '1-1.decision.json'), JSON.stringify({ runId: '1-1', decision: 'extend' }))
  expect(supervisionSlots(worktree)).toEqual([])
  expect(supervisionPaths(worktree, '1-1').decision).not.toBe(join(legacy, '1-1.decision.json'))
})

it('never uses a lane-writable default log or accepts an explicit one', () => {
  const { worktree } = fixture()
  const args = ['--dir', worktree, '--model', 'openai/gpt-5.6-luna', '--brief', join(worktree, 'brief.md')]
  const log = join(worktree, '.lane', 'run.log')
  expect(parse(args).log).not.toBe(log)
  expect(parse([...args, '--log', log]).error).toMatch(/log.*worktree|worktree.*log/i)
})

it.skipIf(process.platform === 'win32')('refuses explicit logs and cleanup roots in operator writable binds (POSIX sandbox planner)', () => {
  const { dir, worktree } = fixture()
  const extra = join(dir, 'extra'); mkdirSync(extra)
  const args = ['--dir', worktree, '--model', 'openai/gpt-5.6-luna', '--brief', join(worktree, 'brief.md')]
  const previous = process.env.WT_LANE_SANDBOX_WRITE
  process.env.WT_LANE_SANDBOX_WRITE = extra
  try {
    expect(parse([...args, '--log', join(extra, 'run.log')]).error).toMatch(/--log.*outside/)
    expect(parse([...args, '--brief-cleanup-dir', extra]).error).toMatch(/--brief-cleanup-dir.*outside/)
  } finally {
    if (previous === undefined) delete process.env.WT_LANE_SANDBOX_WRITE
    else process.env.WT_LANE_SANDBOX_WRITE = previous
  }
})

it.skipIf(process.platform === 'win32')('refuses intermediate symlinks for worktree reads', () => {
  const { dir, worktree } = fixture()
  const outside = join(dir, 'outside'); mkdirSync(outside)
  writeFileSync(join(outside, 'report.md'), 'HOST-ONLY FIXTURE CONTENT')
  rmSync(join(worktree, '.lane'), { recursive: true })
  symlinkSync(outside, join(worktree, '.lane'))
  expect(readWorktreeRegular(join(worktree, '.lane', 'report.md'), 'utf8', worktree)).toBeNull()
  expect(readLifecycleRegular(join(worktree, '.lane', 'report.md'))).toBeNull()
})

it.skipIf(process.platform === 'win32')('accepts an operator worktree alias but refuses symlinks below its anchor', () => {
  const { dir, worktree } = fixture()
  const alias = join(dir, 'alias')
  symlinkSync(worktree, alias, 'dir')
  expect(readWorktreeRegular(join(alias, 'brief.md'), 'utf8', alias)).toBe('# brief\n')
  const outside = join(dir, 'outside'); mkdirSync(outside)
  writeFileSync(join(outside, 'report.md'), 'HOST-ONLY FIXTURE CONTENT')
  symlinkSync(outside, join(worktree, '.lane', 'planted'), 'dir')
  expect(readWorktreeRegular(join(alias, '.lane', 'planted', 'report.md'), 'utf8', alias)).toBeNull()
})

it.skipIf(process.platform !== 'linux')('does not block on FIFO lifecycle plan or tdd brief', () => {
  const { worktree } = fixture()
  for (const name of ['plan.md', 'tdd-brief.md']) {
    const file = join(worktree, '.lane', name)
    expect(spawnSync('mkfifo', [file]).status).toBe(0)
    expect(readLifecycleRegular(file)).toBeNull()
  }
})

it('allows an ordinary brief read on simulated unsandboxed Windows', () => {
  const { worktree } = fixture()
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    expect(readWorktreeRegular(join(worktree, 'brief.md'), null, worktree)?.toString()).toBe('# brief\n')
    expect(readWorktreeRegular(join(worktree, 'brief.md'), null, worktree, { unsandboxed: true })?.toString()).toBe('# brief\n')
    expect(readLifecycleRegular(join(worktree, 'brief.md'), worktree)).toBe('# brief\n')
  } finally { Object.defineProperty(process, 'platform', original) }
})

function onSimulatedWindows(check: () => void) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    check()
  } finally { Object.defineProperty(process, 'platform', original) }
}

it.skipIf(process.platform === 'win32')('refuses a symlinked leaf on simulated unsandboxed Windows', () => {
  const { dir, worktree } = fixture()
  const outside = join(dir, 'outside.md'); writeFileSync(outside, 'outside')
  const link = join(worktree, '.lane', 'report.md'); symlinkSync(outside, link)
  onSimulatedWindows(() => expect(readWorktreeRegular(link, 'utf8', worktree)).toBeNull())
})

it.skipIf(process.platform === 'win32')('refuses a symlinked parent on simulated unsandboxed Windows', () => {
  const { dir, worktree } = fixture()
  const outside = join(dir, 'outside'); mkdirSync(outside)
  writeFileSync(join(outside, 'report.md'), 'outside')
  symlinkSync(outside, join(worktree, '.lane', 'redirect'), 'dir')
  onSimulatedWindows(() => expect(readWorktreeRegular(join(worktree, '.lane', 'redirect', 'report.md'), 'utf8', worktree)).toBeNull())
})

it('refuses a file outside the supplied root on simulated unsandboxed Windows', () => {
  const { dir, worktree } = fixture()
  const outside = join(dir, 'outside.md'); writeFileSync(outside, 'outside')
  onSimulatedWindows(() => expect(readWorktreeRegular(outside, 'utf8', worktree)).toBeNull())
})

it.skipIf(process.platform === 'win32')('refuses a host state root that is not absolute on this host instead of creating it under the working directory', () => {
  expect(() => laneHostStateRoot({ platform: 'win32', env: {}, home: '\\home\\someone', insideSandbox: false })).toThrow(/not an absolute path on this host/)
})

it.skipIf(process.platform === 'win32')('refuses an explicit log in another worktree’s protected host directory (POSIX sandbox planner)', () => {
  const { dir, worktree } = fixture()
  const other = join(dir, 'other-worktree')
  mkdirSync(other)
  const log = join(laneHostDir(other), 'run.log')
  const args = ['--dir', worktree, '--model', 'openai/gpt-5.6-luna', '--brief', join(worktree, 'brief.md'), '--log', log]
  expect(parse(args).error).toMatch(/another worktree host directory/i)
})

it('never places the sandbox-visible brief in a lane-writable temporary directory', () => {
  const { worktree } = fixture()
  expect(() => makeReadableLaneBrief(join(worktree, 'brief.md'), worktree, { temporaryParent: worktree }))
    .toThrow(/temporary directory.*lane worktree/i)
})

it.skipIf(process.platform === 'win32')('refuses a symlinked worktree log without modifying its target', () => {
  const { dir, worktree } = fixture()
  const target = join(dir, 'target')
  writeFileSync(target, 'untouched\n')
  symlinkSync(target, join(worktree, '.lane', 'run.log'))
  const launcher = join(process.cwd(), '..', 'plugin', 'bin', 'wt-lane.mjs')
  spawnSync(process.execPath, [launcher, '--dir', worktree, '--model', 'openai/gpt-5.6-luna', '--brief', join(worktree, 'brief.md'), '--allow-no-git'], { encoding: 'utf8', env: sealedPluginCliEnv(dir, { WT_LANE_HOST_STATE: join(dir, 'state'), WT_LANE_MIN_AVAILABLE_MIB: '0' }) })
  expect(readFileSync(target, 'utf8')).toBe('untouched\n')
})

it.skipIf(process.platform !== 'linux')('does not block on a FIFO in a lane worktree', () => {
  const { dir, worktree } = fixture()
  const fifo = join(worktree, 'brief.md')
  rmSync(fifo)
  expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
  const start = Date.now()
  expect(readWorktreeRegular(fifo)).toBeNull()
  expect(Date.now() - start).toBeLessThan(2000)
  const launcher = join(process.cwd(), '..', 'plugin', 'bin', 'wt-lane.mjs')
  const result = spawnSync(process.execPath, [launcher, '--dir', worktree, '--model', 'openai/gpt-5.6-luna', '--brief', fifo, '--allow-no-git'], { encoding: 'utf8', timeout: 2000, env: sealedPluginCliEnv(dir, { WT_LANE_MIN_AVAILABLE_MIB: '0' }) })
  expect((result.error as NodeJS.ErrnoException | undefined)?.code).not.toBe('ETIMEDOUT')
})

it('hashes case-insensitive platform canonical paths to the same key', () => {
  const { dir, worktree } = fixture()
  const options = { platform: 'darwin', base: join(dir, 'state'), realpath: (value: string) => value }
  expect(laneHostDir(worktree, options)).toBe(laneHostDir(worktree.toUpperCase(), options))
})

it.skipIf(process.platform !== 'linux')('refuses launch while a legacy record names a live worker and child', () => {
  const { dir, worktree } = fixture()
  const legacy = join(worktree, '.lane', 'supervision')
  mkdirSync(legacy)
  const id = '1-1'
  writeFileSync(join(legacy, 'current.json'), JSON.stringify({ runId: id }))
  const identity = inspectProcess(process.pid)
  writeFileSync(join(legacy, `${id}.json`), JSON.stringify({ runId: id, state: 'launch-failed', workerPid: process.pid, workerArgv: identity.argv, workerStartTime: identity.startTime, childPid: process.pid, childArgv: identity.argv, childStartTime: identity.startTime }))
  const launcher = join(process.cwd(), '..', 'plugin', 'bin', 'wt-lane.mjs')
  const result = spawnSync(process.execPath, [launcher, '--dir', worktree, '--model', 'openai/gpt-5.6-luna', '--brief', join(worktree, 'brief.md'), '--allow-no-git'], { encoding: 'utf8', env: sealedPluginCliEnv(dir, { WT_LANE_HOST_STATE: join(dir, 'state'), WT_LANE_MIN_AVAILABLE_MIB: '0' }) })
  expect(result.stderr).toContain('Refused: legacy lane supervision may still have a live worker or child')
})

it.skipIf(process.platform !== 'linux')('waiter ignores a lane-written EXIT=0 while the host record is running', () => {
  const { dir, worktree } = fixture()
  const stateRoot = join(dir, 'state')
  const host = laneHostDir(worktree, { env: { WT_LANE_HOST_STATE: stateRoot } })
  const supervision = join(host, 'supervision')
  mkdirSync(supervision, { recursive: true })
  const identity = inspectProcess(process.pid)
  const runId = '1-1'
  writeFileSync(join(supervision, 'current.json'), JSON.stringify({ runId }))
  writeFileSync(join(supervision, `${runId}.json`), JSON.stringify({ runId, state: 'running', workerPid: process.pid, workerArgv: identity.argv, workerStartTime: identity.startTime, childPid: process.pid, childArgv: identity.argv, childStartTime: identity.startTime, log: join(host, 'run.log') }))
  writeFileSync(join(host, 'run.log'), `LANE_RUN_ID=${runId}\nEXIT=0\n`)
  const wait = join(process.cwd(), '..', 'plugin', 'bin', 'wt-lane-wait.mjs')
  const result = spawnSync(process.execPath, [wait, '--dir', worktree, '--pid', String(process.pid), '--poll', '0.01', '--timeout', '0.03'], { encoding: 'utf8', env: sealedPluginCliEnv(dir, { WT_LANE_HOST_STATE: stateRoot }) })
  expect(result.stdout).toContain('LANE TIMEOUT exit=124')
})

it('waiter rejects legacy-only records even when handed a pid', () => {
  const { dir, worktree } = fixture()
  mkdirSync(join(worktree, '.lane', 'supervision'))
  const wait = join(process.cwd(), '..', 'plugin', 'bin', 'wt-lane-wait.mjs')
  const result = spawnSync(process.execPath, [wait, '--dir', worktree, '--pid', String(process.pid), '--timeout', '0.03'], { encoding: 'utf8', env: sealedPluginCliEnv(dir, { WT_LANE_HOST_STATE: join(dir, 'state') }) })
  expect(result.status).toBe(2)
  expect(result.stderr).toContain('legacy lane supervision')
})

function withStateRoot<T>(stateRoot: string, body: () => T): T {
  const previous = process.env.WT_LANE_HOST_STATE
  process.env.WT_LANE_HOST_STATE = stateRoot
  try { return body() } finally { if (previous === undefined) delete process.env.WT_LANE_HOST_STATE; else process.env.WT_LANE_HOST_STATE = previous }
}

// Each malformed marker gets its own host state root, so each reading rule is locked on its own.
function withMarker(content: (dir: string) => string) {
  const { dir, worktree } = fixture()
  const stateRoot = join(dir, 'state')
  mkdirSync(join(stateRoot, 'a'.repeat(32)), { recursive: true })
  writeFileSync(join(stateRoot, 'a'.repeat(32), 'worktree'), content(realpathSync.native(dir)))
  return { dir, worktree, stateRoot }
}

it('never reads an empty worktree marker as a path containing every other path', () => {
  const { dir, worktree, stateRoot } = withMarker(() => '')
  withStateRoot(stateRoot, () => {
    expect(() => ensureLaneHostDir(worktree)).not.toThrow()
    expect(laneWritablePath(worktree, join(dir, 'outside', 'file.log'))).toBe(false)
  })
})

it('never reads a marker cut short before its newline as a worktree path', () => {
  const { dir, worktree, stateRoot } = withMarker((real) => real)
  const real = realpathSync.native(dir)
  withStateRoot(stateRoot, () => {
    expect(laneWritablePath(worktree, join(dir, 'outside', 'file.log'))).toBe(false)
    expect(laneWritablePath(worktree, real.slice(0, -1))).toBe(false)
  })
})

it('never reads a relative marker as a worktree path', () => {
  const { worktree, stateRoot } = withMarker(() => `${join('relative', 'child')}\n`)
  withStateRoot(stateRoot, () => expect(laneWritablePath(worktree, join('relative', 'child', 'file.log'))).toBe(false))
})

it('still reads a complete marker as a lane worktree', () => {
  const { dir, worktree, stateRoot } = withMarker((real) => `${real}\n`)
  withStateRoot(stateRoot, () => expect(laneWritablePath(worktree, join(dir, 'outside', 'file.log'))).toBe(true))
})
