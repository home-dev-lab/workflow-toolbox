// Regression locks for ownership, evidence gaps, combined CPU and async measurement.
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixtureEnvironment, frame } from './helpers/ts-watch-fixture.js'

const plugin = process.env.WT_TSLS_CPU_TEST_ROOT ?? fileURLToPath(new URL('../../../../plugin/', import.meta.url))
const url = (name: string) => pathToFileURL(join(plugin, `bin/lib/host/${name}.mjs`)).href
const { createTsCpuBudget } = await import(url('ts-cpu-budget'))
const cpu = await import(url('ts-cpu-sample'))
const { monitorTsserverCpu } = await import(url('ts-cpu-watchdog'))
const { monitorTsserverWatches } = await import(url('ts-watch-count'))
afterEach(() => vi.useRealTimers())

const parent = { pid: 10, identity: '10:birth', pgid: 10, state: 'S' }
const server = { pid: 11, ppid: 10, pgid: 10, identity: '11:birth', state: 'R', cpuMs: 0 }
const sample = (cpuMs: number) => ({ status: 'measured', parent, servers: [{ ...server, cpuMs }] })

async function monitored() {
  vi.useFakeTimers()
  let cpuMs = 0
  const child = Object.assign(new EventEmitter(), { pid: 10, exitCode: null })
  const readFamily = vi.fn(() => sample(cpuMs))
  const readIdentity = vi.fn((pid: number) => ({ status: 'measured', process: pid === 10 ? parent : server }))
  const census = vi.fn(() => ({ status: 'measured', processes: [] as object[] }))
  const kill = vi.fn(), write = vi.fn()
  monitorTsserverCpu(child, { write }, { readFamily, readIdentity, census, settle: async () => {}, kill, now: () => Date.now(), intervalMs: 5000, windowMs: 10_000 })
  await vi.advanceTimersByTimeAsync(0)
  return { child, readFamily, readIdentity, census, kill, write,
    text: () => write.mock.calls.flat().join(''),
    tick: async () => { cpuMs += 7500; await vi.advanceTimersByTimeAsync(5000) },
  }
}

it('pins backend birth identity before the first CPU sample', async () => {
  const run = await monitored()
  expect(run.readIdentity).toHaveBeenCalledWith(10)
  expect(run.readIdentity.mock.invocationCallOrder[0]!).toBeLessThan(run.readFamily.mock.invocationCallOrder[0]!)
})

it('leaves the budget unenforced when spawn-time birth identity is unavailable', async () => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), { pid: 10, exitCode: null })
  const readIdentity = vi.fn().mockReturnValueOnce({ status: 'unavailable', reason: 'denied' }).mockReturnValue({ status: 'measured', process: parent })
  const readFamily = vi.fn(() => sample(Date.now() * 1.5)), kill = vi.fn(), write = vi.fn()
  monitorTsserverCpu(child, { write }, { readFamily, readIdentity, kill, now: () => Date.now(), intervalMs: 5000, windowMs: 10_000 })
  await vi.advanceTimersByTimeAsync(20_000)
  expect(readIdentity).toHaveBeenCalledTimes(1)
  expect(readFamily).not.toHaveBeenCalled()
  expect(kill).not.toHaveBeenCalled()
  expect(write.mock.calls.flat().join('')).toContain('birth identity unavailable')
})

it('refuses a replacement backend consistently present in later samples', async () => {
  const run = await monitored()
  run.readFamily.mockImplementation(() => ({ ...sample(Date.now() * 1.5), parent: { ...parent, identity: '10:replacement' } }))
  run.readIdentity.mockImplementation(pid => ({ status: 'measured', process: pid === 10 ? { ...parent, identity: '10:replacement' } : server }))
  await run.tick(); await run.tick(); await run.tick()
  expect(run.kill).not.toHaveBeenCalled()
})

it('refuses backend identity changes between verdict and stop', async () => {
  const run = await monitored()
  await run.tick()
  run.readFamily.mockImplementationOnce(() => sample(15_000)).mockImplementationOnce(() => ({ ...sample(15_000), parent: { ...parent, identity: '10:replacement' } }))
  await run.tick()
  expect(run.kill).not.toHaveBeenCalled()
})

it('rechecks the pinned backend birth immediately before signalling', async () => {
  const run = await monitored()
  await run.tick()
  run.readIdentity.mockImplementation(pid => ({ status: 'measured', process: pid === 10 ? { ...parent, identity: '10:replacement' } : server }))
  await run.tick()
  expect(run.kill).not.toHaveBeenCalled()
})

