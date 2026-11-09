import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs, { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'

const roots: string[] = []
const fixture = fileURLToPath(new URL('./fixtures/lane-admission-e2e.mjs', import.meta.url))
const PLATFORMS = ['linux', 'darwin', 'win32'] as const
// @ts-expect-error runtime .mjs module
const load = () => import('../../../../plugin/bin/lib/host/lane-launch-admission.mjs')
// @ts-expect-error runtime .mjs module
const launcher = () => import('../../../../plugin/bin/wt-lane.mjs')
// @ts-expect-error runtime .mjs module
const adapter = () => import('../../../../plugin/bin/lib/host/adapter.mjs')
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
    await lease.waitUntilVisible(() => { visible = true; return 42 })
    return 0
  }
  const options = { lockPath, counter, warn: () => {}, pollMs: 1 }
  const codes = await Promise.all([withLaneLaunchAdmission(launch, options), withLaneLaunchAdmission(launch, options)])
  expect(codes.sort()).toEqual([0, 1])
  expect(launches).toBe(1)
  expect(existsSync(lockPath)).toBe(false)
})

it.each(['pgrep unavailable', 'malformed pid', 'counter timed out'])('T3 explicitly warns and admits an unknown count: %s', async (reason) => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  const messages: string[] = []
  let launched = false
  const code = await withLaneLaunchAdmission(async (lease: { waitUntilVisible: (readPid: () => null) => Promise<void> }) => {
    launched = true
    await lease.waitUntilVisible(() => null)
    return 0
  }, { lockPath, counter: () => ({ state: 'unknown', reason }), warn: (line: string) => messages.push(line) })
  expect(code).toBe(0)
  expect(launched).toBe(true)
  expect(messages).toEqual([`wt-lane: lane count NOT MEASURED: ${reason}`])
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

it('reads a visibility measurement state only once before admitting its unknown evidence', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  let calls = 0
  let stateReads = 0
  let now = 0
  const messages: string[] = []
  const unknown = { get state() { return ++stateReads === 1 ? 'unknown' : 'ok' }, reason: 'counter unavailable' }
  const result = await withLaneLaunchAdmission(async (lease: Lease) => {
    lease.trackWorker(40, () => true)
    await lease.waitUntilVisible(() => null)
    return 0
  }, { lockPath, counter: () => ++calls === 1 ? { state: 'ok', count: 0, pids: [] } : unknown,
    clock: () => now++, visibilityMs: 2, pollMs: 0, workerFinished: () => false, stopWorker: () => ({ status: 'ended' }),
    warn: (line: string) => messages.push(line) }).catch(String)
  expect(result, 'a visibility observation must not reread its counter state').toBe(0)
  expect(stateReads).toBe(1)
  expect(messages).toEqual(['wt-lane: lane count NOT MEASURED: counter unavailable'])
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

it.each([false, true])('an acquisition timeout names the live owner without suggesting deletion (reclaim guard=%s)', async (guard) => {
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
  expect(String(error)).not.toContain(`remove ${lockPath}`)
  expect(String(error)).not.toContain('wt-lane launcher')
  if (guard) expect(String(error)).toContain(`reclaim guard ${lockPath}.reclaim is present`)
  expect(readFileSync(lockPath, 'utf8')).toBe(owner)
})

// The default counter's pgrep ignores SIGTERM and never answers within its bound: admission must
// report the count as unmeasured, admit, and release the claim, instead of holding it indefinitely.
it.skipIf(process.platform === 'win32')('a hung default counter degrades to NOT MEASURED and releases the claim', async () => {
  const { root, lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  writeFileSync(join(root, 'pgrep'), "#!/bin/sh\ntrap '' TERM\nsleep 8\ntrue\n")
  chmodSync(join(root, 'pgrep'), 0o755)
  const messages: string[] = []
  const previousPath = process.env.PATH
  process.env.PATH = `${root}:${previousPath}`
  try {
    const code = await withLaneLaunchAdmission(async (lease: { waitUntilVisible: (readPid: () => null, terminal: () => boolean) => Promise<void> }) => {
      await lease.waitUntilVisible(() => null, () => true)
      return 0
    }, { lockPath, platform: 'linux', warn: (line: string) => messages.push(line) })
    expect(code).toBe(0)
  } finally { process.env.PATH = previousPath }
  expect(messages).toEqual(['wt-lane: lane count NOT MEASURED: pgrep did not answer in time for "opencode" and was stopped'])
  expect(existsSync(lockPath)).toBe(false)
}, 60_000)

// Removing the staging link fails (EIO) after the claim was or was not published. A published claim
// still reaches the caller and is released; a failed wait keeps its own error. Both report the link.
it.each([
  ['a published claim', false],
  ['a busy lock', true],
] as const)('a staging-link removal failure never loses %s', async (_label, busy) => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  const owner = JSON.stringify({ pid: process.pid, startIdentity: 'self:another-runtime', token: 'held' })
  if (busy) writeFileSync(lockPath, owner)
  const messages: string[] = []
  const realRm = fs.rmSync
  vi.spyOn(fs, 'rmSync').mockImplementation((path: Parameters<typeof fs.rmSync>[0], options?: Parameters<typeof fs.rmSync>[1]) => {
    if (/\.claim(?:\.held)?$/.test(String(path))) throw Object.assign(new Error('EIO: unlink failed'), { code: 'EIO' })
    realRm(path, options)
  })
  syncBuiltinESMExports()
  let outcome: unknown
  try {
    outcome = await withLaneLaunchAdmission(() => 0, { lockPath, waitMs: 0, counter: () => ({ state: 'ok', count: 0, pids: [] }),
      warn: (line: string) => messages.push(line) }).catch((caught: Error) => caught.message)
  } finally { vi.restoreAllMocks(); syncBuiltinESMExports() }
  if (busy) {
    expect(String(outcome)).toContain('admission lock busy or owner unmeasured')
    expect(readFileSync(lockPath, 'utf8')).toBe(owner)
  } else {
    expect(outcome).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  }
  expect(messages).toEqual([expect.stringMatching(/^wt-lane: could not remove admission staging link .+\.claim\.held \(EIO\)/)])
  if (busy) {
    const { releaseLaneLaunchAdmission } = await load()
    releaseLaneLaunchAdmission({ file: lockPath, owner: JSON.parse(owner) })
  }
  expect(await withLaneLaunchAdmission(() => 0, { lockPath, waitMs: 0, counter: () => ({ state: 'ok', count: 0, pids: [] }) }), 'a failed unlink must not strand the next admission').toBe(0)
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

it('admits healthy bounded worker startup beyond the old ninety-second deadline', async () => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  let now = 0
  let reads = 0
  const stopped: number[] = []
  const result = await withLaneLaunchAdmission(async (lease: Lease) => {
    lease.trackWorker(40, () => true)
    await lease.waitUntilVisible(() => { now = 700_000; return ++reads === 1 ? null : 42 })
    return 0
  }, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [42] }), clock: () => now, pollMs: 0,
    workerFinished: () => false, stopWorker: (pid: number) => { stopped.push(pid); return { status: 'ended' } } }).catch(String)
  expect(result, 'a healthy bounded startup must be admitted').toBe(0)
  expect(stopped).toEqual([])
})

