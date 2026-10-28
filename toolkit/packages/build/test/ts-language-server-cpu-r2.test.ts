// Regression locks for ownership, evidence gaps, combined CPU and async measurement.
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
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
  const kill = vi.fn(), write = vi.fn()
  monitorTsserverCpu(child, { write }, { readFamily, readIdentity, kill, now: () => Date.now(), intervalMs: 5000, windowMs: 10_000 })
  await vi.advanceTimersByTimeAsync(0)
  return { child, readFamily, readIdentity, kill, write,
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

it.each(['counter', 'identity'])('rejects the aggregate interval on a member %s change', kind => {
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
  writeFileSync(cli, `import { spawn } from 'node:child_process'; const child = spawn(process.execPath, [${JSON.stringify(script)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); child.on('message', () => process.stderr.write('IDLE_OBSERVED\\n')); process.stderr.write('BACKEND_PID=' + process.pid + '\\nSERVER_PID=' + child.pid + '\\n'); process.stdout.write(${JSON.stringify(reply)}); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`)
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

it.skipIf(process.platform !== 'linux').each([true, false])('real wt-tsls launch warns on a synchronous spin and preserves idle (spin=%s)', async spinning => {
  const run = launchFixture(spinning)
  const closed = once(run.child, 'close', { signal: AbortSignal.timeout(40_000) })
  let pid = 0, backend = 0
  try {
    await vi.waitFor(() => expect(run.stderr()).toMatch(/SERVER_PID=\d+/), { timeout: 15_000 })
    pid = Number(/SERVER_PID=(\d+)/.exec(run.stderr())![1])
    backend = Number(/BACKEND_PID=(\d+)/.exec(run.stderr())![1])
    if (spinning) {
      await vi.waitFor(() => expect(run.stderr()).toContain('CPU budget exceeded:'), { timeout: 15_000, interval: 50 })
      expect(run.stderr()).toContain('stop is disabled in this version; sampling continues')
      expect(run.child.exitCode).toBeNull(); expect(run.child.signalCode).toBeNull()
      expect(['S', 'R']).toContain(state(pid))
      expect(run.stderr().match(/CPU budget exceeded:/g)).toHaveLength(1)
      console.log('real wt-tsls synchronous spin: CPU breach warned; backend and offender alive; stop disabled')
    } else {
      await vi.waitFor(() => expect(run.stderr()).toContain('IDLE_OBSERVED'), { timeout: 15_000 })
      expect(run.child.exitCode).toBeNull(); expect(run.child.signalCode).toBeNull()
      expect(['S', 'R']).toContain(state(pid))
      expect(run.stderr()).not.toContain('CPU budget exceeded:')
      console.log('real wt-tsls idle: alive past 200ms window; no CPU breach warning; no watchdog stop')
    }
    const ended = once(run.child.stdout, 'end', { signal: AbortSignal.timeout(15_000) })
    run.child.stdin.end()
    expect(await closed).toEqual([0, null])
    await ended
    console.log(`real wt-tsls backend exit (spin=${spinning}): exit 0; client EOF observed`)
  } finally {
    for (const target of [backend ? -backend : 0, -run.child.pid!, pid]) if (target) try { process.kill(target, 'SIGKILL') } catch { /* Already dead. */ }
    await closed.catch(() => {})
    rmSync(run.root, { recursive: true, force: true })
  }
}, 45_000)

const { runTsLaunch } = await import(url('ts-language-server'))

it.each([
  { backpressure: false, answered: false, stderrThrows: false },
  { backpressure: false, answered: true, stderrThrows: false },
  { backpressure: true, answered: true, stderrThrows: false },
  { backpressure: false, answered: true, stderrThrows: true },
])('ignores the removed CPU-stop event (backpressure=$backpressure answered=$answered stderrThrows=$stderrThrows)', async ({ backpressure, answered, stderrThrows }) => {
  vi.useFakeTimers()
  const input = new PassThrough(), output = new PassThrough({ highWaterMark: 1 }), stderr = new PassThrough()
  const child = Object.assign(new EventEmitter(), { pid: 10, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: vi.fn() })
  const exitSignal = vi.fn(), exit = vi.fn()
  if (!backpressure) output.resume()
  runTsLaunch({ input, output, stderr, exit, exitSignal, select: () => ({ status: 'launch', backend: 'typescript-language-server', command: '/fake', args: [] }), start: () => child })
  input.write(frame({ id: 1, method: 'initialize', params: {} }))
  child.emit('spawn')
  if (answered) child.stdout.write(frame({ id: 1, result: { capabilities: {} } }))
  if (stderrThrows) vi.spyOn(stderr, 'write').mockImplementation(() => { throw new Error('diagnostic failed') })
  child.emit('wt-tsls-cpu-stop', { status: 'survived', attempted: true })
  await vi.advanceTimersByTimeAsync(1000)
  expect(exitSignal).not.toHaveBeenCalled()
  expect(output.writableEnded).toBe(false)
  expect(child.stdout.destroyed).toBe(false)
  expect(child.listenerCount('wt-tsls-cpu-stop')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(exit).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  child.emit('close', 0, null)
  await vi.advanceTimersByTimeAsync(0)
  input.destroy(); output.destroy(); stderr.destroy()
})

it.each([
  { scope: 'server', recoveryPct: 0 }, { scope: 'family', recoveryPct: 0 },
  { scope: 'server', recoveryPct: 25 }, { scope: 'family', recoveryPct: 25 },
  { scope: 'server', recoveryPct: 100 }, { scope: 'family', recoveryPct: 100 },
])('resets $scope evidence on known at-or-under-budget recovery after a missing sample (recovery=$recoveryPct%)', ({ scope, recoveryPct }) => {
  const update = createTsCpuBudget()
  const value = (cpuMs: number) => scope === 'server' ? sample(cpuMs) : pair(cpuMs / 2, cpuMs / 2)
  for (let at = 0; at <= 115_000; at += 5000) expect(update(value(at * 1.5), at)).toBeUndefined()
  update({ status: 'unavailable' }, 120_000)
  const recoveredCpu = 172_500 + recoveryPct / 100 * 10_000
  expect(update(value(recoveredCpu), 125_000)).toBeUndefined()
  for (let at = 130_000; at < 245_000; at += 5000) expect(update(value(recoveredCpu + (at - 125_000) * 1.5), at)).toBeUndefined()
  expect(update(value(recoveredCpu + 180_000), 245_000)).toMatchObject({ scope, overMs: 120_000, percent: 150 })
})

it('enforces accepted aggregate CPU across repeated sibling replacements', () => {
  const update = createTsCpuBudget()
  for (let at = 0; at <= 130_000; at += 5000) {
    const value = pair(at * 0.75, (at % 60_000) * 0.75)
    value.servers[1].identity = `12:generation-${Math.floor(at / 60_000)}`
    const result = update(value, at)
    if (at < 130_000) expect(result).toBeUndefined()
    else expect(result).toMatchObject({ scope: 'family', overMs: 120_000, percent: 150 })
  }
})

function treeStat(pid: number, ppid: number, pgid: number) {
  const fields = Array<string>(20).fill('0')
  fields[0] = 'T'; fields[1] = String(ppid); fields[2] = String(pgid); fields[19] = '123'
  return `${pid} (node) ${fields.join(' ')}`
}

it('walks Linux ancestry and owned group members without a script-name filter', async () => {
  const files: Record<string, string> = { '/proc/10/stat': treeStat(10, 1, 10), '/proc/11/stat': treeStat(11, 10, 11), '/proc/12/stat': treeStat(12, 11, 12), '/proc/13/stat': treeStat(13, 1, 13), '/proc/14/stat': treeStat(14, 1, 10) }
  const reader = cpu.createTsCpuReader({ platform: 'linux', list: () => ['10', '11', '12', '13', '14', 'self'], read: (path: string) => files[path] })
  expect(await reader.tree(10)).toMatchObject({ status: 'measured', processes: [{ pid: 11 }, { pid: 12 }, { pid: 14 }] })
})

it.each(['EACCES', 'malformed'])('degrades a Linux tree with %s evidence to unknown', kind => {
  const reader = cpu.createTsCpuReader({ platform: 'linux', list: () => ['10', '11'], read: (path: string) => {
    if (path === '/proc/10/stat') return treeStat(10, 1, 10)
    if (kind === 'malformed') return 'broken'
    throw Object.assign(new Error('denied'), { code: kind })
  } })
  return expect(reader.tree(10)).resolves.toMatchObject({ status: 'unavailable', reason: 'backend process tree unavailable' })
})

it('walks macOS ps ancestry including escaped descendants and reads stopped state', async () => {
  const run = vi.fn(async () => ({ status: 0, stdout: 'T 10 1 10 Mon Oct 26 20:00:00 2026 0:00.00 /node /cli.mjs\nT 11 10 11 Mon Oct 26 20:00:01 2026 0:01.50 /node /tsserver.js\nT 12 11 12 Mon Oct 26 20:00:02 2026 0:00.00 /helper\nS 13 1 13 Mon Oct 26 20:00:03 2026 0:00.00 /unrelated' }))
  expect(await cpu.createTsCpuReader({ platform: 'darwin', run }).tree(10)).toMatchObject({ status: 'measured', processes: [{ pid: 11, state: 'T' }, { pid: 12, state: 'T' }] })
  expect(run).toHaveBeenCalledWith('/bin/ps', ['-wwaxo', 'state=,pid=,ppid=,pgid=,lstart=,time=,command='])
})

it('reports a failed macOS tree helper and unsupported Windows tree as unavailable', async () => {
  const run = vi.fn(async () => ({ status: 1, stdout: '' }))
  expect(await cpu.createTsCpuReader({ platform: 'darwin', run }).tree(10)).toMatchObject({ status: 'unavailable' })
  run.mockClear()
  expect(await cpu.createTsCpuReader({ platform: 'win32', run }).tree(10)).toMatchObject({ status: 'unavailable', reason: 'unsupported platform win32' })
  expect(run).not.toHaveBeenCalled()
})

it('resets combined evidence when a zero-CPU sibling joins a provably idle interval', () => {
  const update = createTsCpuBudget()
  for (let at = 0; at <= 115_000; at += 5000) expect(update(pair(at * 0.75, at * 0.75), at)).toBeUndefined()
  const idle = { ...pair(86_250, 86_250), servers: [...pair(86_250, 86_250).servers, { ...server, pid: 13, identity: '13:birth', cpuMs: 0 }] }
  expect(update(idle, 120_000)).toBeUndefined()
  const next = { ...idle, servers: idle.servers.map(member => ({ ...member, cpuMs: member.cpuMs + (member.pid === 13 ? 0 : 3750) })) }
  expect(update(next, 125_000)).toBeUndefined()
})
