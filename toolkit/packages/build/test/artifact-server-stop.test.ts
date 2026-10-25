import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper shipped by the plugin has no TypeScript declaration
import { createHostAdapter } from '../../../../plugin/bin/lib/host/adapter.mjs'
// @ts-expect-error runtime .mjs helper shipped by the plugin has no TypeScript declaration
import { retainProcessOwner, signalProcess } from '../../../../plugin/bin/lib/host/process-signal-boundary.mjs'
// @ts-expect-error runtime .mjs helper shipped by the plugin has no TypeScript declaration
import { acquireArtifactControlClaim } from '../../../../plugin/bin/lib/host/artifact-control-claim.mjs'

type Probe = { kind: string, reason?: string, health?: { pid?: unknown, port?: unknown, startToken?: unknown } }
type Result = { ok: boolean, message: string }
type Liveness = string | ((now: number) => string | undefined)
type ControlOptions = {
  state?: string, readyAt?: number, child?: Record<string, unknown>, failed?: boolean,
  discovery?: Record<string, unknown> | null, identity?: () => unknown, initialHealth?: Probe,
}
const BIRTH = { status: 'known', pid: 42, startIdentity: 'boot-id:123456' }
const SERVER = fileURLToPath(new URL('../../../../plugin/bin/wt-artifact-server.mjs', import.meta.url))
const platforms = ['linux', 'darwin', 'win32']
const actions = ['stop', 'restart']