it.each(['unavailable', 'throws'])('warns and admits when ancestry snapshot %s instead of killing its worker', async (failure) => {
  const { lockPath } = setup()
  const { withLaneLaunchAdmission } = await load()
  const messages: string[] = []
  const stopped: number[] = []
  let now = 0
  const result = await withLaneLaunchAdmission(async (lease: Lease) => {
    lease.trackWorker(40, () => true)
    await lease.waitUntilVisible(() => 41)
    return 0
  }, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [42] }), readProcesses: () => {
    if (failure === 'throws') throw Error('snapshot unavailable')
    return { supported: false, reason: 'snapshot unavailable' }
  }, clock: () => now++, visibilityMs: 2, pollMs: 0, workerFinished: () => false,
  warn: (line: string) => messages.push(line), stopWorker: (pid: number) => { stopped.push(pid); return { status: 'ended' } } }).catch(String)
  expect(result, 'unmeasured ancestry must admit').toBe(0)
  expect(messages).toEqual(['wt-lane: lane count NOT MEASURED: snapshot unavailable'])
  expect(stopped, 'measurement failure must not stop the admitted worker').toEqual([])
})

it('names the live holder once to a long waiter, never suggesting deletion, and keeps waiting', async () => {
  const { lockPath } = setup()
  const { acquireLaneAdmissionLock, releaseLaneLaunchAdmission } = await load()
  const holder = await acquireLaneAdmissionLock(lockPath)
  const messages: string[] = []
  let now = 0
  const pending = acquireLaneAdmissionLock(lockPath, { clock: () => (now += 10_000), pollMs: 1, warn: (line: string) => messages.push(line) })
  for (let turn = 0; turn < 500 && now < 200_000; turn++) await new Promise((resolve) => setTimeout(resolve, 1))
  releaseLaneLaunchAdmission(holder)
  const next = await pending
  releaseLaneLaunchAdmission(next)
  expect(messages, 'an indefinite wait must say once who it waits on').toEqual([
    expect.stringContaining(`still waiting for admission lock ${lockPath} (owner pid ${process.pid})`),
  ])
  expect(messages.join('\n')).not.toMatch(/remove/i)
})

