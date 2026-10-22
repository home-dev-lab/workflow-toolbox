import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper shipped by the plugin has no TypeScript declaration
import { createHostAdapter } from '../../../../plugin/bin/lib/host/adapter.mjs'
// @ts-expect-error runtime .mjs helper shipped by the plugin has no TypeScript declaration
import { retainProcessOwner, signalProcess } from '../../../../plugin/bin/lib/host/process-signal-boundary.mjs'

type Probe = { kind: string, health?: { pid?: unknown } }
type Result = { ok: boolean, message: string }
type Liveness = string | ((now: number) => string | undefined)
const SERVER = fileURLToPath(new URL('../../../../plugin/bin/wt-artifact-server.mjs', import.meta.url))
const platforms = ['linux', 'darwin', 'win32']
const actions = ['stop', 'restart']

// Execute the CLI's actual control functions with a deterministic clock and host IO.
// The optional source override is used only by the external mutation proof.
function controls(platform: string, current: Probe, livenessError?: Liveness, signalError?: string, replacement = { kind: 'ours', health: { pid: 43 } } as Probe) {
  const source = readFileSync(process.env.WT_ARTIFACT_STOP_SOURCE ?? SERVER, 'utf8')
  const stop = source.slice(source.indexOf('async function stopRunning('), source.indexOf('function spawnServer('))
  const control = source.slice(source.indexOf('async function controlCommand('), source.indexOf('async function statusCommand('))
  const state = { pid: 42, port: 48001 }
  const health = { ...state, registeredSessions: 0 }
  let now = 0
  const kill = vi.fn((_pid: number, signal: string | number) => {
    const error = signal === 0 ? (typeof livenessError === 'function' ? livenessError(now) : livenessError) : signalError
    if (error) throw Object.assign(new Error(error), { code: error })
  })
  const host = createHostAdapter({ platform, invoke: { kill } })
  const spawnServer = vi.fn()
  let probes = 0
  const context = {
    process: { platform }, Date: { now: () => now },
    setTimeout: (done: () => void, ms: number) => { now += ms; done() },
    readArtifactDiscovery: () => state,
    probeArtifactServer: async () => ++probes === 1 ? { kind: 'ours', health }
      : spawnServer.mock.calls.length ? replacement : current,
    hostProcfs: { readCommandLine: () => 'node\0wt-artifact-server.mjs\0serve' },
    atomicWriteJson: vi.fn(), artifactIntentPath: () => 'intent.json',
    signalProcess: (pid: number, signal: string) => signalProcess(pid, signal, host),
    retainProcessOwner: (pid: number) => retainProcessOwner(pid, host.readProcessLiveness),
    spawnServer,
  }
  const command = runInNewContext(`${stop}\n${control}\ncontrolCommand`, context) as (action: string, force: boolean) => Promise<Result>
  return { command, spawnServer, kill, elapsed: () => now }
}

function registerExitConfirmationCases(platform: string, action: string) {
  it.each(['unknown', 'foreign'])('refuses %s probe while PID is alive, denied, or unknown', async (kind) => {
    for (const error of [undefined, 'EPERM', 'EIO']) {
      const flow = controls(platform, { kind }, error)
      expect(await flow.command(action, true), `probe=${kind}, liveness=${error ?? 'alive'}`).toEqual({
        ok: false, message: 'artifact server: verified PID 42 did not stop',
      })
      expect(flow.spawnServer, 'unconfirmed stop must never spawn a replacement').not.toHaveBeenCalled()
      expect(flow.kill).toHaveBeenCalledWith(42, 'SIGTERM')
    }
  })

  it.each(['unknown', 'foreign', 'ours', 'free'])('confirms a gone PID regardless of a %s endpoint', async (kind) => {
    const flow = controls(platform, { kind, health: { pid: 42 } }, 'ESRCH')
    const result = await flow.command(action, true)
    expect(result.ok).toBe(true)
    expect(result.message).toBe(action === 'stop' ? 'artifact server: stopped' : 'artifact server: restarted on 48001')
    expect(flow.kill).toHaveBeenCalledWith(42, 0)
    expect(flow.spawnServer).toHaveBeenCalledTimes(action === 'restart' ? 1 : 0)
  })
}

describe.each(platforms)('artifact stop confirmation through %s host adapter', (platform) => {
  describe.each(actions)('%s', (action) => {
    registerExitConfirmationCases(platform, action)
    it.each([{ kind: 'free' }, ...[43, undefined, null, '42', 0, -1, 1.5].map((pid) => ({ kind: 'ours', health: { pid } }))])('refuses port evidence %j while the PID is retained', async (probe) => {
      for (const error of [undefined, 'EPERM', 'EIO']) {
        const flow = controls(platform, probe, error)
        expect(await flow.command(action, true), 'port evidence must not bypass process-exit confirmation').toEqual({
          ok: false, message: 'artifact server: verified PID 42 did not stop',
        })
        expect(flow.spawnServer).not.toHaveBeenCalled()
      }
    })

    it.each(['unknown', 'foreign', 'ours'])('waits for delayed process exit with a %s endpoint', async (kind) => {
      const flow = controls(platform, { kind, health: { pid: 42 } }, (now) => now >= 500 ? 'ESRCH' : undefined)
      expect((await flow.command(action, true)).ok, 'shutdown must allow a delayed process exit').toBe(true)
      expect(flow.elapsed()).toBe(500)
      expect(flow.spawnServer).toHaveBeenCalledTimes(action === 'restart' ? 1 : 0)
    })

    it('accepts ESRCH between verification and signaling without waiting or a second signal', async () => {
      const flow = controls(platform, { kind: 'foreign' }, undefined, 'ESRCH')
      expect((await flow.command(action, true)).ok, 'a verified process already gone is a completed stop').toBe(true)
      expect(flow.elapsed()).toBe(0)
      expect(flow.kill).toHaveBeenCalledTimes(1)
      expect(flow.spawnServer).toHaveBeenCalledTimes(action === 'restart' ? 1 : 0)
    })

    it.each(['EPERM', 'EIO'])('refuses a %s signal failure', async (error) => {
      const flow = controls(platform, { kind: 'free' }, 'ESRCH', error)
      expect(await flow.command(action, true)).toEqual({
        ok: false, message: `artifact server: failed to signal verified PID 42: ${error}`,
      })
      expect(flow.spawnServer).not.toHaveBeenCalled()
    })

    it('keeps polling when the verified PID still answers health', async () => {
      const flow = controls(platform, { kind: 'ours', health: { pid: 42 } })
      expect((await flow.command(action, true)).ok).toBe(false)
      expect(flow.spawnServer).not.toHaveBeenCalled()
    })
  })
})

describe.each(platforms)('artifact restart health through %s host adapter', (platform) => {
  it.each([undefined, null, '42', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('refuses malformed replacement PID %j after the original exits', async (pid) => {
    const flow = controls(platform, { kind: 'free' }, 'ESRCH', undefined, { kind: 'ours', health: { pid } })
    expect(await flow.command('restart', true), 'malformed PID must not confirm a restarted server').toEqual({
      ok: false, message: 'artifact server: restart failed on 48001',
    })
    expect(flow.spawnServer).toHaveBeenCalledTimes(1)
  })
})