it('stops supervision at exit before delayed close and cannot adopt a reused pid', async () => {
  const run = await monitored()
  const reads = run.readFamily.mock.calls.length
  run.child.emit('exit', 0, null)
  run.readFamily.mockImplementation(() => ({ ...sample(30_000), parent: { ...parent, identity: '10:replacement' } }))
  await run.tick(); await run.tick()
  expect(run.readFamily).toHaveBeenCalledTimes(reads)
  expect(run.kill).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('also clears watch-count supervision at backend exit before close', async () => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), { pid: 10 })
  const read = vi.fn(() => '')
  monitorTsserverWatches(child, { write: vi.fn() }, { platform: 'linux', read, list: vi.fn(() => []) })
  child.emit('exit', 0, null)
  await vi.advanceTimersByTimeAsync(5000)
  expect(read).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('discards an in-flight verdict after exit', async () => {
  const run = await monitored()
  await run.tick()
  let resolve!: (value: ReturnType<typeof sample>) => void
  run.readFamily.mockReturnValueOnce(new Promise<ReturnType<typeof sample>>(done => { resolve = done }) as unknown as ReturnType<typeof sample>)
  await run.tick()
  run.child.emit('exit', 0, null)
  resolve(sample(15_000))
  await vi.advanceTimersByTimeAsync(0)
  expect(run.kill).not.toHaveBeenCalled()
})

it('signals an escaped offender by its own verified pid as well as the backend group', async () => {
  const run = await monitored()
  run.readFamily.mockImplementation(() => ({ ...sample(Date.now() * 1.5), servers: [{ ...server, pgid: 11, cpuMs: Date.now() * 1.5 }] }))
  run.readIdentity.mockImplementation(pid => ({ status: 'measured', process: pid === 10 ? parent : { ...server, pgid: 11 } }))
  // Re-anchor synthetic CPU to avoid mixing the initial zero with the fake epoch.
  await run.tick(); await run.tick(); await run.tick()
  expect(run.kill).toHaveBeenCalledWith(11, 'SIGKILL')
  expect(run.kill).toHaveBeenCalledWith(-10, 'SIGKILL')
  expect(run.census).toHaveBeenCalledWith([10, 11])
  expect(run.text()).toContain('stopped backend and tsserver')
})

it('refuses an escaped offender whose own identity changed before its pid signal', async () => {
  const run = await monitored()
  await run.tick()
  run.readFamily.mockImplementation(() => ({ ...sample(15_000), servers: [{ ...server, pgid: 11, cpuMs: 15_000 }] }))
  run.readIdentity.mockImplementation(pid => ({ status: 'measured', process: pid === 10 ? parent : { ...server, pgid: 11, identity: '11:replacement' } }))
  await run.tick()
  expect(run.kill).not.toHaveBeenCalled()
})

it('reports survivors instead of stopped after the post-signal census', async () => {
  const run = await monitored()
  run.census.mockReturnValue({ status: 'measured', processes: [server] })
  await run.tick(); await run.tick()
  expect(run.census).toHaveBeenCalledTimes(1)
  expect(run.text()).toContain('survived: 11')
  expect(run.text()).not.toContain('stopped backend and tsserver')
})

it('does not claim stopped when the post-signal census is unavailable', async () => {
  const run = await monitored()
  run.census.mockReturnValue({ status: 'unavailable', reason: 'denied' } as unknown as ReturnType<typeof run.census>)
  await run.tick(); await run.tick()
  expect(run.text()).toContain('stop unverified')
  expect(run.text()).not.toContain('stopped backend and tsserver')
})

it('does not overlap asynchronous samples while a helper is in flight', async () => {
  const run = await monitored()
  let resolve!: (value: ReturnType<typeof sample>) => void
  run.readFamily.mockReturnValueOnce(new Promise<ReturnType<typeof sample>>(done => { resolve = done }) as unknown as ReturnType<typeof sample>)
  await run.tick(); await run.tick(); await run.tick(); await run.tick()
  expect(run.readFamily).toHaveBeenCalledTimes(2)
  resolve(sample(30_000))
  await vi.advanceTimersByTimeAsync(0)
  expect(run.kill).not.toHaveBeenCalled()
  run.child.emit('exit', 0, null)
})

it('rejects a two-sample 120-second gap but breaches at the exact regular window', () => {
  const update = createTsCpuBudget()
  update(sample(0), 0)
  expect(update(sample(180_000), 120_000)).toBeUndefined()
  for (let at = 125_000; at < 240_000; at += 5000) expect(update(sample(at * 1.5), at)).toBeUndefined()
  expect(update(sample(360_000), 240_000)).toMatchObject({ overMs: 120_000, percent: 150 })
})

it.each(['unavailable', 'missing'])('pauses evidence through periodic %s samples without erasing a spin', kind => {
  const update = createTsCpuBudget()
  update(sample(0), 0)
  for (let at = 5000; at < 130_000; at += 5000) {
    const value = at === 115_000 ? kind === 'unavailable' ? { status: 'unavailable' } : { ...sample(at * 1.5), servers: [] } : sample(at * 1.5)
    expect(update(value, at)).toBeUndefined()
  }
  expect(update(sample(195_000), 130_000)).toMatchObject({ overMs: 120_000, percent: 150 })
})

it('expires paused evidence after three sampling intervals', () => {
  const update = createTsCpuBudget({ windowMs: 20_000 })
  update(sample(0), 0); update(sample(15_000), 10_000)
  update({ status: 'unavailable' }, 15_000)
  expect(update(sample(45_000), 30_000)).toBeUndefined()
  expect(update(sample(52_500), 35_000)).toBeUndefined()
  expect(update(sample(60_000), 40_000)).toBeUndefined()
})

const pair = (first: number, second: number) => ({ ...sample(first), servers: [{ ...server, cpuMs: first }, { ...server, pid: 12, identity: '12:birth', cpuMs: second }] satisfies [typeof server, typeof server] })

it('enforces the sum of two 75-percent servers at the exact window', () => {
  const update = createTsCpuBudget()
  update(pair(0, 0), 0)
  for (let at = 5000; at < 120_000; at += 5000) expect(update(pair(at * 0.75, at * 0.75), at)).toBeUndefined()
  expect(update(pair(90_000, 90_000), 120_000)).toMatchObject({ scope: 'family', percent: 150, overMs: 120_000, servers: [{ pid: 11 }, { pid: 12 }] })
})

it('retains the per-server budget beside an idle sibling even when that sibling is replaced', () => {
  const update = createTsCpuBudget({ windowMs: 10_000 })
  update(pair(0, 0), 0); update(pair(0, 7500), 5000)
  const replacement = pair(0, 15_000)
  replacement.servers[0].identity = '11:replacement'
  expect(update(replacement, 10_000)).toMatchObject({ scope: 'server', server: { pid: 12 }, percent: 150 })
})

it.each(['counter', 'identity'])('resets family evidence on a member %s change', kind => {
  const update = createTsCpuBudget({ windowMs: 10_000 })
  update(pair(0, 0), 0); update(pair(3750, 3750), 5000)
  const value = pair(kind === 'counter' ? 0 : 7500, 20_000)
  if (kind === 'identity') value.servers[0].identity = '11:replacement'
  expect(update(value, 10_000)).toBeUndefined()
})

it('awaits an asynchronous ps helper instead of degrading a pending read to unavailable', async () => {
  const run = vi.fn(async () => ({ status: 0, stdout: '10 1 10 Mon Oct 26 20:00:00 2026 0:00.00 /node /cli.mjs\n11 10 10 Mon Oct 26 20:00:01 2026 0:01.50 /node /tsserver.js' }))
  expect(await cpu.createTsCpuReader({ platform: 'darwin', run })(10)).toMatchObject({ status: 'measured', servers: [{ cpuMs: 1500 }] })
})

it('uses an asynchronous helper deadline with an unconditional SIGKILL', async () => {
  const exec = vi.fn((_command: string, _args: string[], options: { timeout: number; killSignal: string; maxBuffer: number }, callback: (error: Error | null, stdout: string) => void) => {
    expect(options).toMatchObject({ timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })
    callback(null, '100\n')
  })
  expect(await cpu.runTsCpuCommand('/usr/bin/getconf', ['CLK_TCK'], { exec })).toMatchObject({ status: 0, stdout: '100\n' })
  expect(exec).toHaveBeenCalledTimes(1)
})

it('keeps the event loop responsive and kills a helper that ignores SIGTERM', async () => {
  let responsive = false
  const timer = setImmediate(() => { responsive = true })
  try {
    const result = await cpu.runTsCpuCommand(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 1200); setInterval(() => {}, 100)'], { timeout: 200 })
    expect(responsive).toBe(true)
    expect(result.error?.signal).toBe('SIGKILL')
  } finally { clearImmediate(timer) }
})

function launchFixture(spinning: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'wt-tsls-cpu-launch-'))
  cpSync(join(plugin, 'bin'), join(root, 'plugin/bin'), { recursive: true })
  const budgetFile = join(root, 'plugin/bin/lib/host/ts-cpu-budget.mjs')
  const budget = readFileSync(budgetFile, 'utf8')
  writeFileSync(budgetFile, budget.replace('TS_CPU_BUDGET_PCT = 100', 'TS_CPU_BUDGET_PCT = 1').replace('TS_CPU_WINDOW_MS = 120_000', 'TS_CPU_WINDOW_MS = 200').replace('TS_CPU_SAMPLE_MS = 5000', 'TS_CPU_SAMPLE_MS = 50'))
  const lib = join(root, 'bin/node_modules/typescript-language-server/lib')
  mkdirSync(lib, { recursive: true })
  const ts = join(root, 'node_modules/typescript')
  mkdirSync(join(ts, 'lib'), { recursive: true })
  writeFileSync(join(ts, 'package.json'), JSON.stringify({ name: 'typescript', version: '6.0.0' }))
  const script = join(ts, 'lib/tsserver.js')
  writeFileSync(script, spinning ? 'while (true) {}' : 'setTimeout(() => process.send({ idle: true }), 650); setInterval(() => {}, 1000)')
  const cli = join(lib, 'cli.mjs')
  const reply = frame({ id: 1, result: { capabilities: {} } }).toString()
  writeFileSync(cli, `import { spawn } from 'node:child_process'; const child = spawn(process.execPath, [${JSON.stringify(script)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); child.on('message', () => process.stderr.write('IDLE_OBSERVED\\n')); process.stderr.write('SERVER_PID=' + child.pid + '\\n'); process.stdout.write(${JSON.stringify(reply)}); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`)
  symlinkSync(cli, join(root, 'bin/typescript-language-server'))
  const child = spawn(process.execPath, [join(root, 'plugin/bin/wt-tsls.mjs')], { cwd: root, detached: true, env: { ...fixtureEnvironment(root), PATH: join(root, 'bin') } })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  child.stdout.resume()
  child.stdin.write(frame({ id: 1, method: 'initialize', params: { rootUri: pathToFileURL(root).href } }))
  return { root, child, stderr: () => stderr }
}

