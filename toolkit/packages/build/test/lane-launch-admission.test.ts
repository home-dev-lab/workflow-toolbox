import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
const fixture = fileURLToPath(new URL('./fixtures/lane-admission-e2e.mjs', import.meta.url))
const PLATFORMS = ['linux', 'darwin', 'win32'] as const
// @ts-expect-error runtime .mjs module
const load = () => import('../../../../plugin/bin/lib/host/lane-launch-admission.mjs')
// @ts-expect-error runtime .mjs module
const launcher = () => import('../../../../plugin/bin/wt-lane.mjs')
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lane-admission-'))
  roots.push(root)
  return { root, lockPath: join(root, 'launch-admission.lock') }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it.each([16, 19])('T1 refuses an exported wt-lane launch at %i before any worker, snapshot or record', async (count) => {
  const { root, lockPath } = setup()
  const messages: string[] = []
  const { main } = await launcher()
  // @ts-expect-error runtime .mjs module
  const { laneHostDir } = await import('../../../../plugin/bin/lib/host/lane-host-dir.mjs')
  const artifacts = laneHostDir(root)
  const code = await main({ argv: ['--dir', root, '--model', 'openai/gpt-6.1-sol', '--brief', join(root, 'brief.md')], admissionOptions: {
    lockPath, counter: () => ({ state: 'ok', count, pids: [] }), warn: (line: string) => messages.push(line),
  } })
  expect(code).toBe(1)
  expect(messages.join('\n')).toContain(`Refused: ${count} lanes live, cap 16`)
  expect(existsSync(join(artifacts, 'brief-snapshots'))).toBe(false)
  expect(existsSync(join(artifacts, 'supervision'))).toBe(false)
  expect(existsSync(lockPath)).toBe(false)
})

it('propagates a launch refusal and non-zero status through a Node script caller', () => {
  const result = spawnSync(process.execPath, [fixture, 'refuse'], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Refused: 16 lanes live, cap 16')
})

it.skipIf(process.platform !== 'linux')('does not claim a foreign run appearing during startup', () => {
  const { root } = setup()
  const result = spawnSync(process.execPath, [fixture, 'foreign-record', root], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('foreign startup record: original worker left untouched')
})

it('T2 serialises concurrent admissions at 15 until the first child is counted', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  let visible = false
  let launches = 0
  const counter = () => ({ state: 'ok', count: visible ? 16 : 15, pids: visible ? [42] : [] })
  const launch = async (lease: { waitUntilVisible: (readPid: () => number) => Promise<void> }) => {
    launches += 1
    await setImmediate()
    visible = true
    await lease.waitUntilVisible(() => 42)
    return 0
  }
  const options = { lockPath, counter, warn: () => {}, pollMs: 1 }
  const codes = await Promise.all([withLaneLaunchAdmission(launch, options), withLaneLaunchAdmission(launch, options)])
  expect(codes.sort()).toEqual([0, 1])
  expect(launches).toBe(1)
  expect(existsSync(lockPath)).toBe(false)
})

it.each(PLATFORMS)('T3 explicitly warns and admits an unknown count on %s', async (platform) => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  const messages: string[] = []
  let launched = false
  const code = await withLaneLaunchAdmission(async (lease: { waitUntilVisible: (readPid: () => null) => Promise<void> }) => {
    launched = true
    await lease.waitUntilVisible(() => null)
    return 0
  }, { lockPath, platform, counter: () => ({ state: 'unknown', reason: 'pgrep unavailable' }), warn: (line: string) => messages.push(line) })
  expect(code).toBe(0)
  expect(launched).toBe(true)
  expect(messages).toEqual(['wt-lane: lane count NOT MEASURED: pgrep unavailable'])
  expect(existsSync(lockPath)).toBe(false)
})

it('uses the shared counter names and has a separate fixed hard cap', async () => {
  const { lockPath } = setup()
  const { LANE_LAUNCH_CAP, withLaneLaunchAdmission } = await load()
  const calls: unknown[] = []
  await withLaneLaunchAdmission(() => 0, { lockPath, counter: (...args: unknown[]) => {
    calls.push(args)
    return { state: 'ok', count: 0, pids: [] }
  } })
  expect(LANE_LAUNCH_CAP).toBe(16)
  expect(calls).toEqual([[['opencode', 'codex']]])
})

it.each(PLATFORMS)('derives a stable user state lock on %s', async (platform) => {
  const { root } = setup()
  const { laneLaunchAdmissionLockPath } = await load()
  // The state helper rejects foreign Windows spelling on a POSIX host; inject its base
  // for this branch, as the existing host-state tests do for simulated platforms.
  const file = laneLaunchAdmissionLockPath({ platform, home: root, ...(platform === 'win32' ? { base: root } : {}), env: {}, insideSandbox: false })
  const parts = { linux: ['.local', 'state'], darwin: ['Library', 'Application Support'], win32: [] }[platform]!
  if (platform !== 'win32') expect(file).toBe(join(root, ...parts, 'wt-lane-host', 'launch-admission.lock'))
  else expect(file).toBe(join(root, 'wt-lane-host', 'launch-admission.lock'))
})

