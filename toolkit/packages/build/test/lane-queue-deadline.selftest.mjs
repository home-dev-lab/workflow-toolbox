import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { inspectProcess, supervisionPaths, writeJsonAtomic } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'
import { harness } from './fixtures/broker-deadline-harness.mjs'

const control = process.env.WT_LANE_CONTROL_MODULE ?? fileURLToPath(new URL('../../../../plugin/bin/wt-lane-control.mjs', import.meta.url))

function ownerRecord(h) {
  const env = { ...process.env, HOME: join(h.scratch, 'home'), WT_LANE_HOST_STATE: join(h.scratch, 'host'), WT_SUITE_LOCK_BROKER: undefined, WT_SUITE_LEASE: undefined, WT_LANE_SUPERVISION_SLOT: undefined }
  const previous = process.env.WT_LANE_HOST_STATE, userInfo = os.userInfo
  process.env.WT_LANE_HOST_STATE = env.WT_LANE_HOST_STATE
  os.userInfo = () => ({ ...userInfo(), homedir: env.HOME })
  let paths
  try { paths = supervisionPaths(h.root, '1-1', null) } finally {
    os.userInfo = userInfo
    if (previous === undefined) delete process.env.WT_LANE_HOST_STATE
    else process.env.WT_LANE_HOST_STATE = previous
  }
  const identity = inspectProcess(process.pid)
  writeJsonAtomic(paths.pointer, { runId: '1-1' })
  writeJsonAtomic(paths.record, { ...h.current(), owner: 'pilot', ownerToken: 'fixture-owner', workerPid: process.pid, childPid: process.pid, workerArgv: identity.argv, childArgv: identity.argv, workerStartTime: identity.startTime, childStartTime: identity.startTime, maxExtensions: h.opts.maxExtensions })
  return { env, paths }
}

function runControl(h, env, decision, seconds) {
  const argv = [control, '--dir', h.root, '--owner-token', 'fixture-owner', '--decision', decision, ...(seconds ? ['--extend', String(seconds)] : [])]
  const script = `import os from 'node:os'; import { pathToFileURL } from 'node:url'; os.userInfo = () => ({ homedir: process.env.HOME }); process.argv = [process.execPath, ...${JSON.stringify(argv)}]; await import(pathToFileURL(process.argv[1]).href)`
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' })
}

function pending(h, requestId, extra = {}) {
  const decision = { runId: '1-1', preemptive: true, requestId, decision: 'extend', extendSeconds: 2, ...extra }
  writeJsonAtomic(h.decisionFile, decision)
  return decision
}

test('preemptive: running control accepts extend and worker consumes it exactly once', async (t) => {
  const h = harness(t, { maxExtensions: 1 }), { env, paths } = ownerRecord(h)
  const result = runControl(h, env, 'extend', 10)
  assert.equal(result.status, 0, result.stderr)
  const decision = JSON.parse(fs.readFileSync(paths.decision, 'utf8'))
  writeJsonAtomic(h.decisionFile, decision)
  await h.tick(2000)
  assert.equal(h.current().extensionCount, 1)
  assert.equal(h.current().timeoutAt, new Date(Date.now() + 10_000).toISOString())
  writeJsonAtomic(h.decisionFile, decision)
  await h.tick(11_000)
  assert.equal(h.terminal[0]?.[0], 126)
})

test('preemptive: running abandon remains refused', (t) => {
  const h = harness(t), { env } = ownerRecord(h), result = runControl(h, env, 'abandon')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /no current decision point \(running\)/)
})

test('preemptive: ordinary owner extensions publish and journal their request identity', async (t) => {
  const h = harness(t, { maxExtensions: 1 })
  await h.tick(2000)
  const { env, paths } = ownerRecord(h), result = runControl(h, env, 'extend', 10)
  assert.equal(result.status, 0, result.stderr)
  const decision = JSON.parse(fs.readFileSync(paths.decision, 'utf8'))
  assert.equal(typeof decision.requestId, 'string', 'ordinary owner requests must carry an identity before worker consumption')
  assert.ok(decision.requestId.length > 0)
  writeJsonAtomic(h.decisionFile, decision)
  await h.tick(100)
  const events = h.journal.filter((event) => event.event === 'decision' && event.source === 'owner')
  assert.equal(events.length, 1)
  assert.equal(events[0].requestId, decision.requestId)
  assert.deepEqual(h.current().consumedExtensionIds, [decision.requestId])
})

for (const kind of ['stale-run', 'missing-id', 'wrong-decision', 'ceiling']) {
  test(`preemptive: ${kind} cannot extend`, async (t) => {
    const h = harness(t, { maxExtensions: kind === 'ceiling' ? 0 : 1 })
    pending(h, kind === 'missing-id' ? undefined : 'request', { ...(kind === 'stale-run' ? { runId: 'old' } : {}), ...(kind === 'wrong-decision' ? { decision: 'abandon' } : {}) })
    await h.tick(3000)
    assert.equal(h.terminal[0]?.[0], 126)
    assert.equal(h.current().extensionCount, 0)
  })
}