it('bounds identity reads for a long waiter behind this process to at most two', async () => {
  const { lockPath } = setup()
  const { acquireLaneAdmissionLock, releaseLaneLaunchAdmission } = await load()
  const { hostAdapter } = await adapter()
  const identity = vi.spyOn(hostAdapter, 'readProcessIdentity')
  const snapshot = vi.spyOn(hostAdapter, 'readProcessSnapshot')
  let holder
  let now = 0
  try {
    holder = await acquireLaneAdmissionLock(lockPath)
    await expect(acquireLaneAdmissionLock(lockPath, { clock: () => (now += 10_000), waitMs: 190_000, pollMs: 1, warn: () => {} })).rejects.toThrow('admission lock')
    expect(identity.mock.calls.length, 'self claims must not read identity on every poll').toBeLessThanOrEqual(2)
    expect(snapshot.mock.calls.length, 'self claims must not read snapshots on every poll').toBeLessThanOrEqual(2)
  } finally { releaseLaneLaunchAdmission(holder); vi.restoreAllMocks() }
})

async function foreignHolder() {
  const { root, lockPath } = setup()
  writeFileSync(join(root, 'count.json'), JSON.stringify({ state: 'ok', count: 0, pids: [] }))
  const holder = contender(root)
  await holder.entered
  const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
  writeFileSync(lockPath, JSON.stringify({ ...owner, startIdentity: 1000 }))
  return { lockPath, holder }
}

it.each(PLATFORMS)('bounds foreign identity reads by elapsed time on %s while checking liveness every poll', async (platform) => {
  const { acquireLaneAdmissionLock, releaseLaneLaunchAdmission } = await load()
  releaseLaneLaunchAdmission(await acquireLaneAdmissionLock(join(setup().root, 'warmup.lock')))
  const { lockPath, holder } = await foreignHolder()
  const { hostAdapter } = await adapter()
  const originalPlatform = hostAdapter.platform
  hostAdapter.platform = platform
  const identity = vi.spyOn(hostAdapter, 'readProcessIdentity').mockImplementation((pid: number) => platform === 'linux' || pid === process.pid
    ? { status: 'known', startIdentity: 1000 } : { status: 'unknown', reason: 'PROCESS_IDENTITY_UNAVAILABLE' })
  const snapshot = vi.spyOn(hostAdapter, 'readProcessSnapshot').mockReturnValue({ processes: [{ pid: holder.child.pid, startIdentity: 1000 }] })
  vi.spyOn(hostAdapter, 'readProcessExecutionState').mockReturnValue({ status: 'unknown' })
  const live = vi.spyOn(hostAdapter, 'readProcessLiveness')
  let now = -100
  try {
    await expect(acquireLaneAdmissionLock(lockPath, { clock: () => (now += 100), waitMs: 2500, pollMs: 1, warn: () => {} })).rejects.toThrow('admission lock')
    const bound = Math.floor(now / 1000) + 1
    expect(identity.mock.calls.filter(([pid]) => pid === holder.child.pid).length, 'foreign identity reads must be bounded by elapsed time, not polls').toBeLessThanOrEqual(bound)
    expect(snapshot.mock.calls.length, 'foreign snapshots must be bounded by elapsed time, not polls').toBeLessThanOrEqual(bound)
    expect(live.mock.calls.filter(([pid]) => pid === holder.child.pid).length, 'signal zero still runs every poll').toBeGreaterThanOrEqual(25)
  } finally { hostAdapter.platform = originalPlatform; vi.restoreAllMocks(); holder.child.kill('SIGKILL'); await holder.exited }
})

