import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setImmediate } from 'node:timers/promises'

const plugin = process.env.WT_ADMISSION_PLUGIN
  ? pathToFileURL(`${process.env.WT_ADMISSION_PLUGIN}/`)
  : new URL('../../../../plugin/', import.meta.url)
const root = mkdtempSync(join(tmpdir(), 'lane-admission-selftest-'))
const lockPath = join(root, 'launch-admission.lock')
try {
  if (process.argv[2] === 'finished-worker') {
    const { withLaneLaunchAdmission } = await import(new URL('bin/lib/host/lane-launch-admission.mjs', plugin))
    let now = 0
    await assert.doesNotReject(withLaneLaunchAdmission(async (lease) => {
      lease.trackWorker(2147483647, () => false)
      await lease.waitUntilVisible(() => null)
      return 0
    }, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }),
      clock: () => now++, visibilityMs: 2, pollMs: 0, warn: () => {} }),
    'a finished worker with no process group must release admission without waiting for visibility')
    console.log('finished worker: empty process group releases admission promptly')
  } else if (process.argv[2] === 'birth-unavailable') {
    const { withLaneLaunchAdmission } = await import(new URL('bin/lib/host/lane-launch-admission.mjs', plugin))
    const { hostAdapter } = await import(new URL('bin/lib/host/adapter.mjs', plugin))
    const saved = { identity: hostAdapter.readProcessIdentity, snapshot: hostAdapter.readProcessSnapshot }
    hostAdapter.readProcessIdentity = () => ({ status: 'unknown' })
    hostAdapter.readProcessSnapshot = () => ({ processes: [] })
    try {
      await withLaneLaunchAdmission(async () => {
        const before = readFileSync(lockPath, 'utf8')
        assert.match(JSON.parse(before).startIdentity, /^self:/)
        hostAdapter.readProcessIdentity = saved.identity
        hostAdapter.readProcessSnapshot = saved.snapshot
        await assert.rejects(withLaneLaunchAdmission(() => 0, { lockPath, waitMs: 0 }), /admission lock/)
        assert.equal(readFileSync(lockPath, 'utf8'), before, 'a recovered native reader must not steal a live self-identity claim')
        return 0
      }, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }) })
    } finally { hostAdapter.readProcessIdentity = saved.identity; hostAdapter.readProcessSnapshot = saved.snapshot }
    console.log('unavailable birth reader: exclusive self identity retained until release')
  } else if (process.argv[2] === 'windows-signals') {
    const { withLaneLaunchAdmission } = await import(new URL('bin/lib/host/lane-launch-admission.mjs', plugin))
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    const before = process.listenerCount('SIGQUIT')
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
      await withLaneLaunchAdmission(() => {
        assert.equal(process.listenerCount('SIGQUIT'), before, 'Windows admission must not install an unsupported SIGQUIT listener')
        return 0
      }, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }) })
    } finally { Object.defineProperty(process, 'platform', descriptor) }
    console.log('Windows signal policy: only supported handlers installed')
  } else if (process.argv[2] === 'registration-throw') {
    const { withLaneLaunchAdmission } = await import(new URL('bin/lib/host/lane-launch-admission.mjs', plugin))
    const events = ['exit', 'SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']
    const before = new Map(events.map((event) => [event, process.listeners(event)]))
    const descriptor = Object.getOwnPropertyDescriptor(process, 'once')
    const original = process.once
    process.once = function (event, listener) {
      if (event === 'SIGHUP') throw Error('signal hook unavailable')
      return original.call(this, event, listener)
    }
    try {
      await assert.rejects(withLaneLaunchAdmission(() => 0, { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }) }), /signal hook unavailable/)
      assert.equal(existsSync(lockPath), false, 'signal registration failure must release admission claim')
      for (const event of events) assert.deepEqual(process.listeners(event), before.get(event))
    } finally {
      if (descriptor) Object.defineProperty(process, 'once', descriptor)
      else Reflect.deleteProperty(process, 'once')
      for (const event of events) for (const listener of process.listeners(event)) {
        if (!before.get(event).includes(listener)) process.removeListener(event, listener)
      }
    }
    console.log('signal registration failure: claim and partial handlers released')
  } else if (process.argv[2] === 'foreign-record') {
    await import('./fixtures/lane-admission-e2e.mjs')
  } else if (process.argv[2] === 'neutral-home') {
    const { laneLaunchAdmissionLockPath } = await import(new URL('bin/lib/host/lane-launch-admission.mjs', plugin))
    const before = laneLaunchAdmissionLockPath({ platform: 'linux', env: {} })
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    try {
      process.env.HOME = join(root, 'project-home')
      process.env.USERPROFILE = join(root, 'project-home')
      assert.equal(laneLaunchAdmissionLockPath({ platform: 'linux', env: {} }), before, 'project-local HOME must not split machine-wide admission')
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    console.log('neutral lock path: project HOME isolation does not split admission')
  } else if (process.argv[2] === 'cleanup') {
    const { withLaneLaunchAdmission } = await import(new URL('bin/lib/host/lane-launch-admission.mjs', plugin))
    const calls = []
    const messages = []
    const pid = 2147483600
    const options = { lockPath, counter: () => ({ state: 'ok', count: 0, pids: [] }),
      warn: (line) => messages.push(line), stopWorker: (worker) => { calls.push(worker); return { status: 'ended' } } }
    await assert.rejects(withLaneLaunchAdmission((lease) => {
      lease.trackWorker(pid, () => false)
      throw Error('launch broke')
    }, options), /launch broke/)
    assert.deepEqual(calls, [], 'never signal a worker whose recorded birth identity no longer matches')
    assert.ok(messages.some((line) => /identity changed or not measured/.test(line)), 'cleanup must refuse an unverified worker identity before attempting any signal')
    await assert.rejects(withLaneLaunchAdmission((lease) => {
      lease.trackWorker(pid, () => true)
      throw Error('launch broke')
    }, options), /launch broke/)
    assert.deepEqual(calls, [pid], 'stop the verified original worker on failure')
    console.log('worker cleanup: changed identity refused, verified identity stopped')
  } else if (process.argv[2] === 'entry-path') {
    const { main } = await import(new URL('bin/wt-lane.mjs', plugin))
    const previousArgv = process.argv
    const previousWrite = process.stdout.write
    let observed
    let code
    try {
      process.argv = [process.execPath, join(root, 'caller.mjs')]
      process.stdout.write = () => { observed = process.argv[1]; return true }
      code = await main({ argv: ['--help'] })
      assert.deepEqual(process.argv, [process.execPath, join(root, 'caller.mjs')])
    } finally { process.argv = previousArgv; process.stdout.write = previousWrite }
    assert.equal(code, 0)
    assert.equal(observed, fileURLToPath(new URL('bin/wt-lane.mjs', plugin)), 'an imported entry must use the launcher script identity, not its caller')
    console.log('imported entry: canonical launcher identity, argv restored')
  } else if (process.argv[2] !== 'concurrent') {
    const { main } = await import(new URL('bin/wt-lane.mjs', plugin))
    assert.equal(typeof main, 'function', 'wt-lane must expose its launch entry for injected admission')
    const messages = []
    const code = await main({ argv: ['--dir', root, '--model', 'openai/gpt-6.1-sol', '--brief', join(root, 'brief.md')], admissionOptions: {
      lockPath, counter: () => ({ state: 'ok', count: 16, pids: [] }), warn: (line) => messages.push(line),
    } })
    assert.equal(code, 1, 'a launch at 16 must be refused before worktree validation or worker spawn')
    assert.match(messages.join('\n'), /Refused: 16 lanes live, cap 16/)
    assert.deepEqual(readdirSync(root), [], 'a cap refusal must leave no worker artifacts or lock')
    const { laneHostDir } = await import(new URL('bin/lib/host/lane-host-dir.mjs', plugin))
    assert.equal(existsSync(laneHostDir(root)), false, 'a cap refusal must not create the real host-side run directory')
    console.log('T1: cap refusal, exit 1, no worker artifacts')
  } else {
    const { withLaneLaunchAdmission } = await import(new URL('bin/lib/host/lane-launch-admission.mjs', plugin))
    let visible = false
    const counter = () => ({ state: 'ok', count: visible ? 16 : 15, pids: visible ? [42] : [] })
    const launch = async (lease) => {
      await setImmediate()
      visible = true
      await lease.waitUntilVisible(() => 42)
      return 0
    }
    const options = { lockPath, counter, warn: () => {}, pollMs: 1 }
    const codes = await Promise.all([withLaneLaunchAdmission(launch, options), withLaneLaunchAdmission(launch, options)])
    assert.deepEqual(codes.sort(), [0, 1], 'concurrent admissions at 15 must admit exactly one lane')
    console.log('T2: exactly one admitted, one refused')
  }
} finally { rmSync(root, { recursive: true, force: true }) }
