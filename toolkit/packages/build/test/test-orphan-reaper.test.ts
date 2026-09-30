import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Plain ESM test-support script has no TypeScript declarations.
import { linuxStartTime, listTaggedPids, onParentDeath, parentGone, parseStatFields, reapRegisteredWorkers, reapTagged, RUN_TAG_ENV } from '../../../test-support/orphan-reaper.mjs'
// @ts-expect-error Plain ESM test-support script has no TypeScript declarations.
import { launchWatchdog } from '../../../test-support/orphan-reaper.global-setup.mjs'

const TOOLKIT = fileURLToPath(new URL('../../..', import.meta.url))
const GLOBAL_SETUP = join(TOOLKIT, 'test-support/orphan-reaper.global-setup.mjs')
const SETUP_FILE = join(TOOLKIT, 'test-support/orphan-reaper.setup.ts')
const VITEST = join(TOOLKIT, 'node_modules/vitest/vitest.mjs')
const roots: string[] = []
// Above every platform's pid ceiling, so an unfixed reaper that ignores the injected kill hits nothing.
const UNUSED_PID = 2_147_483_646

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'wt-orphan-reaper-'))
  roots.push(root)
  return root
}

function alive(pid: number) {
  try { process.kill(pid, 0) } catch { return false }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false
    } catch { return false }
  }
  return true
}