it('T4 reclaims a positively dead owner, not an old live owner', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, startIdentity: 'dead', token: 'dead' }))
  expect(await withLaneLaunchAdmission(() => 0, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }) })).toBe(0)
  const options = { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }), waitMs: 0 }
  await withLaneLaunchAdmission(async () => {
    const before = readFileSync(lockPath, 'utf8')
    utimesSync(lockPath, new Date(0), new Date(0))
    await expect(withLaneLaunchAdmission(() => 0, options)).rejects.toThrow('admission lock')
    expect(readFileSync(lockPath, 'utf8')).toBe(before)
    return 0
  }, options)
  expect(existsSync(lockPath)).toBe(false)
})

it('T4 releases the lock after a throwing counter or launch', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  await expect(withLaneLaunchAdmission(() => 0, { lockPath, counter: () => { throw new Error('counter broke') } })).rejects.toThrow('counter broke')
  expect(existsSync(lockPath)).toBe(false)
  await expect(withLaneLaunchAdmission(() => { throw new Error('spawn broke') }, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }) })).rejects.toThrow('spawn broke')
  expect(existsSync(lockPath)).toBe(false)
})

it.each([false, true])('only stops the verified original worker on failure (verified=%s)', async (verified) => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  const calls: number[] = []
  const messages: string[] = []
  const pid = 2147483600
  await expect(withLaneLaunchAdmission((lease: { trackWorker: (pid: number, verify: () => boolean) => void }) => {
    lease.trackWorker(pid, () => verified)
    throw Error('launch broke')
  }, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }),
    warn: (line: string) => messages.push(line), stopWorker: (worker: number) => { calls.push(worker); return { status: 'ended' } } })).rejects.toThrow('launch broke')
  expect(calls).toEqual(verified ? [pid] : [])
  expect(messages).toEqual(verified ? [] : ['wt-lane: admission worker cleanup NOT CONFIRMED: identity changed or not measured'])
  expect(existsSync(lockPath)).toBe(false)
})

it('holds admission through an invisible child and explicitly times out', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  let now = 0
  await expect(withLaneLaunchAdmission(async (lease: { trackWorker: (pid: number) => void, waitUntilVisible: (readPid: () => null) => Promise<void> }) => {
    expect(existsSync(lockPath)).toBe(true)
    lease.trackWorker(2147483647)
    await lease.waitUntilVisible(() => null)
    return 0
  }, { lockPath, counter: () => ({ state: 'ok', count: 15, pids: [] }), clock: () => now++, visibilityMs: 2, pollMs: 0,
    workerFinished: () => false, warn: () => {} })).rejects.toThrow('new lane was not visible')
  expect(existsSync(lockPath)).toBe(false)
})

it('releases promptly when a failed worker and its process group are already gone', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  expect(await withLaneLaunchAdmission(async (lease: { trackWorker: (pid: number) => void, waitUntilVisible: (readPid: () => null) => Promise<void> }) => {
    lease.trackWorker(2147483647)
    await lease.waitUntilVisible(() => null)
    return 0
  }, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }) })).toBe(0)
  expect(existsSync(lockPath)).toBe(false)
})

it('keeps an unreadable claim rather than guessing its owner died', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  writeFileSync(lockPath, 'not JSON')
  await expect(withLaneLaunchAdmission(() => 0, { lockPath, waitMs: 0 })).rejects.toThrow('admission lock')
  expect(readFileSync(lockPath, 'utf8')).toBe('not JSON')
})

it('does not mistake an unrelated count increase for its own child', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  let now = 0
  await expect(withLaneLaunchAdmission(async (lease: { waitUntilVisible: (readPid: () => number) => Promise<void> }) => {
    await lease.waitUntilVisible(() => 42)
    return 0
  }, { lockPath, counter: () => ({ state: 'ok', count: 15, pids: [99] }), clock: () => now++, visibilityMs: 2, pollMs: 0 })).rejects.toThrow('new lane was not visible')
})

it('counts an opencode descendant behind a sandbox wrapper before releasing', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  let visible = false
  const code = await withLaneLaunchAdmission(async (lease: { trackWorker: (pid: number) => void, waitUntilVisible: (readPid: () => number) => Promise<void> }) => {
    lease.trackWorker(40)
    visible = true
    await lease.waitUntilVisible(() => 41)
    return 0
  }, { lockPath, counter: () => ({ state: 'ok', count: visible ? 16 : 15, pids: visible ? [43] : [] }),
    readProcesses: () => ({ processes: [{ pid: 43, ppid: 42 }, { pid: 42, ppid: 41 }, { pid: 41, ppid: 40 }] }) })
  expect(code).toBe(0)
  expect(existsSync(lockPath)).toBe(false)
})

