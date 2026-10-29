// CPU warnings cannot own signals, cleanup promises, or the client's lifetime.
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { frame } from './helpers/ts-watch-fixture.js'

const plugin = process.env.WT_TSLS_CPU_TEST_ROOT ?? fileURLToPath(new URL('../../../../plugin/', import.meta.url))
const url = (name: string) => pathToFileURL(join(plugin, `bin/lib/host/${name}.mjs`)).href
const { monitorTsserverCpu } = await import(url('ts-cpu-watchdog'))
const { runTsLaunch } = await import(url('ts-language-server'))
afterEach(() => vi.useRealTimers())

const parent = { pid: 10, identity: '10:birth', pgid: 10 }
const sample = (cpuMs: number, family = false) => ({ status: 'measured', parent,
  servers: (family ? [11, 12] : [11]).map(pid => ({ pid, ppid: 10, pgid: 10, identity: `${pid}:birth`, cpuMs: family ? cpuMs / 2 : cpuMs })) })

function fixture(family = false, censusPending = false) {
  vi.useFakeTimers()
  const input = new PassThrough(), output = new PassThrough(), stderr = new PassThrough()
  const kill = vi.fn(() => { expect.fail('CPU supervision must never signal a process') })
  const child = Object.assign(new EventEmitter(), { pid: 10, exitCode: null, kill,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  const text: string[] = [], bytes: Buffer[] = []
  let onWarning = () => {}
  const write = vi.fn((message: string) => { text.push(message); if (message.includes('CPU budget exceeded:')) onWarning() })
  const census = vi.fn(() => censusPending ? new Promise(() => {}) : { status: 'unavailable', reason: 'denied' })
  const readTree = vi.fn(() => { expect.fail('warn-only supervision must not freeze or walk a stop tree') })
  const readFamily = vi.fn(async (): Promise<ReturnType<typeof sample> | { status: string; reason: string }> => sample(Date.now() * 1.5, family))
  const exit = vi.fn(() => output.end()), exitSignal = vi.fn(() => output.end())
  output.on('data', (chunk: Buffer) => bytes.push(chunk))
  runTsLaunch({ input, output, stderr, exit, exitSignal,
    select: () => ({ status: 'launch', backend: 'typescript-language-server', command: '/fake', args: [] }), start: () => child })
  input.write(frame({ id: 1, method: 'initialize', params: {} })); child.emit('spawn')
  child.stdout.write(frame({ id: 1, result: { capabilities: {} } }))
  monitorTsserverCpu(child, { write }, { readFamily, readTree, census, kill,
    readIdentity: () => ({ status: 'measured', process: parent }), now: () => Date.now(), intervalMs: 1000, windowMs: 2000 })
  const close = (code: number | null, signal: string | null) => { child.emit('exit', code, signal); child.emit('close', code, signal) }
  return { child, output, kill, census, readTree, readFamily, write, exit, exitSignal, close,
    text: () => text.join(''), bytes: () => Buffer.concat(bytes), onWarning: (callback: () => void) => { onWarning = callback },
    dispose: () => { close(0, null); for (const stream of [input, output, stderr, child.stdin, child.stdout, child.stderr]) stream.destroy() } }
}

it.each([false, true])('warns once with the measured excess and keeps sampling (combined family=%s)', async family => {
  const run = fixture(family)
  try {
    await vi.advanceTimersByTimeAsync(2000)
    expect(run.kill).not.toHaveBeenCalled()
    expect(run.text()).toContain(`CPU budget exceeded: ${family ? 'combined tsserver family 11,12' : 'tsserver 11'}: 150.0% CPU, 50.0 percentage points above 100% for 2000ms; stop is disabled in this version; sampling continues`)
    const reads = run.readFamily.mock.calls.length
    await vi.advanceTimersByTimeAsync(8000)
    run.readFamily.mockResolvedValueOnce(sample(Date.now() * 1.5, family))
    await vi.advanceTimersByTimeAsync(4000)
    expect(run.readFamily.mock.calls.length).toBeGreaterThan(reads)
    expect(run.text().split('\n').filter(line => line.includes('CPU budget exceeded:'))).toHaveLength(1)
    expect(run.kill).not.toHaveBeenCalled(); expect(run.census).not.toHaveBeenCalled(); expect(run.readTree).not.toHaveBeenCalled()
    expect(run.child.listenerCount('wt-tsls-cpu-stop')).toBe(0)
    expect(run.exit).not.toHaveBeenCalled(); expect(run.exitSignal).not.toHaveBeenCalled()
    expect(run.bytes()).toEqual(frame({ id: 1, result: { capabilities: {} } }))
  } finally { run.dispose() }
})

const closes = [{ code: 0, signal: null }, { code: 1, signal: null }, { code: null, signal: 'SIGTERM' }]
const phases = ['during warning', 'after warning', 'after outage', 'during pending sample']
const closeCases = phases.flatMap(phase => closes.flatMap(close => [false, true].map(censusPending => ({ phase, ...close, censusPending }))))

it.each(closeCases)('forwards backend close and client EOF $phase (code=$code signal=$signal censusPending=$censusPending)', async ({ phase, code, signal, censusPending }) => {
  const run = fixture(false, censusPending)
  let resolve = () => {}
  try {
    if (phase === 'during warning') run.onWarning(() => run.close(code, signal))
    await vi.advanceTimersByTimeAsync(2000)
    if (phase === 'after outage') {
      run.readFamily.mockResolvedValueOnce({ status: 'unavailable', reason: 'denied' })
      await vi.advanceTimersByTimeAsync(1000)
    }
    if (phase === 'during pending sample') {
      run.readFamily.mockImplementationOnce(() => new Promise(done => { resolve = () => done(sample(Date.now() * 1.5)) }))
      await vi.advanceTimersByTimeAsync(1000)
    }
    if (phase !== 'during warning') run.close(code, signal)
    resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.kill).not.toHaveBeenCalled()
    expect(run.text()).toContain('CPU budget exceeded:')
    if (signal) expect(run.exitSignal).toHaveBeenCalledExactlyOnceWith(signal)
    else expect(run.exit).toHaveBeenCalledExactlyOnceWith(code)
    expect(run.output.readableEnded).toBe(true)
    expect(run.census).not.toHaveBeenCalled(); expect(run.readTree).not.toHaveBeenCalled()
    const reads = run.readFamily.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.readFamily).toHaveBeenCalledTimes(reads)
    expect(vi.getTimerCount()).toBe(0)
  } finally { resolve(); run.dispose() }
})
