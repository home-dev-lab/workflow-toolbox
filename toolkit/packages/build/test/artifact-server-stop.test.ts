import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper shipped by the plugin has no TypeScript declaration
import { createHostAdapter } from '../../../../plugin/bin/lib/host/adapter.mjs'
// @ts-expect-error runtime .mjs helper shipped by the plugin has no TypeScript declaration
import { retainProcessOwner, signalProcess } from '../../../../plugin/bin/lib/host/process-signal-boundary.mjs'

type Probe = { kind: string, health?: { pid: number } }
type Result = { ok: boolean, message: string }
const SERVER = fileURLToPath(new URL('../../../../plugin/bin/wt-artifact-server.mjs', import.meta.url))
const platforms = ['linux', 'darwin', 'win32']
const actions = ['stop', 'restart']

// Execute the CLI's actual control functions with a deterministic clock and host IO.
// The optional source override is used only by the external mutation proof.
function controls(platform: string, current: Probe, livenessError?: string) {
  const source = readFileSync(process.env.WT_ARTIFACT_STOP_SOURCE ?? SERVER, 'utf8')
  const stop = source.slice(source.indexOf('async function stopRunning('), source.indexOf('function spawnServer('))
  const control = source.slice(source.indexOf('async function controlCommand('), source.indexOf('async function statusCommand('))
  const state = { pid: 42, port: 48001 }
  const health = { ...state, registeredSessions: 0 }
  const kill = vi.fn((_pid: number, signal: string | number) => {
    if (signal === 0 && livenessError) throw Object.assign(new Error(livenessError), { code: livenessError })
  })
  const host = createHostAdapter({ platform, invoke: { kill } })
  const spawnServer = vi.fn()
  let now = 0
  let probes = 0
  const context = {
    process: { platform }, Date: { now: () => now },
    setTimeout: (done: () => void, ms: number) => { now += ms; done() },
    readArtifactDiscovery: () => state,
    probeArtifactServer: async () => ++probes === 1 ? { kind: 'ours', health }
      : spawnServer.mock.calls.length ? { kind: 'ours', health: { ...health, pid: 43 } } : current,
    hostProcfs: { readCommandLine: () => 'node\0wt-artifact-server.mjs\0serve' },
    atomicWriteJson: vi.fn(), artifactIntentPath: () => 'intent.json',
    signalProcess: (pid: number, signal: string) => signalProcess(pid, signal, host),
    retainProcessOwner: (pid: number) => retainProcessOwner(pid, host.readProcessLiveness),
    spawnServer,
  }
  const command = runInNewContext(`${stop}\n${control}\ncontrolCommand`, context) as (action: string, force: boolean) => Promise<Result>
  return { command, spawnServer, kill }
}

describe.each(platforms)('artifact stop confirmation through %s host adapter', (platform) => {
  describe.each(actions)('%s', (action) => {
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

    it('confirms a gone PID even when a reset probe remains unknown', async () => {
      const flow = controls(platform, { kind: 'unknown' }, 'ESRCH')
      const result = await flow.command(action, true)
      expect(result.ok).toBe(true)
      expect(result.message).toBe(action === 'stop' ? 'artifact server: stopped' : 'artifact server: restarted on 48001')
      expect(flow.kill).toHaveBeenCalledWith(42, 0)
      expect(flow.spawnServer).toHaveBeenCalledTimes(action === 'restart' ? 1 : 0)
    })

    it.each([{ kind: 'free' }, { kind: 'ours', health: { pid: 43 } }])('accepts conclusive probe %j despite unknown liveness', async (probe) => {
      const flow = controls(platform, probe, 'EIO')
      expect((await flow.command(action, true)).ok).toBe(true)
      expect(flow.spawnServer).toHaveBeenCalledTimes(action === 'restart' ? 1 : 0)
    })

    it('keeps polling when the verified PID still answers health', async () => {
      const flow = controls(platform, { kind: 'ours', health: { pid: 42 } })
      expect((await flow.command(action, true)).ok).toBe(false)
      expect(flow.spawnServer).not.toHaveBeenCalled()
    })
  })
})