it('rechecks a reused foreign PID at the one-second boundary, without polling identity before then', async () => {
  const { acquireLaneAdmissionLock, releaseLaneLaunchAdmission } = await load()
  const { lockPath, holder } = await foreignHolder()
  const { hostAdapter } = await adapter()
  let now = 0
  const reads: number[] = []
  const realIdentity = hostAdapter.readProcessIdentity
  vi.spyOn(hostAdapter, 'readProcessIdentity').mockImplementation((pid: number) => {
    if (pid !== holder.child.pid) return realIdentity(pid)
    reads.push(now)
    return { status: 'known', startIdentity: now === 0 ? 1000 : 2000 }
  })
  let claim
  const pending = acquireLaneAdmissionLock(lockPath, { clock: () => now, pollMs: 1, warn: () => {} })
  try {
    now = 999
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reads, 'a live cached birth must last until its re-check boundary').toEqual([0])
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(holder.child.pid)
    now = 1000
    await vi.waitFor(() => expect(reads, 'PID reuse and guarded confirmation each need fresh evidence at the boundary').toEqual([0, 1000, 1000]))
    claim = await pending
    expect(claim.owner.pid).toBe(process.pid)
  } finally {
    now = 1000
    if (!claim) releaseLaneLaunchAdmission({ file: lockPath, owner: JSON.parse(readFileSync(lockPath, 'utf8')) })
    claim ??= await pending
    releaseLaneLaunchAdmission(claim); vi.restoreAllMocks(); holder.child.kill('SIGKILL'); await holder.exited
  }
})

it('detects a gone foreign holder on the next poll even with a cached birth', async () => {
  const { acquireLaneAdmissionLock, releaseLaneLaunchAdmission } = await load()
  const { lockPath, holder } = await foreignHolder()
  const { hostAdapter } = await adapter()
  let gone = false
  const identity = vi.spyOn(hostAdapter, 'readProcessIdentity').mockReturnValue({ status: 'known', startIdentity: 1000 })
  vi.spyOn(hostAdapter, 'readProcessExecutionState').mockReturnValue({ status: 'unknown' })
  const live = vi.spyOn(hostAdapter, 'readProcessLiveness').mockImplementation((pid: number) => ({ status: pid === holder.child.pid && gone ? 'gone' : 'alive' }))
  let claim
  const pending = acquireLaneAdmissionLock(lockPath, { clock: () => 0, pollMs: 1 })
  try {
    await vi.waitFor(() => expect(live.mock.calls.filter(([pid]) => pid === holder.child.pid).length).toBeGreaterThanOrEqual(3))
    const liveChecks = live.mock.calls.filter(([pid]) => pid === holder.child.pid).length
    expect(identity.mock.calls.filter(([pid]) => pid === holder.child.pid), 'live polls before death must reuse the matching cached identity').toHaveLength(1)
    gone = true
    claim = await pending
    expect(live.mock.calls.filter(([pid]) => pid === holder.child.pid)).toHaveLength(liveChecks + 2)
    expect(claim.owner.pid).toBe(process.pid)
  } finally {
    gone = true
    claim ??= await pending
    releaseLaneLaunchAdmission(claim); vi.restoreAllMocks(); holder.child.kill('SIGKILL'); await holder.exited
  }
})

