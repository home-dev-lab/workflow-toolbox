import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error ESM runtime module
import { parse } from '../../../../plugin/bin/wt-lane.mjs'
// @ts-expect-error ESM runtime module
import { inspectProcess, readCurrentSupervision, supervisionPaths, supervisionSlots } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'
// @ts-expect-error ESM runtime module
import { makeReadableLaneBrief, readLifecycleRegular, readWorktreeRegular } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'
// @ts-expect-error ESM runtime module
import { laneHostDir, laneHostStateRoot } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'

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
