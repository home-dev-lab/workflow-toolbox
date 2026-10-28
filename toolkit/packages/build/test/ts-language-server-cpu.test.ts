// CPU accounting, process ownership and the enforced resource bound.
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { fixtureEnvironment } from './helpers/ts-watch-fixture.js'

const plugin = process.env.WT_TSLS_CPU_TEST_ROOT ?? fileURLToPath(new URL('../../../../plugin/', import.meta.url))
const moduleUrl = (name: string) => pathToFileURL(join(plugin, `bin/lib/host/${name}.mjs`)).href
const { createTsCpuReader } = await import(moduleUrl('ts-cpu-sample'))
const { createTsCpuBudget, TS_CPU_BUDGET_PCT, TS_CPU_WINDOW_MS, TS_CPU_SAMPLE_MS } = await import(moduleUrl('ts-cpu-budget'))
const { monitorTsserverCpu } = await import(moduleUrl('ts-cpu-watchdog'))
afterEach(() => vi.useRealTimers())

function stat(pid: number, ppid: number, user = 100, system = 50, start = 123) {
  const fields = ['S', String(ppid), ...Array<string>(18).fill('0')]
  fields[2] = '10'; fields[11] = String(user); fields[12] = String(system); fields[19] = String(start)
  return `${pid} (name ) with\nparens) ${fields.join(' ')}\n`
}

const procFiles = () => ({
  '/proc/10/stat': stat(10, 1, 9000, 1000), '/proc/10/task/10/children': '11 12 13',
  '/proc/11/stat': stat(11, 10), '/proc/11/cmdline': '/node\0/lib/tsserver.js\0--stdio\0',
  '/proc/12/stat': stat(12, 10), '/proc/12/cmdline': '/node\0/lib/typingsInstaller.js\0',
  '/proc/13/stat': stat(13, 999), '/proc/13/cmdline': '/node\0/lib/tsserver.js\0',
})

it('reads actual child user+system ticks with CLK_TCK and stable proc identity', async () => {
  const files: Record<string, string> = procFiles()
  const run = vi.fn(() => ({ status: 0, stdout: '250\n' }))
  const read = (path: string) => files[path]
  const sample = await createTsCpuReader({ platform: 'linux', read, run })(10)
  expect(sample).toMatchObject({ status: 'measured', parent: { identity: '10:123' }, servers: [{ pid: 11, ppid: 10, identity: '11:123', cpuMs: 600 }] })
  expect(sample.servers).toHaveLength(1)
  expect(run).toHaveBeenCalledWith('/usr/bin/getconf', ['CLK_TCK'])
})

it('reports unavailable for unsupported platforms, failed clocks, denied and malformed proc reads', async () => {
  const run = vi.fn(), read = vi.fn()
  expect(await createTsCpuReader({ platform: 'win32', read, run })(10)).toEqual({ status: 'unavailable', reason: 'unsupported platform win32' })
  expect(run).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
  for (const stdout of ['0', 'garbage', '']) expect((await createTsCpuReader({ platform: 'linux', read, run: () => ({ status: 0, stdout }) })(10)).status).toBe('unavailable')
  for (const reader of [() => { throw new Error('denied') }, () => 'malformed']) {
    expect((await createTsCpuReader({ platform: 'linux', read: reader, run: () => ({ status: 0, stdout: '100' }) })(10)).status).toBe('unavailable')
  }
})

it('recovers from a transient clock failure and caches only a valid tick rate', async () => {
  const files: Record<string, string> = procFiles()
  const run = vi.fn().mockReturnValueOnce({ status: 1, stdout: '' }).mockReturnValue({ status: 0, stdout: '100' })
  const reader = createTsCpuReader({ platform: 'linux', read: (path: string) => files[path], run })
  expect(await reader(10)).toEqual({ status: 'unavailable', reason: 'CLK_TCK unavailable' })
  expect(await reader(10)).toMatchObject({ status: 'measured', servers: [{ cpuMs: 1500 }] })
  expect((await reader(10)).status).toBe('measured')
  expect(run).toHaveBeenCalledTimes(2)
})

it('reads macOS child CPU via ps elapsed CPU time including days and fractions', async () => {
  const run = vi.fn(() => ({ status: 0, stdout: [
    '10 1 10 Mon Oct 26 20:00:00 2026 0:01.25 /node /tls/cli.mjs --stdio',
    '11 10 10 Mon Oct 26 20:00:01 2026 1-02:03:04.50 /node /lib/_tsserver.js --stdio',
    '12 10 10 Mon Oct 26 20:00:01 2026 0:00.00 /node /lib/typingsInstaller.js',
    '13 99 99 Mon Oct 26 20:00:01 2026 0:00.00 /node /lib/tsserver.js',
  ].join('\n') }))
  const sample = await createTsCpuReader({ platform: 'darwin', run })(10)
  expect(sample.status).toBe('measured')
  expect(sample.servers).toMatchObject([{ pid: 11, cpuMs: 93_784_500 }])
  expect(sample.servers).toHaveLength(1)
  expect(run).toHaveBeenCalledWith('/bin/ps', ['-wwaxo', 'pid=,ppid=,pgid=,lstart=,time=,command='])
})