function killIfAlive(pid?: number) {
  if (pid && alive(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

function readPid(file: string) {
  try {
    const value = readFileSync(file, 'utf8')
    return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
  } catch { return undefined }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, description: string) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function nestedRun(root: string, hang: boolean) {
  const pidFile = join(root, 'keepalive.pid')
  return runNestedFixture(root, pidFile, `test('leaks a detached child', async () => {
    const { spawn } = await import('node:child_process')
     const { writeFileSync, renameSync } = await import('node:fs')
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
    child.unref()
     writeFileSync(${JSON.stringify(pidFile + '.tmp')}, String(child.pid))
     renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)})
    ${hang ? 'await new Promise(() => {})' : ''}
  }, 120000)
`)
}

function runNestedFixture(root: string, pidFile: string, source: string, env: NodeJS.ProcessEnv = {}) {
  writeFileSync(join(root, 'fixture.test.js'), source)
  const config = join(root, 'vitest.config.mjs')
  writeFileSync(config, `export default { test: { root: ${JSON.stringify(root)}, globals: true, include: ['fixture.test.js'], globalSetup: [${JSON.stringify(GLOBAL_SETUP)}], setupFiles: [${JSON.stringify(SETUP_FILE)}], pool: 'forks', testTimeout: 120000, maxWorkers: 1 } }\n`)
  const child = spawn(process.execPath, [VITEST, 'run', '--config', config], {
    cwd: TOOLKIT,
    env: { ...process.env, HOME: root, WT_SUITE_LOCK: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout!.on('data', (chunk) => { output += String(chunk) })
  child.stderr!.on('data', (chunk) => { output += String(chunk) })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve)
    child.once('error', reject)
  })
  return { child, pidFile, exited, output: () => output }
}

describe.skipIf(process.platform === 'win32')('orphan reaper (Windows has no process enumeration)', () => {
  it('kills workers before tagged descendants on parent death, even if a step throws', () => {
    const order: string[] = []
    onParentDeath({ tag: randomUUID(), registry: 'registry',
      reapRegisteredWorkers: () => { order.push('workers'); throw new Error('worker step failed') },
      reapTagged: () => { order.push('tagged') },
      removeRegistry: () => { order.push('remove') },
    })
    expect(order).toEqual(['workers', 'tagged', 'remove'])
  })

  it('continues killing tagged and registered targets after EPERM', () => {
    const root = tempRoot()
    const tag = randomUUID()
    for (const pid of [101, 102]) {
      mkdirSync(join(root, String(pid)))
      writeFileSync(join(root, String(pid), 'environ'), `${RUN_TAG_ENV}=${tag}\0`)
    }
    const attempted: number[] = []
    const kill = (pid: number) => {
      attempted.push(pid)
      if (pid === 101) throw Object.assign(new Error('denied'), { code: 'EPERM' })
    }
    expect(reapTagged(tag, { procRoot: root, kill })).toEqual({ supported: true, killed: [102], errors: [{ pid: 101, code: 'EPERM' }] })
    expect(attempted).toContain(102)
    const registry = tempRoot()
    for (const pid of [101, 102]) writeFileSync(join(registry, String(pid)), 'start')
    attempted.length = 0
    expect(reapRegisteredWorkers(registry, { platform: 'linux', startTimeOf: () => 'start', kill })).toEqual({ killed: [102], errors: [{ pid: 101, code: 'EPERM' }] })
    expect(attempted).toContain(102)
  })

  it('reports an asynchronous watchdog spawn failure without crashing', () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = () => {}
    const lines: string[] = []
    launchWatchdog(randomUUID(), 'registry', {
      spawn: () => child,
      report: (line: string) => { lines.push(line) },
    })
    child.emit('error', new Error('spawn failed'))
    expect(lines).toEqual(['orphan reaper: watchdog failed to start: spawn failed; killed runs will not be reaped\n'])
  })
  it('matches only exact exec-time environment entries across platforms', () => {
    const root = tempRoot()
    const tag = randomUUID()
    for (const [pid, value] of [[101, `${RUN_TAG_ENV}=${tag}`], [102, `${RUN_TAG_ENV}=${tag}x`], [103, `${RUN_TAG_ENV}=${randomUUID()}`]] as const) {
      mkdirSync(join(root, String(pid)))
      writeFileSync(join(root, String(pid), 'environ'), `OTHER=yes\0${value}\0`)
    }
    expect(listTaggedPids(tag, { platform: 'linux', procRoot: root })).toEqual({ supported: true, pids: [101], unreadable: 0 })
    const runPs = () => ` 101 node -e code ${RUN_TAG_ENV}=${tag} OTHER=yes\n 102 node ${RUN_TAG_ENV}=${tag}x\n 103 node ${RUN_TAG_ENV}=${randomUUID()}\n`
    expect(listTaggedPids(tag, { platform: 'darwin', runPs })).toEqual({ supported: true, pids: [101] })
    expect(listTaggedPids(tag, { platform: 'win32' })).toEqual({ supported: false, pids: [], reason: 'process enumeration unavailable on win32' })
    expect(() => listTaggedPids('')).toThrow()
    expect(() => listTaggedPids(`${tag}x`)).toThrow()
  })

  it('reports darwin ps failure as unsupported', () => {
    expect(listTaggedPids(randomUUID(), {
      platform: 'darwin',
      runPs: () => { throw new Error('ps failed') },
    })).toEqual({ supported: false, pids: [], reason: 'ps failed: ps failed' })
  })

  it('kills only the child with the target tag', async () => {
    const tag = randomUUID()
    // A separate launcher sets tag T explicitly, so this test does not depend on the worker's own run tag.
    const launcher = spawnSync(process.execPath, ['-e', `const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { WT_TEST_RUN_TAG: process.argv[1] }),
      }); child.unref(); process.stdout.write(String(child.pid))`, tag], { encoding: 'utf8' })
    expect(launcher.status, launcher.stderr).toBe(0)
    const taggedPid = Number(launcher.stdout)
    const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
    const otherPid = other.pid!
    other.unref()
    try {
      await waitFor(() => listTaggedPids(tag).pids.includes(taggedPid), 5000, 'tagged process')
      expect(reapTagged(tag).killed).toContain(taggedPid)
      await waitFor(() => !alive(taggedPid), 5000, 'tagged process to exit')
      expect(alive(otherPid)).toBe(true)
    } finally {
      killIfAlive(taggedPid)
      killIfAlive(other.pid)
    }
  })

  it('reaps a detached keepalive when the Vitest main process is SIGKILLed', async () => {
    const { child, pidFile, exited, output } = nestedRun(tempRoot(), true)
    let keepalive: number | undefined
    try {
      await waitFor(() => {
         keepalive = readPid(pidFile); return keepalive !== undefined
      }, 20000, `nested fixture pid file; output: ${output()}`)
       expect(alive(keepalive!)).toBe(true)
       killIfAlive(child.pid)
      await exited
      await waitFor(() => !alive(keepalive!), 15000, `watchdog reap of ${keepalive}; output: ${output()}`)
      expect(alive(keepalive!)).toBe(false)
    } finally {
      killIfAlive(keepalive)
      killIfAlive(child.pid)
    }
  }, 60000)

  it('reaps a leaked keepalive on normal Vitest completion', async () => {
    const root = tempRoot()
    const pidFile = join(root, 'keepalive.pid')
    const release = join(root, 'release')
    const { child, exited, output } = runNestedFixture(root, pidFile, `test('leaks a detached child', async () => {
      const { spawn } = await import('node:child_process')
      const { writeFileSync, renameSync, existsSync } = await import('node:fs')
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' })
      child.unref()
      writeFileSync(${JSON.stringify(pidFile + '.tmp')}, String(child.pid))
      renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)})
      while (!existsSync(${JSON.stringify(release)})) await new Promise((done) => setTimeout(done, 50))
    })`, { WT_TEST_ORPHAN_REAPER_WATCHDOG: '0' })
    let keepalive: number | undefined
    try {
      await waitFor(() => {
         keepalive = readPid(pidFile); return keepalive !== undefined
       }, 20000, `nested fixture pid file; output: ${output()}`)
       expect(alive(keepalive!)).toBe(true)
       writeFileSync(release, '')
       await waitFor(() => child.exitCode !== null, 20000, `nested Vitest exit; output: ${output()}`)
      expect(await exited, output()).toBe(0)
      await waitFor(() => !alive(keepalive!), 5000, `normal teardown reap of ${keepalive}; output: ${output()}`)
      expect(alive(keepalive!)).toBe(false)
    } finally {
      killIfAlive(keepalive)
      killIfAlive(child.pid)
    }
  }, 60000)

  it.skipIf(process.platform === 'darwin')('reaps a blocked Vitest worker after the main process is SIGKILLed (Linux-only worker cleanup)', async () => {
    const root = tempRoot()
    const pidFile = join(root, 'worker.pid')
    const { child, exited, output } = runNestedFixture(root, pidFile, `import { writeFileSync, renameSync } from 'node:fs'
    test('blocks the worker', () => {
       writeFileSync(${JSON.stringify(pidFile + '.tmp')}, String(process.pid))
       renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)})
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }, 120000)
`)
    let worker: number | undefined
    try {
      await waitFor(() => {
         worker = readPid(pidFile); return worker !== undefined
      }, 20000, `nested worker pid file; output: ${output()}`)
       expect(worker).not.toBe(child.pid)
       expect(alive(worker!)).toBe(true)
       killIfAlive(child.pid)
      await exited
      await waitFor(() => !alive(worker!), 15000, `watchdog reap of worker ${worker}; output: ${output()}`)
      expect(alive(worker!)).toBe(false)
    } finally {
      killIfAlive(worker)
      killIfAlive(child.pid)
    }
  }, 60000)

  it('kills a registered pid only on linux and only when its start time still matches', () => {
    const registry = tempRoot()
    writeFileSync(join(registry, String(UNUSED_PID)), 'recorded-start-time')
    const cases = [
      { platform: 'linux', startTime: 'recorded-start-time', expected: [UNUSED_PID] },
      { platform: 'linux', startTime: 'different-start-time', expected: [] },
      { platform: 'linux', startTime: undefined, expected: [] },
      { platform: 'darwin', startTime: 'recorded-start-time', expected: [] },
      { platform: 'win32', startTime: 'recorded-start-time', expected: [] },
    ] as const
    for (const { platform, startTime, expected } of cases) {
      const killed: number[] = []
      reapRegisteredWorkers(registry, { platform, startTimeOf: () => startTime, kill: (pid: number) => { killed.push(pid) } })
      expect({ platform, startTime, killed }).toEqual({ platform, startTime, killed: expected })
    }
  })

  it('reads state and start time after the LAST parenthesis of a stat line', () => {
    const after = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), '987654', '7', '8']
    expect(parseStatFields(`4242 (a) b (c) ${after.join(' ')}`)).toEqual({ state: 'S', startTime: '987654' })
  })

  it.skipIf(process.platform !== 'linux')('reads the real start time of live processes, whose command name holds spaces and parentheses', async () => {
    const first = spawn(process.execPath, ['-e', 'process.title = "a) b (c"; setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    let second: ReturnType<typeof spawn> | undefined
    try {
      await waitFor(() => { try { return readFileSync(`/proc/${first.pid}/comm`, 'utf8').includes(')') } catch { return false } }, 5000, 'renamed first child')
      second = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      await waitFor(() => linuxStartTime(second!.pid) !== undefined, 5000, 'second child stat')
      const a = linuxStartTime(first.pid)
      const b = linuxStartTime(second.pid)
      expect(a).toMatch(/^\d+$/)
      expect(b).toMatch(/^\d+$/)
      expect(Number(b)).toBeGreaterThan(Number(a))
      const ticks = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim())
      const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0])
      expect(Math.abs(Number(a) / ticks - uptime)).toBeLessThan(60)
    } finally {
      killIfAlive(first.pid)
      killIfAlive(second?.pid)
    }
  })

  it('treats only a vanished, zombie or replaced parent as gone', () => {
    const stat = (state: string, start: string) => `9 (node) ${[state, ...Array.from({ length: 18 }, () => '0'), start].join(' ')}`
    const fail = (code: string) => () => { throw Object.assign(new Error(code), { code }) }
    const live = { platform: 'linux', probe: () => true }
    expect(parentGone(9, '100', { ...live, readStat: () => stat('S', '100') })).toBe(false)
    expect(parentGone(9, '100', { ...live, readStat: fail('EACCES') })).toBe(false)
    expect(parentGone(9, '100', { ...live, readStat: fail('EIO') })).toBe(false)
    expect(parentGone(9, '100', { ...live, readStat: fail('ENOENT') })).toBe(true)
    expect(parentGone(9, '100', { ...live, readStat: () => stat('Z', '100') })).toBe(true)
    expect(parentGone(9, '100', { ...live, readStat: () => stat('S', '200') })).toBe(true)
    expect(parentGone(9, '100', { platform: 'linux', probe: fail('ESRCH'), readStat: () => stat('S', '100') })).toBe(true)
    expect(parentGone(9, '100', { platform: 'linux', probe: fail('EPERM'), readStat: () => stat('S', '100') })).toBe(false)
  })

  it('names a ps buffer overflow and counts unexpected environ read errors', () => {
    const tag = randomUUID()
    const overflow = () => { throw Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ENOBUFS' }) }
    expect(listTaggedPids(tag, { platform: 'darwin', runPs: overflow })).toEqual({ supported: false, pids: [], reason: 'ps output exceeded its buffer' })
    const root = tempRoot()
    mkdirSync(join(root, '101', 'environ'), { recursive: true })
    expect(listTaggedPids(tag, { platform: 'linux', procRoot: root })).toEqual({ supported: true, pids: [], unreadable: 1 })
    expect(reapTagged(tag, { platform: 'linux', procRoot: root }).errors).toEqual([{ pid: 'scan', code: '1 unreadable environ' }])
  })
})
