import { ChildProcess, fork, spawnSync, type ForkOptions } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { exercise, running } from './admission-detach-cases.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN = process.env.WT_ADMISSION_DETACH_TEST_PLUGIN ?? join(ROOT, 'plugin')
const admissionUrl = pathToFileURL(join(PLUGIN, 'bin/lib/host/admission.mjs')).href
const { boundedAdmission } = await import(admissionUrl)
const { finishAdmissionContainer } = await import(pathToFileURL(join(PLUGIN, 'bin/lib/host/admission-containment.mjs')).href)
const variable = 'WT_SHUTDOWN_ADMISSION', timeoutVariable = `${variable}_TIMEOUT_MS`

function policyFixture(pending: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'admission-shutdown-'))
  const policy = join(root, 'policy.mjs'), marker = join(root, 'child.pid'), ready = join(root, 'ready')
  writeFileSync(policy, `import { spawn } from 'node:child_process'; import { readFileSync, writeFileSync, writeSync } from 'node:fs';
    export default () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
      const stat = readFileSync('/proc/' + child.pid + '/stat', 'utf8');
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      child.unref(); writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:child.pid, start}));
      writeFileSync(${JSON.stringify(ready)}, 'ready'); writeSync(1, 'ready\\n');
      return ${pending ? 'new Promise(() => {})' : "'denied'"};
    }`)
  return { root, policy, marker, ready }
}

function cleanupFixture(f: ReturnType<typeof policyFixture>) {
  // Successful containment reaps the PID; verify birth identity before red cleanup.
  try {
    const { pid, start } = JSON.parse(readFileSync(f.marker, 'utf8')) as { pid: number; start: string }
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === start) process.kill(pid, 'SIGKILL')
  } catch { /* already stopped or no published child */ }
  rmSync(f.root, { recursive: true, force: true })
}

function signalRunner(f: ReturnType<typeof policyFixture>, mode: string) {
  const runner = join(f.root, 'runner.mjs')
  writeFileSync(runner, `import { boundedAdmission } from ${JSON.stringify(admissionUrl)};
    import { fork } from 'node:child_process'; import { readFileSync } from 'node:fs';
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    const host = { platform: 'linux', fork: (...args) => {
      const owner = fork(...args);
      owner.stdout.once('data', () => ${mode === 'caller-group' ? "process.kill(-process.pid, 'SIGINT')" : "owner.kill('SIGTERM')"});
      return owner;
    } };
    const refusal = await boundedAdmission({repo: ${JSON.stringify(f.root)}, request: {}, signal: controller.signal},
      {${variable}: ${JSON.stringify(f.policy)}, ${timeoutVariable}: '60000'},
      {moduleVariable: ${JSON.stringify(variable)}, timeoutVariable: ${JSON.stringify(timeoutVariable)}, host, silent:true});
    const { pid } = JSON.parse(readFileSync(${JSON.stringify(f.marker)}, 'utf8'));
    let aliveAtReturn = false;
    try { const stat = readFileSync('/proc/' + pid + '/stat', 'utf8'); aliveAtReturn = !['Z','X','x'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    console.log(JSON.stringify({refusal, aliveAtReturn}));`)
  return runner
}

function registerSignalCases() {
  it.skipIf(process.platform !== 'linux').each(['caller-group', 'owner-term'])('contains descendants on %s termination', mode => {
    const f = policyFixture(true)
    try {
      // Node honors detached for sync spawns; the sync options type omits it.
      const options = { detached: true, encoding: 'utf8' as const, timeout: 15_000, killSignal: 'SIGKILL' as const }
      const result = spawnSync(process.execPath, [signalRunner(f, mode)], options)
      expect(result.status, result.stdout + result.stderr).toBe(0)
      const state = JSON.parse(result.stdout) as { refusal: string; aliveAtReturn: boolean }
      expect(state.aliveAtReturn, 'policy descendant must be dead AT return after termination').toBe(false)
      if (mode === 'caller-group') expect(state.refusal).toBe(`${variable}: interrupted during admission`)
      else expect(state.refusal).toContain('admission worker exited')
    } finally { cleanupFixture(f) }
  })
}

async function ready(marker: string) {
  const deadline = performance.now() + 10_000
  while (!existsSync(marker) && performance.now() < deadline) await sleep(5)
  expect(existsSync(marker), 'policy must publish its descendant before cancellation').toBe(true)
}

