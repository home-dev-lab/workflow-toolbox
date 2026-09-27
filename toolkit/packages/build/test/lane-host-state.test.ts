import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error ESM runtime module
import { parse } from '../../../../plugin/bin/wt-lane.mjs'
// @ts-expect-error ESM runtime module
import { inspectProcess, supervisionPaths, supervisionSlots } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'
// @ts-expect-error ESM runtime module
import { makeReadableLaneBrief, readWorktreeRegular } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'
// @ts-expect-error ESM runtime module
import { laneHostDir } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'

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

it('refuses an explicit log in another worktree’s protected host directory', () => {
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