it('reports unavailable for failed, truncated or malformed ps output', async () => {
  const results = [
    { status: 1, stdout: '' }, { status: 0, stdout: '' },
    { status: 0, stdout: '10 1 10 Mon Oct 26 20:00:00 2026 invalid /node /tsserver.js' },
    { status: 0, stdout: `10 1 10 Mon Oct 26 20:00:00 2026 ${'9'.repeat(400)}:00 /node /tsserver.js` },
  ]
  for (const result of results) {
    expect((await createTsCpuReader({ platform: 'darwin', run: () => result })(10)).status).toBe('unavailable')
  }
})

const sample = (cpuMs: number, identity = '11:123') => ({ status: 'measured', parent: { pid: 10, identity: '10:123', pgid: 10 }, servers: [{ pid: 11, ppid: 10, pgid: 10, identity, cpuMs }] })

it('enforces the stated one-core budget after 120 seconds without an unbounded startup grace', () => {
  expect([TS_CPU_BUDGET_PCT, TS_CPU_WINDOW_MS, TS_CPU_SAMPLE_MS]).toEqual([100, 120_000, 5000])
  const update = createTsCpuBudget()
  expect(update(sample(0), 0)).toBeUndefined()
  for (let at = 5000; at < 120_000; at += 5000) expect(update(sample(at * 1.5), at)).toBeUndefined()
  expect(update(sample(180_000), 120_000)).toMatchObject({ server: { pid: 11 }, percent: 150, overMs: 120_000 })
})

it('compares full precision and preserves idle and exactly-at-budget servers', () => {
  for (const percent of [0, 99.9999, 100, 100.0001]) {
    const update = createTsCpuBudget({ windowMs: 10 })
    update(sample(0), 0)
    expect(Boolean(update(sample(percent / 10), 10))).toBe(percent > 100)
  }
})

it('budgets every tsserver separately, including a hot second server beside an idle first', () => {
  const update = createTsCpuBudget()
  const pair = (first: number, second: number) => ({ ...sample(first), servers: [...sample(first).servers, ...sample(second, '12:456').servers.map(server => ({ ...server, pid: 12 }))] })
  update(pair(0, 0), 0)
  for (let at = 5000; at < 120_000; at += 5000) expect(update(pair(0, at * 1.5), at)).toBeUndefined()
  expect(update(pair(0, 180_000), 120_000)).toMatchObject({ server: { pid: 12 }, percent: 150 })
  const below = createTsCpuBudget()
  below(pair(0, 0), 0)
  for (let at = 5000; at <= 120_000; at += 5000) expect(below(pair(at * 0.45, at * 0.45), at)).toBeUndefined()
})

it.each(['idle', 'reused pid', 'counter reset'])('resets consecutive CPU time after %s', (kind) => {
  const update = createTsCpuBudget({ windowMs: 20 })
  update(sample(0), 0); update(sample(15), 10)
  const changed = sample(kind === 'counter reset' ? 0 : kind === 'reused pid' ? 30 : 15, kind === 'reused pid' ? '11:456' : '11:123')
  expect(update(changed, 20)).toBeUndefined()
  expect(update(sample(60), 30)).toBeUndefined()
})

async function monitored() {
  vi.useFakeTimers()
  let cpuMs = 0, identity = '11:123', status = 'measured'
  const child = Object.assign(new EventEmitter(), { pid: 10, kill: vi.fn(() => true) })
  const readFamily = vi.fn(() => status === 'measured' ? sample(cpuMs, identity) : { status: 'unavailable', reason: 'denied' })
  const kill = vi.fn(), write = vi.fn()
  const readIdentity = (pid: number) => ({ status: 'measured', process: pid === 10 ? sample(0).parent : sample(cpuMs, identity).servers[0] })
  const readTree = () => ({ ...sample(cpuMs, identity), parent: { ...sample(0).parent, state: 'T' }, processes: sample(cpuMs, identity).servers.map(server => ({ ...server, state: 'T' })) })
  monitorTsserverCpu(child, { write }, { readFamily, readIdentity, readTree, census: () => ({ status: 'measured', processes: [] }), settle: async () => {}, kill, now: () => Date.now(), intervalMs: 1000, windowMs: 2000 })
  await vi.advanceTimersByTimeAsync(0)
  return { child, kill, write, readFamily, identity: (id: string) => { identity = id }, status: (value: string) => { status = value }, tick: async () => { cpuMs += 1500; await vi.advanceTimersByTimeAsync(1000) } }
}