it.each(['holder', 'queued claim', 'reclaim guard'])('preserves a live replacement %s inside the identity cache interval', async (kind) => {
  const { root, lockPath } = setup()
  const { acquireLaneAdmissionLock, releaseLaneLaunchAdmission } = await load()
  const { hostAdapter } = await adapter()
  const pid = 2147483600
  const old = { pid, startIdentity: 'birth-A', token: 'old', ticket: 1 }
  const replacement = { ...old, startIdentity: 'birth-B', token: 'replacement' }
  const seed = `${lockPath}.seed.claim`
  writeFileSync(seed, JSON.stringify(old))
  let nativeBirth = 'birth-A'
  vi.spyOn(hostAdapter, 'readProcessIdentity').mockImplementation((target: number) => ({ status: 'known', startIdentity: target === pid ? nativeBirth : 'own' }))
  vi.spyOn(hostAdapter, 'readProcessExecutionState').mockReturnValue({ status: 'alive' })
  const path = kind === 'holder' ? lockPath : kind === 'queued claim' ? `${lockPath}.replacement.claim` : join(`${lockPath}.reclaim`, replacement.token)
  let ticks = 0
  let waitingTicket
  let admitted
  try {
    const result = await acquireLaneAdmissionLock(lockPath, { waitMs: 100, pollMs: 1, clock: () => {
      if (ticks++ === 0) return 0
      if (existsSync(seed)) {
        rmSync(seed); nativeBirth = 'birth-B'
        if (kind === 'reclaim guard') mkdirSync(`${lockPath}.reclaim`)
        writeFileSync(path, JSON.stringify(replacement))
      }
      const waiting = readdirSync(root).find((name) => name.endsWith('.claim') && !name.endsWith('.replacement.claim'))
      if (waiting) waitingTicket = JSON.parse(readFileSync(join(root, waiting), 'utf8')).ticket
      return 100
    } }).catch((error: Error) => error)
    if (!(result instanceof Error)) admitted = result
    expect(existsSync(path), 'a live replacement owner file must never be removed by cached mismatch').toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(replacement)
    expect(result, 'a live replacement must retain admission priority').toBeInstanceOf(Error)
    expect(waitingTicket, 'the waiting acquisition must remain behind replacement ticket one').toBe(2)
  } finally { releaseLaneLaunchAdmission(admitted); vi.restoreAllMocks() }
})

it('freshly verifies a replacement holder again under the reclaim guard', async () => {
  const { lockPath } = setup()
  const { acquireLaneAdmissionLock } = await load()
  const { hostAdapter } = await adapter()
  const pid = 2147483600
  const replacement = { pid, startIdentity: 'birth-C', token: 'replacement' }
  writeFileSync(lockPath, JSON.stringify({ ...replacement, startIdentity: 'birth-A', token: 'old' }))
  let nativeBirth = 'birth-B'
  vi.spyOn(hostAdapter, 'readProcessIdentity').mockImplementation((target: number) => ({ status: 'known', startIdentity: target === pid ? nativeBirth : 'own' }))
  vi.spyOn(hostAdapter, 'readProcessExecutionState').mockReturnValue({ status: 'alive' })
  const rename = fs.renameSync
  vi.spyOn(fs, 'renameSync').mockImplementation((...args: Parameters<typeof fs.renameSync>) => {
    rename(...args)
    if (String(args[1]) === `${lockPath}.reclaim`) {
      nativeBirth = 'birth-C'
      writeFileSync(lockPath, JSON.stringify(replacement))
    }
  })
  syncBuiltinESMExports()
  try {
    await expect(acquireLaneAdmissionLock(lockPath, { waitMs: 0 })).rejects.toThrow('admission lock')
    expect(existsSync(lockPath), 'guarded recheck must not delete a live replacement holder').toBe(true)
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(replacement)
  } finally { vi.restoreAllMocks(); syncBuiltinESMExports() }
})