async function failedNotification(mode: string) {
  const f = policyFixture(mode !== 'refuse'), controller = new AbortController()
  let owner: ReturnType<typeof fork> | undefined
  const host = { platform: 'linux', fork: ((modulePath: string, args: string[], options: ForkOptions) => {
    owner = fork(modulePath, args, options)
    const stream = owner.stdio[4] as PassThrough
    stream.end = (() => { queueMicrotask(() => stream.emit('error', new Error('shutdown denied'))); return stream }) as typeof stream.end
    return owner
  }) as typeof fork }
  const pending = boundedAdmission({ repo: f.root, request: {}, signal: controller.signal }, {
    [variable]: f.policy, [timeoutVariable]: '10000',
  }, { moduleVariable: variable, timeoutVariable, host, silent: true })
  try {
    await ready(f.ready)
    if (mode === 'abort') controller.abort()
    const result = await Promise.race([pending, sleep(mode === 'timeout' ? 13_000 : 3000, 'UNRESOLVED')])
    const aliveAtReturn = running((JSON.parse(readFileSync(f.marker, 'utf8')) as { pid: number }).pid)
    expect(result, 'failed shutdown notification must not leave admission unresolved').not.toBe('UNRESOLVED')
    expect(aliveAtReturn, 'fallback must reap descendants AT return').toBe(false)
    const verdict = mode === 'refuse' ? 'denied' : mode === 'abort' ? 'interrupted during admission' : 'timed out after 10000 ms'
    expect(result).toBe(`${variable}: ${verdict}`)
  } finally {
    controller.abort()
    ;(owner?.stdio[4] as PassThrough | undefined)?.destroy()
    await pending
    cleanupFixture(f)
  }
}

function registerBoundedWaitCases() {
  it.skipIf(process.platform !== 'linux').each(['refuse', 'timeout', 'abort'])('bounds failed shutdown notification on %s', failedNotification)
  it.each(['exits-after-kill', 'never-exits', 'signal-denied'])('bounds an unresponsive containment owner (%s)', async mode => {
    vi.useFakeTimers()
    const owner = new ChildProcess(), stdout = new PassThrough(), stderr = new PassThrough(), shutdown = new PassThrough()
    Object.assign(owner, { stdout, stderr, stdio: [null, stdout, stderr, null, shutdown] })
    let exit!: () => void
    const exited = new Promise<void>(resolve => { exit = resolve })
    const kill = vi.spyOn(owner, 'kill').mockImplementation(signal => {
      if (mode === 'signal-denied') throw new Error('signal denied')
      if (mode === 'exits-after-kill' && signal === 'SIGKILL') exit()
      return true
    })
    let result: string | null | undefined
    const pending = finishAdmissionContainer(owner, exited).then((value: string | null) => { result = value })
    try {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(typeof result, 'every owner shutdown wait must settle within its bound').toBe('string')
      expect(result, 'every owner shutdown wait must be bounded and named unknown').toContain('containment unknown')
      expect(kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL'])
    } finally {
      exit(); await pending
      vi.useRealTimers()
    }
  })
}

export function registerContainmentShutdownCases() {
  registerSignalCases()
  registerBoundedWaitCases()
  registerShutdownRaceCase()
  it.skipIf(process.platform !== 'linux')('avoids numeric signals to reaped policy PIDs during termination fixture teardown', async () => {
    const signal = vi.spyOn(process, 'kill')
    try {
      await exercise('refuse', false)
      expect(signal.mock.calls, 'successful fixture teardown must not signal already-reaped policy PIDs').toEqual([])
    } finally { signal.mockRestore() }
  })
}

function registerShutdownRaceCase() {
  it('allows a closing owner to exit without a late shutdown-error signal', async () => {
    vi.useFakeTimers()
    const owner = new ChildProcess(), stdout = new PassThrough(), stderr = new PassThrough(), shutdown = new PassThrough()
    Object.assign(owner, { stdout, stderr, stdio: [null, stdout, stderr, null, shutdown] })
    let exit!: () => void
    const exited = new Promise<void>(resolve => { exit = resolve })
    shutdown.end = (() => { queueMicrotask(() => shutdown.emit('error', new Error('peer already closing'))); return shutdown }) as typeof shutdown.end
    const kill = vi.spyOn(owner, 'kill').mockReturnValue(true)
    const pending = finishAdmissionContainer(owner, exited)
    try {
      await vi.advanceTimersByTimeAsync(200)
      expect(kill, 'a late pipe error must not signal an owner already completing cleanup').not.toHaveBeenCalled()
      exit()
      expect(await pending, 'a closing owner must not produce a cleanup failure').toBeFalsy()
    } finally {
      exit(); await pending
      vi.useRealTimers()
    }
  })
}