it('kills the isolated backend family together, clears sampling, and writes only stderr diagnostics', async () => {
  const run = await monitored()
  await run.tick(); expect(run.kill).not.toHaveBeenCalled()
  await run.tick()
  expect(run.kill).toHaveBeenCalledWith(-10, 'SIGKILL')
  expect(run.child.kill).not.toHaveBeenCalled()
  expect(run.write.mock.calls.flat().join('')).toContain('stopped backend and tsserver 11: 150.0% CPU above 100% for 2000ms')
  const reads = run.readFamily.mock.calls.length
  await run.tick(); expect(run.readFamily).toHaveBeenCalledTimes(reads)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not signal a reused process between the budget verdict and stop', async () => {
  const run = await monitored()
  await run.tick()
  run.readFamily.mockImplementationOnce(() => sample(3000)).mockImplementationOnce(() => sample(3000, '11:456'))
  await run.tick()
  expect(run.kill).not.toHaveBeenCalled(); expect(run.child.kill).not.toHaveBeenCalled()
})

it('refuses to kill a process group shared with the caller', async () => {
  const run = await monitored()
  await run.tick()
  run.readFamily.mockImplementationOnce(() => sample(3000)).mockImplementationOnce(() => ({ ...sample(3000), parent: { pid: 10, identity: '10:123', pgid: 1 } }))
  await run.tick()
  expect(run.kill).not.toHaveBeenCalled()
})

it('reports unavailable once per outage and stops polling on transport close', async () => {
  const run = await monitored()
  run.status('unavailable'); await run.tick(); await run.tick()
  expect(run.write.mock.calls.flat().join('').match(/unavailable \(denied\)/g)).toHaveLength(1)
  expect(run.kill).not.toHaveBeenCalled()
  run.child.emit('close')
  const reads = run.readFamily.mock.calls.length
  await run.tick(); expect(run.readFamily).toHaveBeenCalledTimes(reads)
  expect(vi.getTimerCount()).toBe(0)
})

it('automatically starts CPU supervision in the existing TLS spawn path', () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-tsls-cpu-wiring-'))
  try {
    const cli = join(root, 'cli.mjs')
    writeFileSync(cli, 'process.stdin.resume()')
    const code = `import { spawnTsProcess } from ${JSON.stringify(moduleUrl('ts-process'))}; import { createTsCpuReader } from ${JSON.stringify(moduleUrl('ts-cpu-sample'))}; const child = spawnTsProcess(process.execPath, [${JSON.stringify(cli)}], { stdio: ['pipe', 'ignore', 'ignore'] }); child.once('spawn', async () => { const sample = await createTsCpuReader()(child.pid); if (process.platform === 'linux' && sample.status !== 'measured') process.exitCode = 8; if (sample.status === 'measured' && sample.parent.pgid !== child.pid) process.exitCode = 7; child.stdin.end(); });`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15_000, env: fixtureEnvironment(root) })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('wt-tsls: CPU watchdog: budget 100% per tsserver for 120000ms, sample 5000ms')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function processState(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2)[0]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'
    throw error
  }
}

it.skipIf(process.platform !== 'linux')('stops a real synchronous spinning child even though its event loop cannot service timers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wt-tsls-cpu-spin-'))
  const cli = join(root, 'cli.mjs'), server = join(root, 'tsserver.js')
  writeFileSync(server, 'while (true) {}')
  writeFileSync(cli, `import { spawn } from 'node:child_process'; const child = spawn(process.execPath, [${JSON.stringify(server)}], { stdio: 'ignore' }); console.log(child.pid); setInterval(() => {}, 1000);`)
  const child = spawn(process.execPath, [cli], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: fixtureEnvironment(root) })
  const lines = createInterface({ input: child.stdout })
  let serverPid: number | undefined
  const write = vi.fn()
  try {
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(15_000) })
    serverPid = Number(line)
    expect(Number.isSafeInteger(serverPid) && serverPid > 0).toBe(true)
    const closed = once(child, 'close', { signal: AbortSignal.timeout(15_000) })
    monitorTsserverCpu(child, { write }, { intervalMs: 50, windowMs: 200, budgetPct: 1 })
    const result = await closed
    expect(result).toEqual([null, 'SIGKILL'])
    await vi.waitFor(() => expect(write.mock.calls.flat().join('')).toContain('stopped backend and tsserver'))
    // A dead child may remain briefly as a zombie until the host reaps it; no CPU can accrue.
    await vi.waitFor(() => expect(['gone', 'Z', 'X']).toContain(processState(serverPid!)), { timeout: 15_000, interval: 20 })
  } finally {
    lines.close()
    try { process.kill(-child.pid!, 'SIGKILL') } catch { /* Already dead. */ }
    rmSync(root, { recursive: true, force: true })
  }
}, 40_000)