// Execute the CLI's actual control functions with a deterministic clock and host IO.
// The optional source override is used only by the external mutation proof.
function controls(platform: string, current: Probe, livenessError?: Liveness, signalError?: string, replacement = { kind: 'ours', health: { pid: 43, port: 48001, startToken: 'launch-token' } } as Probe, options: ControlOptions = {}) {
  const source = readFileSync(process.env.WT_ARTIFACT_STOP_SOURCE ?? SERVER, 'utf8')
  const stop = source.slice(source.indexOf('async function stopRunning('), source.indexOf('function spawnServer('))
  const control = source.slice(source.indexOf('async function controlCommand('), source.indexOf('async function statusCommand('))
  const ready = source.slice(source.indexOf('function artifactReplacementReady('), source.indexOf('async function controlCommand('))
  const state = { pid: 42, port: 48001, processIdentity: BIRTH, startToken: 'original-launch', ...options.discovery }
  const health = { pid: 42, port: 48001, startToken: 'original-launch', registeredSessions: 0 }
  let now = 0
  const kill = vi.fn((_pid: number, signal: string | number) => {
    const error = signal === 0 ? (typeof livenessError === 'function' ? livenessError(now) : livenessError) : signalError
    if (error) throw Object.assign(new Error(error), { code: error })
  })
  const host = { ...createHostAdapter({ platform, invoke: { kill, read: () => ({ status: 'read', value: `42 (test) ${options.state ?? 'S'} 1` }) } }),
    readProcessIdentity: vi.fn(options.identity ?? (() => BIRTH)) }
  const spawnServer = vi.fn(() => ({ child: { pid: 43, exitCode: null, signalCode: null, ...options.child }, token: 'launch-token', failed: options.failed ?? false }))
  let claimed = false
  const context = {
    process: { platform }, Date: { now: () => now }, hostAdapter: host,
    setTimeout: (done: () => void, ms: number) => { now += ms; done() },
    readArtifactDiscovery: () => options.discovery === null ? null : state,
    // Unconditional IO seal: every probe and spawn stays stubbed even for archived/mutated code.
    probeArtifactServer: async () => !spawnServer.mock.calls.length ? options.initialHealth ?? { kind: 'ours', health }
      : now >= (options.readyAt ?? 0) ? replacement : current,
    hostProcfs: { readCommandLine: () => 'node\0wt-artifact-server.mjs\0serve' },
    atomicWriteJson: vi.fn(), artifactIntentPath: () => 'intent.json',
    signalProcess: (pid: number, signal: string) => signalProcess(pid, signal, host),
    retainProcessOwner,
    spawnServer,
    ensureSecureStateDir: () => 'state-dir', configuredArtifactPort: () => 48001,
    acquireArtifactControlClaim: () => { if (claimed) return null; claimed = true; return () => { claimed = false } },
  }
  const command = runInNewContext(`${stop}\n${ready}\n${control}\ncontrolCommand`, context) as (action: string, force: boolean) => Promise<Result>
  return { command, spawnServer, kill, intent: context.atomicWriteJson, identity: host.readProcessIdentity, elapsed: () => now }
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

function registerIntentCase(platform: string, action: string) {
  it('records the verified PID and requested action before shutdown', async () => {
    const flow = controls(platform, { kind: 'free' }, 'ESRCH')
    await flow.command(action, true)
    expect(flow.intent).toHaveBeenCalledWith('intent.json', { pid: 42, action })
    expect(flow.intent.mock.invocationCallOrder[0]).toBeLessThan(flow.kill.mock.invocationCallOrder[0]!)
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
      const flow = controls(platform, { kind, health: { pid: 42 } }, (now) => now >= 2_750 ? 'ESRCH' : undefined)
      expect((await flow.command(action, true)).ok, 'shutdown must allow a delayed process exit').toBe(true)
      expect(flow.elapsed()).toBe(2_750)
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

    registerIntentCase(platform, action)
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

  it.each([
    { pid: 42 }, { pid: 44 }, { pid: 2_147_483_648 }, { pid: Number.MAX_SAFE_INTEGER },
    { port: 48002 }, { port: undefined }, { startToken: 'another-launch' }, { startToken: undefined },
  ])('refuses unrelated endpoint identity %j after spawning the replacement', async (identity) => {
    const flow = controls(platform, { kind: 'free' }, 'ESRCH', undefined, {
      kind: 'ours', health: { pid: 43, port: 48001, startToken: 'launch-token', ...identity },
    })
    expect(await flow.command('restart', true), 'health must identify this child, port and launch').toEqual({
      ok: false, message: 'artifact server: restart failed on 48001',
    })
  })

  it.each([
    { child: { exitCode: 1 } }, { child: { signalCode: 'SIGTERM' } },
    { child: { pid: undefined } }, { child: { pid: 0 } }, { failed: true },
  ])('refuses health for a failed or exited child %j', async (options) => {
    const flow = controls(platform, { kind: 'free' }, 'ESRCH', undefined, undefined, options)
    expect((await flow.command('restart', true)).ok, 'an exited or failed child cannot become ready').toBe(false)
  })

  it('retries transient readiness failures until this child answers', async () => {
    const flow = controls(platform, { kind: 'unknown' }, 'ESRCH', undefined, undefined, { readyAt: 1_250 })
    expect((await flow.command('restart', true)).ok, 'replacement readiness must retry transient failures').toBe(true)
    expect(flow.elapsed()).toBe(1_250)
    expect(flow.spawnServer).toHaveBeenCalledTimes(1)
  })
})

describe('artifact execution-state confirmation', () => {
  it.each(actions)('allows %s for an exited unreaped Linux process', async (action) => {
    const flow = controls('linux', { kind: 'free' }, undefined, undefined, undefined, { state: 'Z' })
    expect((await flow.command(action, true)).ok, 'an unreaped zombie has completed execution').toBe(true)
    expect(flow.spawnServer).toHaveBeenCalledTimes(action === 'restart' ? 1 : 0)
  })

  it.each(['Z', 'X', 'x', 'S', 'R', '?'])('reads Linux execution state %s without conflating existence', (state) => {
    const read = vi.fn(() => ({ status: 'read', value: `42 (name with ) parentheses) ${state} 1` }))
    const host = createHostAdapter({ platform: 'linux', invoke: { kill: vi.fn(), read } })
    const expected = ['Z', 'X', 'x'].includes(state) ? 'gone' : state === '?' ? 'unknown' : 'alive'
    expect(host.readProcessExecutionState(42).status).toBe(expected)
    expect(host.readProcessLiveness(42).status, 'ownership still measures existence').toBe('alive')
    expect(read).toHaveBeenCalledWith('/proc/42/stat')
  })

  it.each([
    { status: 'unavailable', reason: 'EACCES' }, { status: 'unavailable', reason: 'ENOENT' },
    { status: 'read', value: '' }, { status: 'read', value: '43 (wrong pid) Z 1' },
  ])('retains Linux ownership when state evidence is unavailable or malformed: %j', (stat) => {
    const host = createHostAdapter({ platform: 'linux', invoke: { kill: vi.fn(), read: () => stat } })
    expect(host.readProcessExecutionState(42)).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/^PROCESS_STATE_/) })
    expect(retainProcessOwner(42, host.readProcessExecutionState)).toBe(true)
  })

  it('names a throwing Linux state read as unknown', () => {
    const host = createHostAdapter({ platform: 'linux', invoke: {
      kill: vi.fn(), read: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) },
    } })
    expect(host.readProcessExecutionState(42)).toEqual({ status: 'unknown', reason: 'PROCESS_STATE_UNAVAILABLE: EACCES' })
  })

  it.each(['darwin', 'win32'])('names unavailable execution state on %s instead of guessing', (platform) => {
    const read = vi.fn()
    const host = createHostAdapter({ platform, invoke: { kill: vi.fn(), read } })
    expect(host.readProcessExecutionState(42)).toEqual({ status: 'unknown', reason: `PROCESS_STATE_UNAVAILABLE on ${platform}` })
    expect(read).not.toHaveBeenCalled()
  })
})