for (const duration of [100_000, undefined]) {
  test(`preemptive: duration ${duration} clamps to 86400`, async (t) => {
    const h = harness(t, { maxExtensions: 1 })
    h.opts.timeout = 100_000
    pending(h, 'clamp', { extendSeconds: duration })
    await h.tick(2000)
    assert.equal(h.current().timeoutAt, new Date(Date.now() + 86_400_000).toISOString())
  })
}

test('replay: A then B then A retains every consumed id', async (t) => {
  const h = harness(t, { maxExtensions: 4 })
  pending(h, 'A'); await h.tick(2000)
  pending(h, 'B'); await h.tick(2000)
  pending(h, 'A'); await h.tick(2000)
  assert.equal(h.current().extensionCount, 2)
  assert.deepEqual(h.current().consumedExtensionIds, ['A', 'B'])
  assert.equal(h.current().state, 'decision-needed')
})

test('replay: an ordinary owner extension preserves consumed history', async (t) => {
  const h = harness(t, { maxExtensions: 4 })
  pending(h, 'A'); await h.tick(4000)
  h.publish({ extendSeconds: 2 }); await h.tick(100)
  pending(h, 'A'); await h.tick(2000)
  assert.equal(h.current().extensionCount, 2)
})

test('publish: finishing A cannot unlink concurrently published B', async (t) => {
  const h = harness(t, { maxExtensions: 4 }), push = h.journal.push.bind(h.journal)
  pending(h, 'A')
  h.journal.push = (event) => { if (event.source === 'owner') pending(h, 'B'); return push(event) }
  await h.tick(2000)
  assert.equal(JSON.parse(fs.readFileSync(h.decisionFile, 'utf8')).requestId, 'B')
  await h.tick(2000)
  assert.equal(h.current().extensionCount, 2)
})

test('publish: existing claim recovers and cannot replay after consumption', async (t) => {
  const h = harness(t, { maxExtensions: 4 }), a = pending(h, 'A')
  fs.renameSync(h.decisionFile, `${h.decisionFile}.claimed`)
  pending(h, 'B'); await h.tick(2000)
  writeJsonAtomic(`${h.decisionFile}.claimed`, a)
  await h.tick(2000)
  assert.equal(h.current().extensionCount, 2)
  assert.deepEqual(h.current().consumedExtensionIds, ['A', 'B'])
})

test('publish: stale ordinary claim cannot starve a newer extension', async (t) => {
  const h = harness(t, { maxExtensions: 2 })
  h.publish({ timeoutAt: 'obsolete' }); await h.tick(2000)
  pending(h, 'newer'); await h.tick(1000)
  assert.equal(h.terminal.length, 0)
  assert.deepEqual(h.current().consumedExtensionIds, ['newer'])
})

test('publish: a rename sharing violation preserves the public request for retry', async (t) => {
  const h = harness(t, { maxExtensions: 1 }), rename = fs.renameSync
  pending(h, 'sharing')
  let denied = false
  t.mock.method(fs, 'renameSync', (from, to) => { if (from === h.decisionFile && !denied) { denied = true; throw Object.assign(new Error('sharing violation'), { code: 'EPERM' }) }; return rename(from, to) })
  syncBuiltinESMExports()
  await h.tick(2000)
  assert.equal(fs.existsSync(h.decisionFile), true)
  await h.tick(100)
  assert.deepEqual(h.current().consumedExtensionIds, ['sharing'])
})

test('budget: pending extension survives queue pause with its budget intact', async (t) => {
  const h = harness(t, { maxExtensions: 1 })
  h.queued(); pending(h, 'waiting')
  await h.tick(4000)
  assert.equal(h.current().extensionCount, 0)
  assert.equal(JSON.parse(fs.readFileSync(h.decisionFile, 'utf8')).requestId, 'waiting')
  h.evidence({ runId: '1-1', status: 'running', since: Date.now(), observedAt: Date.now() })
  await h.tick(2000)
  assert.deepEqual(h.current().consumedExtensionIds, ['waiting'])
})

test('budget: owner extend during queue admission preserves the protected budget', async (t) => {
  const h = harness(t, { maxExtensions: 1 })
  await h.tick(2000)
  h.queued(); h.publish({ requestId: 'ordinary-waiting', extendSeconds: 10 })
  await h.tick(500)
  assert.equal(h.current().extensionCount, 0)
  assert.equal(h.terminal.length, 0)
  assert.equal(fs.existsSync(`${h.decisionFile}.claimed`), true, 'normal queue deferral must preserve the ordinary owner request')
  h.evidence({ runId: '1-1', status: 'running', since: Date.now(), observedAt: Date.now() })
  await h.tick(100)
  assert.equal(h.current().extensionCount, 1)
  assert.deepEqual(h.current().consumedExtensionIds, ['ordinary-waiting'])
})