function state(pid: number) {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[0] }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'; throw error }
}

it.skipIf(process.platform !== 'linux').each([true, false])('real wt-tsls launch stops a synchronous spin and preserves idle (spin=%s)', async spinning => {
  const run = launchFixture(spinning)
  const closed = once(run.child, 'close', { signal: AbortSignal.timeout(40_000) })
  let pid = 0, backend = 0
  try {
    await vi.waitFor(() => expect(run.stderr()).toMatch(/SERVER_PID=\d+/), { timeout: 15_000 })
    pid = Number(/SERVER_PID=(\d+)/.exec(run.stderr())![1])
    try { backend = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[1]) } catch { /* The spin may already have stopped. */ }
    if (spinning) {
      await vi.waitFor(() => expect(run.child.signalCode).toBe('SIGKILL'), { timeout: 15_000, interval: 50 })
      expect(await closed).toEqual([null, 'SIGKILL'])
      await vi.waitFor(() => expect(['gone', 'Z', 'X']).toContain(state(pid)))
      expect(run.stderr()).toContain('stopped backend and tsserver')
      console.log('real wt-tsls synchronous spin: backend SIGKILL; offender gone/dead; stopped confirmed')
    } else {
      await vi.waitFor(() => expect(run.stderr()).toContain('IDLE_OBSERVED'), { timeout: 15_000 })
      expect(run.child.exitCode).toBeNull(); expect(run.child.signalCode).toBeNull()
      expect(['S', 'R']).toContain(state(pid))
      expect(run.stderr()).not.toContain('stopped backend and tsserver')
      console.log('real wt-tsls idle: alive past 200ms window; no watchdog stop')
    }
  } finally {
    for (const target of [backend ? -backend : 0, -run.child.pid!, pid]) if (target) try { process.kill(target, 'SIGKILL') } catch { /* Already dead. */ }
    await closed.catch(() => {})
    rmSync(run.root, { recursive: true, force: true })
  }
}, 45_000)