function expectNothingSignalled(flow: ReturnType<typeof controls>) {
  expect(flow.kill, 'identity ambiguity must not deliver a signal').not.toHaveBeenCalled()
  expect(flow.spawnServer, 'identity ambiguity must not launch another server').not.toHaveBeenCalled()
}

const IDENTITY_REFUSAL = { ok: false, message: "artifact server: could not verify the server's identity; nothing was stopped" }

function registerBirthRecheckCases(platform: string, action: string) {
  it('rechecks birth identity after the intent write', async () => {
    const flow = controls(platform, { kind: 'free' }, 'ESRCH')
    flow.intent.mockImplementation(() => flow.identity.mockReturnValue({ ...BIRTH, startIdentity: 'recycled-birth' }))
    expect(await flow.command(action, true), 'a recycled PID must be refused immediately before SIGTERM').toEqual(IDENTITY_REFUSAL)
    expect(flow.identity).toHaveBeenCalledWith(42)
    expect(flow.intent.mock.invocationCallOrder[0]).toBeLessThan(flow.identity.mock.invocationCallOrder[0]!)
    expectNothingSignalled(flow)
  })
  it.each([
    () => ({ status: 'unknown', reason: 'EACCES' }), () => ({ ...BIRTH, pid: 43 }),
    () => { throw new Error('unreadable birth') },
  ])('refuses unreadable or mismatched host identity %#', async (identity) => {
    const flow = controls(platform, { kind: 'free' }, 'ESRCH', undefined, undefined, { identity })
    expect(await flow.command(action, true)).toEqual(IDENTITY_REFUSAL)
    expectNothingSignalled(flow)
  })
  it('matches birth identity after intent and immediately before signalling', async () => {
    const flow = controls(platform, { kind: 'free' }, 'ESRCH')
    expect((await flow.command(action, true)).ok).toBe(true)
    expect(flow.identity).toHaveBeenCalledTimes(1)
    expect(flow.identity.mock.invocationCallOrder[0]).toBeLessThan(flow.kill.mock.invocationCallOrder[0]!)
    expect(flow.intent.mock.invocationCallOrder[0]).toBeLessThan(flow.identity.mock.invocationCallOrder[0]!)
  })
}

function registerDiscoveryCases(platform: string, action: string) {
  it('refuses an impersonated stale listener', async () => {
    const flow = controls(platform, { kind: 'free' }, 'ESRCH', undefined, undefined, {
      identity: () => ({ ...BIRTH, startIdentity: 'unrelated-process-birth' }),
    })
    expect(await flow.command(action, true), 'forged matching health and command text cannot prove birth identity').toEqual(IDENTITY_REFUSAL)
    expectNothingSignalled(flow)
  })
  it.each([undefined, 'foreign-launch'])('refuses listener launch mismatch %j', async (startToken) => {
    const flow = controls(platform, { kind: 'free' }, 'ESRCH', undefined, undefined, { discovery: { startToken } })
    expect(await flow.command(action, true)).toEqual(IDENTITY_REFUSAL)
    expectNothingSignalled(flow)
  })
  it('refuses missing discovery as unknown', async () => {
    const flow = controls(platform, { kind: 'free' }, 'ESRCH', undefined, undefined, { discovery: null })
    expect(await flow.command(action, true), 'missing discovery never proves stopped').toEqual({
      ok: false, message: 'artifact server: unknown, nothing stopped (discovery unavailable)',
    })
    expectNothingSignalled(flow)
  })
  it('refuses an injected WSL2 reset without treating uncertainty as stopped', async () => {
    const flow = controls(platform, { kind: 'free' }, 'ESRCH', undefined, undefined, { initialHealth: { kind: 'unknown', reason: 'ECONNRESET' } })
    expect(await flow.command(action, true)).toEqual(IDENTITY_REFUSAL)
    expectNothingSignalled(flow)
  })
  it.each([undefined, { ...BIRTH, startIdentity: '' }])('refuses absent recorded birth identity %j', async (processIdentity) => {
    const flow = controls(platform, { kind: 'free' }, 'ESRCH', undefined, undefined, { discovery: { processIdentity } })
    expect(await flow.command(action, true)).toEqual(IDENTITY_REFUSAL)
    expectNothingSignalled(flow)
  })
}