test('budget: admission during the atomic claim preserves the unconsumed extension', async (t) => {
  const h = harness(t, { maxExtensions: 1 }), rename = fs.renameSync
  pending(h, 'admitted')
  t.mock.method(fs, 'renameSync', (from, to) => {
    const result = rename(from, to)
    if (from === h.decisionFile) { h.ticket(); h.queued() }
    return result
  })
  syncBuiltinESMExports()
  await h.tick(2000)
  assert.equal(h.current().extensionCount, 0, 'admission during claim must not spend the nonqueued owner budget')
  assert.doesNotMatch(fs.readFileSync(h.log, 'utf8'), /LANE_DECISION_NEEDED/, 'admission during claim must defer the timeout decision')
  assert.equal(fs.existsSync(`${h.decisionFile}.claimed`), true)
  fs.rmSync(join(h.lock, 'queue.d'), { recursive: true })
  h.evidence({ runId: '1-1', status: 'running', since: Date.now(), observedAt: Date.now() })
  await h.tick(2000)
  assert.deepEqual(h.current().consumedExtensionIds, ['admitted'])
})

test('idle: genuine silence still abandons at timeout plus grace', async (t) => {
  const h = harness(t)
  await h.tick(2000)
  assert.equal(h.current().defaultDecision, 'abandon')
  await h.tick(999)
  assert.equal(h.terminal.length, 0)
  await h.tick(1)
  assert.deepEqual(h.terminal[0][1].receiptLines, ['TERMINATION=timeout'])
})

test('idle: zero grace retains the next-turn termination timing', async (t) => {
  const h = harness(t, { decisionGrace: 0 })
  await h.tick(2001)
  assert.equal(h.terminal[0]?.[0], 126, 'zero grace must not acquire a new 100-ms decision window')
  assert.match(fs.readFileSync(h.log, 'utf8'), /^LANE_DECISION_NEEDED /m, 'zero grace must retain decision-needed receipts')
})

test('idle: fractional timeout budgets are not truncated by ISO rendering', async (t) => {
  const h = harness(t, { timeout: 0.0015 })
  await h.tick(1)
  assert.equal(h.current().state, 'running', 'a rendered millisecond must not decide a fractional deadline early')
  await h.tick(1)
  assert.equal(h.current().state, 'decision-needed')
})

test('idle: positive broker evidence protects opt-in idle stop', async (t) => {
  const h = harness(t, { idleTimeout: 1 })
  h.queued()
  await h.tick(4000)
  assert.equal(h.terminal.length, 0)
})

test('idle: absent broker evidence does not protect opt-in idle stop', async (t) => {
  const h = harness(t, { idleTimeout: 1 })
  await h.tick(1500)
  assert.deepEqual(h.terminal[0]?.[1].receiptLines, ['TERMINATION=idle'])
})

test('total: state read failure at deadline retries after recovery', async (t) => {
  const h = harness(t)
  h.failRead(new Error('state temporarily unavailable'))
  await h.tick(3000)
  h.failRead(null)
  await h.tick(2000)
  assert.equal(h.terminal[0]?.[0], 126)
})

test('total: failed durable consumption cannot advance the launcher state closure', async (t) => {
  const file = process.env.WT_LANE_LAUNCHER_MODULE ?? new URL('../../../../plugin/bin/wt-lane.mjs', import.meta.url)
  const body = /const writeState = \(extra\) => \{([\s\S]*?)\n  \}/.exec(fs.readFileSync(file, 'utf8'))?.[1]
  assert.ok(body, 'exercise the installed launcher state writer')
  let denied = false
  const factory = new Function('consentModules', 'stateFile', 'currentState', `return { current: () => currentState, writeState: (extra) => {${body}\n} }`)
  const stateWriterFactory = (initial) => factory({ writeJsonAtomic(_file, next) {
    if (next.consumedExtensionIds?.includes('durable') && !denied) { denied = true; throw new Error('fixture storage publication failed') }
  } }, 'fixture-state', initial)
  const h = harness(t, { maxExtensions: 1, stateWriterFactory })
  pending(h, 'durable')
  await h.tick(2000)
  assert.equal(h.current().extensionCount, 0, 'failed publication must leave consumption uncommitted for retry')
  await h.tick(100)
  assert.equal(h.current().extensionCount, 1)
  assert.deepEqual(h.current().consumedExtensionIds, ['durable'])
  assert.equal(h.current().timeoutAt, new Date(Date.now() + 2000).toISOString())
})

for (const idleTimeout of [0, 1]) test(`total: ${idleTimeout ? 'idle' : 'timeout'} termination clearing the deadline before a write failure stays stopped`, async (t) => {
  const h = harness(t, { idleTimeout })
  let attempts = 0
  h.opts.terminalHandler = (...args) => {
    attempts += 1
    h.terminal.push(args)
    h.clear()
    throw new Error('fixture terminal state publication failed after clear')
  }
  await h.tick(idleTimeout ? 1000 : 3000)
  await h.tick(3000)
  assert.equal(h.terminal[0]?.[0], 126)
  assert.equal(attempts, 1, 'post-termination storage failure must not revive supervision')
})