it('retries an unavailable own identity on a later acquisition', async () => {
  vi.resetModules()
  const { lockPath } = setup()
  const { acquireLaneAdmissionLock, releaseLaneLaunchAdmission } = await load()
  const { hostAdapter } = await adapter()
  const platform = hostAdapter.platform
  hostAdapter.platform = 'linux'
  const identity = vi.spyOn(hostAdapter, 'readProcessIdentity').mockReturnValue({ status: 'unknown', reason: 'PROCESS_IDENTITY_UNAVAILABLE' })
  let claim
  try {
    claim = await acquireLaneAdmissionLock(lockPath)
    expect(claim.owner.startIdentity).toMatch(/^self:/)
    expect(identity).toHaveBeenCalledTimes(1)
    releaseLaneLaunchAdmission(claim)
    identity.mockReturnValue({ status: 'known', startIdentity: 'recovered-native-birth' })
    claim = await acquireLaneAdmissionLock(lockPath)
    expect(claim.owner.startIdentity, 'a later acquisition must record the recovered native birth').toBe('recovered-native-birth')
    expect(identity).toHaveBeenCalledTimes(2)
  } finally { releaseLaneLaunchAdmission(claim); hostAdapter.platform = platform; vi.restoreAllMocks() }
})

it('waits through a burst without the arbitrary default two-minute refusal', async () => {
  const { lockPath } = setup()
  const { acquireLaneAdmissionLock, releaseLaneLaunchAdmission } = await load()
  const first = await acquireLaneAdmissionLock(lockPath)
  let now = 0
  const pending = acquireLaneAdmissionLock(lockPath, { clock: () => { now += 130_000; return now }, pollMs: 1 })
    .catch((error: Error) => error)
  await setImmediate()
  releaseLaneLaunchAdmission(first)
  const next = await pending
  expect(next, 'under-cap waiters must survive a long predecessor').not.toBeInstanceOf(Error)
  if (!(next instanceof Error)) releaseLaneLaunchAdmission(next)
})

it('admits visible queue predecessors before younger faster pollers', async () => {
  const { lockPath } = setup()
  const { acquireLaneAdmissionLock, releaseLaneLaunchAdmission } = await load()
  const holder = await acquireLaneAdmissionLock(lockPath)
  const order: string[] = []
  const first = acquireLaneAdmissionLock(lockPath, { pollMs: 20 }).then((claim: unknown) => {
    order.push('first'); releaseLaneLaunchAdmission(claim)
  })
  const second = acquireLaneAdmissionLock(lockPath, { pollMs: 0 }).then((claim: unknown) => {
    order.push('second'); releaseLaneLaunchAdmission(claim)
  })
  releaseLaneLaunchAdmission(holder)
  await Promise.all([first, second])
  expect(order, 'polling speed must not bypass a visible predecessor').toEqual(['first', 'second'])
})

it('uses the same default cap as the saturation hook over the whole under-cap family', async () => {
  const { lockPath } = setup()
  const { LANE_LAUNCH_CAP, withLaneLaunchAdmission } = await load()
  // @ts-expect-error runtime module
  const { DEFAULT_MAX, evaluateLaneCall } = await import('../../../../plugin/bin/lib/wt-lane-saturation-core.mjs')
  expect(LANE_LAUNCH_CAP, 'shared default must retain the sixteen-lane ceiling').toBe(16)
  expect(DEFAULT_MAX, 'hook and launch cap must agree').toBe(LANE_LAUNCH_CAP)
  for (let count = 0; count < LANE_LAUNCH_CAP; count++) {
    const counter = () => ({ state: 'ok', count, pids: [] })
    expect(await withLaneLaunchAdmission(() => 0, { lockPath, counter })).toBe(0)
    expect(evaluateLaneCall({ tool_input: { command: 'node wt-lane.mjs --dir .' } }, { env: {}, countLaneProcesses: counter }).silent).toBe(true)
  }
})

it('backs out a new link when a reclaim guard appears immediately after publication', async () => {
  const { lockPath } = setup()
  const { acquireLaneAdmissionLock } = await load()
  const realLink = fs.linkSync
  vi.spyOn(fs, 'linkSync').mockImplementation((...args: Parameters<typeof fs.linkSync>) => {
    realLink(...args)
    mkdirSync(`${lockPath}.reclaim`)
    writeFileSync(join(`${lockPath}.reclaim`, 'live'), JSON.stringify({ pid: process.pid, token: 'live' }))
  })
  syncBuiltinESMExports()
  try {
    await expect(acquireLaneAdmissionLock(lockPath, { waitMs: 0 })).rejects.toThrow('admission lock')
    expect(existsSync(lockPath)).toBe(false)
  } finally { vi.restoreAllMocks(); syncBuiltinESMExports() }
})