describe.each(platforms)('artifact signal authorization through %s host adapter', (platform) => {
  describe.each(actions)('%s', (action) => {
    registerBirthRecheckCases(platform, action)
    registerDiscoveryCases(platform, action)
  })
  it('serializes overlapping restarts through replacement readiness', async () => {
    const flow = controls(platform, { kind: 'free' }, 'ESRCH', undefined, undefined, { readyAt: 1_250 })
    const results = await Promise.all([flow.command('restart', true), flow.command('restart', true)])
    expect(results.filter(result => result.ok), 'only one concurrent restart may launch').toHaveLength(1)
    expect(results.find(result => !result.ok)?.message).toMatch(/control.d claim unavailable/)
    expect(flow.spawnServer, 'concurrent restart must not compete with the first replacement').toHaveBeenCalledTimes(1)
    expect(flow.elapsed()).toBe(1_250)
    expect((await flow.command('stop', true)).message, 'the completed controller releases its claim').not.toMatch(/control.d claim unavailable/)
  })
})

const BOOT_ID = '12345678-1234-1234-1234-123456789abc'
function birthInvocation(stat = `42 (name with ) parentheses) S ${Array(18).fill('0').join(' ')} 9007199254740993`, boot = BOOT_ID) {
  return { read: vi.fn((file: string) => ({ status: 'read', value: file.endsWith('/stat') ? stat : boot })) }
}

describe('host birth identity evidence', () => {
  it('records PID, boot identity and exact start ticks without rounding', () => {
    const invoke = birthInvocation()
    const host = createHostAdapter({ platform: 'linux', invoke })
    expect(host.readProcessIdentity(42)).toEqual({ status: 'known', pid: 42, startIdentity: `linux:${BOOT_ID}:9007199254740993` })
    expect(invoke.read.mock.calls).toEqual([['/proc/42/stat'], ['/proc/sys/kernel/random/boot_id']])
  })
  it.each(['', '43 (wrong) S 1', '42 (malformed) ?', '42 (short) S 1'])('names malformed birth evidence as unknown: %j', (stat) => {
    expect(createHostAdapter({ platform: 'linux', invoke: birthInvocation(stat) }).readProcessIdentity(42)).toMatchObject({ status: 'unknown' })
  })
  it.each(['', 'not-a-boot-id'])('refuses invalid boot identity %j', (boot) => {
    expect(createHostAdapter({ platform: 'linux', invoke: birthInvocation(undefined, boot) }).readProcessIdentity(42)).toMatchObject({ status: 'unknown' })
  })
  it.each(['ENOENT', 'EACCES'])('names unavailable birth reads as unknown: %s', (reason) => {
    const invoke = { read: () => ({ status: 'unavailable', reason }) }
    expect(createHostAdapter({ platform: 'linux', invoke }).readProcessIdentity(42)).toEqual({ status: 'unknown', reason: 'PROCESS_IDENTITY_UNAVAILABLE' })
  })
  it('names a throwing birth read as unknown', () => {
    const invoke = { read: () => { throw new Error('read failed') } }
    expect(createHostAdapter({ platform: 'linux', invoke }).readProcessIdentity(42)).toEqual({ status: 'unknown', reason: 'PROCESS_IDENTITY_UNAVAILABLE' })
  })
  it.each(['darwin', 'win32'])('names birth identity unavailable on %s without guessing', (platform) => {
    const invoke = birthInvocation()
    expect(createHostAdapter({ platform, invoke }).readProcessIdentity(42)).toEqual({ status: 'unknown', reason: `PROCESS_IDENTITY_UNAVAILABLE on ${platform}` })
    expect(invoke.read).not.toHaveBeenCalled()
  })
  it.each([undefined, 0, -1, 1.5, '42'])('refuses invalid PID %j', (pid) => {
    expect(createHostAdapter({ platform: 'linux', invoke: birthInvocation() }).readProcessIdentity(pid)).toMatchObject({ status: 'unknown' })
  })
})

describe('artifact controller claim', () => {
  it('admits one controller, refuses competitors and releases idempotently', () => {
    const directory = mkdtempSync(join(tmpdir(), 'artifact-control-claim-'))
    try {
      const release = acquireArtifactControlClaim(directory)
      expect(release).toBeTypeOf('function')
      expect(acquireArtifactControlClaim(directory)).toBeNull()
      release()
      const second = acquireArtifactControlClaim(directory)
      expect(second).toBeTypeOf('function')
      release()
      expect(acquireArtifactControlClaim(directory), 'an old release must not delete a new claim').toBeNull()
      second()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