it('releases when a short-lived worker has already completed between polls', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  const code = await withLaneLaunchAdmission(async (lease: { waitUntilVisible: (readPid: () => null, terminal: () => boolean) => Promise<void> }) => {
    await lease.waitUntilVisible(() => null, () => true)
    return 0
  }, { lockPath, counter: () => ({ state: 'ok', count: 15, pids: [] }) })
  expect(code).toBe(0)
  expect(existsSync(lockPath)).toBe(false)
})

it('win32 defaults to an explicit unmeasured warning without invoking pgrep', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  const messages: string[] = []
  expect(await withLaneLaunchAdmission(() => 0, { lockPath, platform: 'win32', warn: (line: string) => messages.push(line) })).toBe(0)
  expect(messages).toEqual(['wt-lane: lane count NOT MEASURED: pgrep is unavailable on win32'])
})

it('does not let per-worktree state overrides split the machine-shared lock', async () => {
  const { root } = setup()
  const { laneLaunchAdmissionLockPath } = await load()
  expect(laneLaunchAdmissionLockPath({ home: root, platform: 'linux', env: { WT_LANE_HOST_STATE: join(root, 'project-state') } }))
    .toBe(join(root, '.local', 'state', 'wt-lane-host', 'launch-admission.lock'))
})

it('uses the OS profile home even when a project isolates HOME', async () => {
  const { root } = setup()
  const { laneLaunchAdmissionLockPath } = await load()
  const expected = laneLaunchAdmissionLockPath({ platform: 'linux', env: {} })
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  try {
    process.env.HOME = join(root, 'project-home')
    process.env.USERPROFILE = join(root, 'project-home')
    expect(laneLaunchAdmissionLockPath({ platform: 'linux', env: {} })).toBe(expected)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

it.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)('releases a held claim on %s', async (signal) => {
  const { root, lockPath } = setup()
  const child = spawn(process.execPath, [fixture, 'hold', root], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await once(child.stdout!, 'data')
    expect(existsSync(lockPath)).toBe(true)
    const exited = once(child, 'exit')
    child.kill(signal)
    const [code] = await exited
    expect(code).toBe({ SIGTERM: 143, SIGINT: 130, SIGHUP: 129 }[signal])
    expect(existsSync(lockPath)).toBe(false)
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
})

it('reclaims a reused PID only when its recorded birth identity differs', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startIdentity: 'previous-birth', token: 'reused' }))
  expect(await withLaneLaunchAdmission(() => 0, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }) })).toBe(0)
  expect(existsSync(lockPath)).toBe(false)
})

it.each(['empty', 'dead'])('recovers a %s abandoned reclaim mutex', async (state) => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  mkdirSync(`${lockPath}.reclaim`)
  if (state === 'dead') writeFileSync(join(`${lockPath}.reclaim`, 'dead'), JSON.stringify({ pid: 2147483647, startIdentity: 'old', token: 'dead' }))
  expect(await withLaneLaunchAdmission(() => 0, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }) })).toBe(0)
  expect(existsSync(`${lockPath}.reclaim`)).toBe(false)
})

it('warns if measurement becomes unknown while waiting for child visibility', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  let calls = 0
  const messages: string[] = []
  expect(await withLaneLaunchAdmission(async (lease: { waitUntilVisible: (readPid: () => null) => Promise<void> }) => {
    await lease.waitUntilVisible(() => null)
    return 0
  }, { lockPath, counter: () => ++calls === 1 ? { state: 'ok', count: 0, pids: [] } : { state: 'unknown', reason: 'counter disappeared' }, warn: (line: string) => messages.push(line) })).toBe(0)
  expect(messages).toEqual(['wt-lane: lane count NOT MEASURED: counter disappeared'])
})

it.skipIf(process.platform === 'win32')('reclaims the claim after an uncatchable launcher crash', async () => {
  const { root, lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  const child = spawn(process.execPath, [fixture, 'hold', root], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await once(child.stdout!, 'data')
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    expect(existsSync(lockPath)).toBe(true)
    expect(await withLaneLaunchAdmission(() => 0, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }) })).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
})

type Lease = { trackWorker: (pid: number, verify?: () => boolean) => void, waitUntilVisible: (readPid: () => number | null) => Promise<void> }
// Worker 40 runs a counted preflight probe 41; its real lane spawn is 50, wrapped 50 -> 51 -> 52.
const PREFLIGHT_TREE = { processes: [{ pid: 41, ppid: 40 }, { pid: 50, ppid: 40 }, { pid: 51, ppid: 50 }, { pid: 52, ppid: 51 }] }