function contender(root: string) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/lane-admission-contender.mjs', import.meta.url)), root], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const events: string[] = []
  child.on('message', (message) => { events.push(String(message)) })
  const started = new Promise<void>((resolve) => child.on('message', (message) => { if (message === 'started') resolve() }))
  const entered = new Promise<void>((resolve) => child.on('message', (message) => { if (message === 'entered') resolve() }))
  const exited = once(child, 'exit')
  return { child, events, started, entered, exited }
}

it('two real launchers competing for one lock never both admit the sixteenth lane', async () => {
  const { root } = setup()
  writeFileSync(join(root, 'count.json'), JSON.stringify({ state: 'ok', count: 15, pids: [] }))
  const first = contender(root)
  await first.entered
  const second = contender(root)
  try {
    await second.started
    // No visibility is published until a different process has really begun competing.
    first.child.send('visible')
    second.child.send('visible')
    const results = await Promise.all([first.exited, second.exited])
    expect(results.map(([code]) => code).sort(), 'two real processes must never both admit the sixteenth lane').toEqual([0, 1])
    expect(second.events).not.toContain('entered')
  } finally {
    for (const item of [first, second]) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL')
    await Promise.all([first.exited, second.exited])
  }
})

it.skipIf(process.platform === 'win32')('reaps a killed waiter claim without breaking its live holder', async () => {
  const { root, lockPath } = setup()
  const { acquireLaneAdmissionLock, releaseLaneLaunchAdmission } = await load()
  writeFileSync(join(root, 'count.json'), JSON.stringify({ state: 'ok', count: 0, pids: [] }))
  const holder = await acquireLaneAdmissionLock(lockPath)
  const waiter = contender(root)
  try {
    await waiter.started
    waiter.child.kill('SIGKILL'); await waiter.exited
    expect(readdirSync(root).filter((name) => name.endsWith('.claim'))).toHaveLength(1)
    await expect(acquireLaneAdmissionLock(lockPath, { waitMs: 0 })).rejects.toThrow('admission lock')
    expect(readFileSync(lockPath, 'utf8')).toContain(holder.owner.token)
    expect(readdirSync(root).filter((name) => name.endsWith('.claim')), 'dead waiter claim must be recovered automatically').toHaveLength(0)
  } finally { releaseLaneLaunchAdmission(holder); if (waiter.child.exitCode === null && waiter.child.signalCode === null) waiter.child.kill('SIGKILL') }
})

it.skipIf(process.platform !== 'linux')('preserves a stopped live owner until it resumes and releases its own lock', async () => {
  const { root, lockPath } = setup()
  const { acquireLaneAdmissionLock, releaseLaneLaunchAdmission } = await load()
  writeFileSync(join(root, 'count.json'), JSON.stringify({ state: 'ok', count: 0, pids: [] }))
  const holder = contender(root)
  try {
    await holder.entered
    const before = readFileSync(lockPath, 'utf8')
    holder.child.kill('SIGSTOP')
    const deadline = Date.now() + 5_000
    const stopped = () => /\) T /.test(readFileSync(`/proc/${holder.child.pid}/stat`, 'utf8'))
    while (!stopped() && Date.now() < deadline) await setImmediate()
    expect(stopped()).toBe(true)
    await expect(acquireLaneAdmissionLock(lockPath, { waitMs: 0 })).rejects.toThrow('admission lock')
    expect(readFileSync(lockPath, 'utf8')).toBe(before)
    holder.child.kill('SIGCONT'); holder.child.send('visible')
    expect((await holder.exited)[0]).toBe(0)
    const next = await acquireLaneAdmissionLock(lockPath)
    releaseLaneLaunchAdmission(next)
  } finally {
    if (holder.child.exitCode === null && holder.child.signalCode === null) { holder.child.kill('SIGCONT'); holder.child.kill('SIGKILL') }
    await holder.exited
  }
})