it.each([
  ['a counted preflight probe while no lane spawn is recorded', null, [41], false],
  ['a counted preflight probe beside a recorded lane spawn', 50, [41], false],
  ['a counted descendant of the recorded lane spawn', 50, [41, 52], true],
] as const)('visibility from %s (childPid=%s, counted=%j) releases=%s', async (_label, childPid, pids, released) => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  let now = 0
  const admission = withLaneLaunchAdmission(async (lease: Lease) => {
    lease.trackWorker(40, () => false)
    await lease.waitUntilVisible(() => childPid)
    return 0
  }, { lockPath, counter: () => ({ state: 'ok', count: 15, pids: [...pids] }), readProcesses: () => PREFLIGHT_TREE,
    clock: () => now++, visibilityMs: 2, pollMs: 0, workerFinished: () => false, warn: () => {} })
  if (released) expect(await admission).toBe(0)
  else await expect(admission).rejects.toThrow('new lane was not visible')
  expect(existsSync(lockPath)).toBe(false)
})

it.skipIf(process.platform !== 'linux')('never tracks or stops a worker it did not spawn, even under the same explicit run id', () => {
  const { root } = setup()
  const result = spawnSync(process.execPath, [fixture, 'foreign-same-run-id', root], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('foreign record under the same explicit run id: zero stop calls')
})

it.each([
  [{ status: 'ended' }, true, 'worker cleanup: ended (force-stop of worker pid 2147483600 accepted; its exit was not observed)'],
  [{ status: 'unavailable', reason: 'EPERM' }, true, 'worker cleanup: NOT CONFIRMED: EPERM'],
  [{ status: 'ended' }, false, 'worker cleanup: NOT CONFIRMED: identity changed or not measured'],
] as const)('a visibility timeout states the observed cleanup outcome (%j, verified=%s)', async (result, verified, expected) => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  const calls: number[] = []
  let now = 0
  const error = await withLaneLaunchAdmission(async (lease: Lease) => {
    lease.trackWorker(2147483600, () => verified)
    await lease.waitUntilVisible(() => null)
    return 0
  }, { lockPath, counter: () => ({ state: 'ok', count: 15, pids: [] }), clock: () => now++, visibilityMs: 2, pollMs: 0,
    workerFinished: () => false, warn: () => {}, stopWorker: (pid: number) => { calls.push(pid); return result } }).catch((caught: Error) => caught)
  expect(String(error)).toContain(expected)
  expect(String(error)).not.toContain('stopping its worker')
  expect(calls).toEqual(verified ? [2147483600] : [])
})

it.each([false, true])('an acquisition timeout names the lock file, its owner pid and the manual remedy (reclaim guard=%s)', async (guard) => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  const owner = JSON.stringify({ pid: process.pid, startIdentity: 'self:another-runtime', token: 'held' })
  writeFileSync(lockPath, owner)
  if (guard) {
    mkdirSync(`${lockPath}.reclaim`)
    writeFileSync(join(`${lockPath}.reclaim`, 'held'), owner)
  }
  const error = await withLaneLaunchAdmission(() => 0, { lockPath, waitMs: 0 }).catch((caught: Error) => caught)
  expect(String(error)).toContain(`admission lock busy or owner unmeasured: ${lockPath} (owner pid ${process.pid})`)
  // Other scripts may hold this lock too: the remedy is keyed on the claim's process, never on its kind.
  expect(String(error)).toContain(`if pid ${process.pid} is not running or is not the process that wrote this claim (pid reused), remove ${lockPath}, then retry`)
  expect(String(error)).not.toContain('wt-lane launcher')
  if (guard) expect(String(error)).toContain(`reclaim guard ${lockPath}.reclaim is present`)
  expect(readFileSync(lockPath, 'utf8')).toBe(owner)
})

it('a visibility timeout cleans its worker once even when the launcher tracks it again afterwards', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  const calls: number[] = []
  const messages: string[] = []
  let now = 0
  const error = await withLaneLaunchAdmission(async (lease: Lease) => {
    lease.trackWorker(2147483600, () => true)
    // launchAndObserve's finally tracks the record's worker again after a throw.
    try { await lease.waitUntilVisible(() => null) } finally { lease.trackWorker(2147483600, () => true) }
    return 0
  }, { lockPath, counter: () => ({ state: 'ok', count: 15, pids: [] }), clock: () => now++, visibilityMs: 2, pollMs: 0,
    workerFinished: () => false, warn: (line: string) => messages.push(line),
    stopWorker: (pid: number) => { calls.push(pid); return { status: 'ended' } } }).catch((caught: Error) => caught)
  expect(String(error)).toContain('worker cleanup: ended (force-stop of worker pid 2147483600 accepted')
  expect(calls).toEqual([2147483600])
  expect(messages).toEqual([])
})
