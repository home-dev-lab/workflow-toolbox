import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { harness } from './fixtures/broker-deadline-harness.mjs'
import { fork } from 'node:child_process'
import net from 'node:net'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { acquireSuiteLock, releaseSuiteLock } from '../../../../plugin/bin/lib/suite-lock.mjs'
import { queryBrokerQueue } from '../../../../plugin/bin/lib/host/lane-suite-queue.mjs'

const base = new URL('../../../../plugin/bin/lib/host/', import.meta.url)
const { createSuiteLockBroker } = await import(process.env.WT_LANE_BROKER_MODULE ?? new URL('lane-suite-lock-broker.mjs', base))

test('authority: partial host snapshots cannot kill a broker-confirmed waiter', async (t) => {
  const h = harness(t)
  h.modules.hostAdapter.readProcessSnapshot = () => ({ processes: [{ pid: 4, ppid: 2 }], unknownPids: [6] })
  h.ticket(); h.queued()
  await h.tick(4000)
  assert.equal(h.terminal.length, 0, 'broker authority must survive an incomplete host snapshot')
  assert.equal(h.current().state, 'running')
  assert.doesNotMatch(fs.readFileSync(h.log, 'utf8'), /LANE_DECISION_NEEDED/)
})

test('authority: a live stale ticket cannot protect a wedged acquisition', async (t) => {
  const h = harness(t)
  h.ticket()
  h.evidence({ runId: '1-1', status: 'queued', since: 1, observedAt: Date.now() - 5001 })
  await h.tick(3000)
  assert.equal(h.terminal[0]?.[0], 126, 'stale acquisition evidence must leave the timeout running')
})

test('authority: intermittent malformed global tickets grant zero allowance', async (t) => {
  const h = harness(t)
  await h.tick(2000)
  h.ticket('{')
  await h.tick(1000)
  assert.equal(h.terminal[0]?.[0], 126, 'unrelated uncertainty must never renew the timeout')
})

test('total: claim removal failure leaves a rearmed callback', async (t) => {
  const h = harness(t)
  h.publish({ runId: 'old', preemptive: true, requestId: 'stale' })
  const remove = fs.rmSync
  t.mock.method(fs, 'rmSync', (file, ...args) => { if (file === `${h.decisionFile}.claimed`) throw Object.assign(new Error('fixture removal denied'), { code: 'EPERM' }); return remove(file, ...args) })
  syncBuiltinESMExports()
  await assert.doesNotReject(h.tick(3000), 'claim removal errors must not escape the deadline callback')
  t.mock.restoreAll(); syncBuiltinESMExports()
  await h.tick(1500)
  assert.ok(h.terminal.length || h.current().state === 'decision-needed', 'deadline must still make progress after removal recovers')
})

test('total: failed state publication leaves a live retry timer', async (t) => {
  const h = harness(t)
  h.ticket(); h.queued()
  h.fail(() => { throw new Error('fixture state write failed') })
  await assert.doesNotReject(h.tick(2500), 'state write failure must not escape or disarm the deadline')
  h.fail(null); h.evidence(null)
  await h.tick(4000)
  assert.equal(h.terminal[0]?.[0], 126, 'state write recovery must retain a bounded deadline')
})

for (const decision of ['abandon', 'extend']) {
  test(`late: owner ${decision} immediately before grace beats the default`, async (t) => {
    const h = harness(t, { maxExtensions: 2, idleWindow: 100, withoutOwnerPoll: true })
    await h.tick(2999)
    h.publish({ decision, extendSeconds: 10 })
    await h.tick(1)
    if (decision === 'abandon') assert.equal(h.terminal[0]?.[1].terminal.decisionSource, 'owner', 'late explicit abandon must beat the grace default')
    else assert.equal(h.current().timeoutAt, new Date(Date.now() + 10_000).toISOString(), 'late requested duration must beat the grace default')
  })
}

test('claim: transient post-rename read preserves the accepted request', async (t) => {
  const h = harness(t, { maxExtensions: 1 })
  h.publish({ preemptive: true, requestId: 'retry', extendSeconds: 10 })
  const read = fs.readFileSync
  let denied = false
  t.mock.method(fs, 'readFileSync', (file, ...args) => { if (file === `${h.decisionFile}.claimed` && fs.existsSync(file) && !denied) { denied = true; throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' }) }; return read(file, ...args) })
  syncBuiltinESMExports()
  await h.tick(2000)
  assert.ok(fs.existsSync(`${h.decisionFile}.claimed`) || h.current().consumedExtensionIds?.includes('retry'), 'a transient read must retain or consume the exact claimed request')
  await h.tick(1100)
  assert.equal(h.current().extensionCount, 1)
})

test('pause: queueing preserves only the remaining work budget', async (t) => {
  const h = harness(t)
  await h.tick(1000)
  h.ticket(); h.queued()
  await h.tick(5000)
  fs.rmSync(join(h.lock, 'queue.d'), { recursive: true })
  h.evidence({ runId: '1-1', status: 'running', since: Date.now(), observedAt: Date.now(), queuedMs: 5000 })
  await h.tick(999)
  assert.equal(h.current().state, 'running', 'resumed budget must not expire early')
  await h.tick(1)
  assert.equal(h.current().state, 'decision-needed', 'queue release must not grant a fresh full timeout')
})

for (const kind of ['grant', 'overlap']) {
  test(`aggregate: ${kind} invalidates a still-fresh waiting record`, async (t) => {
    const h = harness(t), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock, WT_SUITE_LOCK_STATIC_LANE: '0' } })
    t.after(() => { broker.releaseAll(); broker.close() })
    const waiting = broker.trackQueueRequest()
    waiting.waiting()
    assert.equal(broker.queueState('1-1').status, 'queued')
    const holding = kind === 'grant' ? waiting : broker.trackQueueRequest()
    holding.holding()
    h.ticket()
    h.evidence(() => broker.queueState('1-1'))
    await h.tick(3000)
    assert.equal(h.terminal[0]?.[0], 126, 'a holding or acquiring request must override all waiting records')
  })
}

test('renewal: acquisition progress alone refreshes broker evidence', async (t) => {
  const h = harness(t), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => { broker.releaseAll(); broker.close() })
  broker.trackQueueRequest().waiting()
  h.ticket(); h.evidence(() => broker.queueState('1-1'))
  await h.tick(5001)
  assert.notEqual(broker.queueState('1-1').status, 'queued', 'broker queries cannot renew acquisition evidence')
  await h.tick(3000)
  assert.equal(h.terminal[0]?.[0], 126, 'a wedged acquisition must expire even if the broker still answers queries')
})

for (const invalid of [null, new Error('unreadable'), { runId: 'foreign', status: 'queued', since: 1, observedAt: 100_000 }, { runId: '1-1', status: 'queued', observedAt: 100_000 }]) {
  test(`evidence: ${JSON.stringify(invalid)} leaves the clock running`, async (t) => {
    const h = harness(t)
    h.ticket(); h.evidence(invalid)
    await h.tick(3000)
    assert.equal(h.terminal[0]?.[0], 126, 'missing, foreign, unreadable or malformed authority grants zero allowance')
  })
}

test('pause: acquisition renewals preserve accumulated queue time exactly', async (t) => {
  const h = harness(t), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => { broker.releaseAll(); broker.close() })
  const request = broker.trackQueueRequest()
  request.waiting()
  h.evidence(() => broker.queueState('1-1'))
  for (let n = 0; n < 10; n++) {
    await h.tick(1000)
    request.waiting()
  }
  request.holding()
  await h.tick(1999)
  assert.equal(h.current().state, 'running')
  await h.tick(1)
  assert.equal(h.current().state, 'decision-needed', 'renewals must neither spend nor refill the work budget')
})

test('pause: renewed queue evidence survives a wall-clock rollback without spending budget', async (t) => {
  const h = harness(t, { monotonic: true }), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => { broker.releaseAll(); broker.close() })
  const request = broker.trackQueueRequest()
  request.waiting()
  h.evidence(() => broker.queueState('1-1'))
  const wallNow = Date.now
  for (let n = 0; n < 40; n++) {
    if (n === 10) t.mock.method(Date, 'now', () => wallNow() - 3_600_000)
    request.waiting()
    await h.tick(100)
  }
  assert.equal(h.terminal.length, 0, 'a continuously renewed waiter must survive wall-clock rollback')
  assert.equal(h.current().state, 'running', 'queue renewal must preserve the entire remaining work budget')
  request.holding()
  await h.tick(1999)
  assert.equal(h.current().state, 'running', 'rollback must not spend any queued work budget')
  await h.tick(1)
  assert.equal(h.current().state, 'decision-needed', 'rollback must not refill the resumed work budget')
})

test('renewal: rollback cannot keep an unrenewed acquisition fresh', async (t) => {
  const h = harness(t, { monotonic: true }), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => { broker.releaseAll(); broker.close() })
  broker.trackQueueRequest().waiting()
  await h.tick(1000)
  const wallNow = Date.now
  t.mock.method(Date, 'now', () => wallNow() - 3_600_000)
  await h.tick(4001)
  assert.equal(broker.queueState('1-1').status, 'running', 'renewal freshness must expire after 5000 monotonic milliseconds despite rollback')
})

for (const failure of [false, true]) test(`late: queue admission during ${failure ? 'throwing' : 'normal'} decision reads prevents abandonment`, async (t) => {
  const h = harness(t), read = fs.readFileSync
  await h.tick(2999)
  let admitted = false
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (!admitted && file === `${h.decisionFile}.claimed`) {
      admitted = true
      h.queued()
      if (failure) throw Object.assign(new Error('fixture decision read denied after admission'), { code: 'EACCES' })
    }
    return read(file, ...args)
  })
  syncBuiltinESMExports()
  await h.tick(1)
  assert.equal(admitted, true, 'admit after the tick snapshot and before the grace decision')
  assert.equal(h.terminal.length, 0, 'a fresh pre-abandonment queue read must protect admission during decision checks')
  await h.tick(1000)
  assert.equal(h.terminal.length, 0)
  h.evidence(null)
  await h.tick(100)
  assert.equal(h.terminal.length, 1, 'queue revalidation must not disable the expired unqueued deadline')
})

test('pause: failed queue-entry publication retries on the next tick', async (t) => {
  const h = harness(t)
  h.writeState({ unattendedMaxSeconds: 3, queueWait: null })
  let attempts = 0
  h.fail((extra) => {
    if (extra.unattendedMaxSeconds === null && ++attempts === 1) throw new Error('fixture queue-entry write failed once')
  })
  h.queued()
  await h.tick(100)
  assert.equal(h.current().unattendedMaxSeconds, 3, 'the first queue-entry write really failed')
  await h.tick(100)
  assert.equal(h.current().unattendedMaxSeconds, null, 'the next tick must retry the failed queue-entry publication')
  assert.equal(h.current().queueWait.status, 'queued')
  assert.equal(attempts, 2)
  assert.equal(h.journal.filter((event) => event.source === 'suite-lock-queue').length, 1)
  assert.match(fs.readFileSync(h.log, 'utf8'), /LANE_BOUND .*unattendedMaxSeconds=queue-dependent/)
})

for (const phase of ['acquiring', 'releasing']) {
  test(`aggregate: ${phase} excludes simultaneous waiting requests`, async (t) => {
    const h = harness(t), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
    t.after(() => { broker.releaseAll(); broker.close() })
    broker.trackQueueRequest().waiting()
    const busy = broker.trackQueueRequest()
    if (phase === 'releasing') busy.releasing()
    h.evidence(() => broker.queueState('1-1'))
    await h.tick(3000)
    assert.equal(h.terminal[0]?.[0], 126)
  })
}

test('aggregate: a late acquisition callback cannot turn holding back into waiting', async (t) => {
  const h = harness(t), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => { broker.releaseAll(); broker.close() })
  const request = broker.trackQueueRequest()
  request.waiting(); request.holding(); request.waiting()
  h.evidence(() => broker.queueState('1-1'))
  await h.tick(3000)
  assert.equal(h.terminal[0]?.[0], 126, 'a late waiting callback must never overwrite a grant')
})

test('native-aggregate: provisional mutex ownership never pauses through a publication failure', { skip: process.platform === 'win32' && 'the installed sandbox broker uses Unix sockets' }, async (t) => {
  let broker, client
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports()
    client?.destroy(); broker?.releaseAll()
    if (broker?.listening) await new Promise((resolve) => broker.close(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  })
  const h = harness(t, { realTime: true, timeout: 0.2, decisionGrace: 0, idleWindow: 0.05 })
  broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock, WT_SUITE_LOCK_STATIC_LANE: '0' } })
  const socket = join(h.root, 'broker.sock'), lockDir = join(h.lock, 'lock.d')
  broker.listen(socket); await once(broker, 'listening')
  const write = fs.writeFileSync, remove = fs.rmSync
  let provisional = false
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (file === join(lockDir, 'holder.json')) { provisional = true; throw Object.assign(new Error('fixture publication denied'), { code: 'EPERM' }) }
    return write(file, ...args)
  })
  t.mock.method(fs, 'rmSync', (file, ...args) => { if (file === lockDir) throw Object.assign(new Error('fixture cleanup denied'), { code: 'EPERM' }); return remove(file, ...args) })
  syncBuiltinESMExports()
  h.evidence(() => broker.queueState('1-1'))
  client = net.createConnection(socket)
  client.on('data', () => {})
  await once(client, 'connect')
  client.write(`${JSON.stringify({ argv: ['fixture'], waitS: 1 })}\n`)
  await until(() => provisional)
  assert.equal(h.terminal.length, 0)
  await h.tick(450)
  assert.equal(provisional, true, 'the real acquisition must have taken its private provisional mutex')
  assert.equal(h.terminal[0]?.[0], 126, 'a provisional owner must not masquerade as a queued request')
})

test('renewal: the freshness boundary is inclusive at 5000 ms only', (t) => {
  const h = harness(t), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => { broker.releaseAll(); broker.close() })
  broker.trackQueueRequest().waiting()
  t.mock.timers.tick(5000)
  assert.equal(broker.queueState('1-1').status, 'queued')
  t.mock.timers.tick(1)
  assert.equal(broker.queueState('1-1').status, 'running')
  assert.equal(broker.queueState('foreign'), null)
})

test('renewal: resumed acquisition cannot backdate evidence over an unobserved stale gap', async (t) => {
  const h = harness(t), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => { broker.releaseAll(); broker.close() })
  const request = broker.trackQueueRequest()
  request.waiting()
  await h.tick(1000)
  t.mock.timers.setTime(106_000)
  request.waiting()
  h.evidence(() => broker.queueState('1-1'))
  await h.tick(100)
  request.holding()
  await h.tick(999)
  assert.equal(h.current().state, 'running', 'confirmed fresh queue time must be refunded despite the missing observation')
  await h.tick(1)
  assert.equal(h.current().state, 'decision-needed', 'a fresh renewal cannot refund the preceding stale-evidence interval')
})

async function until(predicate) {
  const end = performance.now() + 10_000
  while (!predicate()) {
    assert.ok(performance.now() < end, 'private broker did not reach expected state')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

for (const failure of [false, true]) test(`verdict: admission after the last snapshot cannot authorize a queued kill (${failure ? 'fallback' : 'normal'})`, async (t) => {
  const h = harness(t), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => broker.close())
  await h.tick(2999)
  let reads = 0, admitted = false
  const admit = () => { if (!admitted) { admitted = true; broker.trackQueueRequest().waiting() } }
  h.authority(() => { admit(); return broker.decideTimeout('1-1') })
  h.evidence(() => {
    const snapshot = broker.queueState('1-1')
    if (++reads === 2) admit()
    return snapshot
  })
  if (failure) h.failRead(new Error('fixture owner read unavailable'))
  await h.tick(1)
  assert.equal(admitted, true, 'admission must occur after the last observation and before the timeout verdict')
  assert.equal(h.terminal.length, 0, 'broker admission after a running snapshot must veto timeout termination')
})

for (const phase of ['waiting', 'holding', 'acquiring', 'releasing']) test(`verdict: ${phase} remains protected despite unavailable observations`, async (t) => {
  const h = harness(t), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => broker.close())
  const request = broker.trackQueueRequest()
  if (phase !== 'acquiring') request[phase]()
  h.authority(() => broker.decideTimeout('1-1'))
  h.evidence(() => broker.queueState('1-1'))
  await h.tick(100)
  h.evidence(new Error('fixture observation unavailable'))
  for (let n = 0; n < 90; n++) { if (phase === 'waiting') request.waiting(); await h.tick(100) }
  assert.equal(h.terminal.length, 0, 'an admitted request must veto termination even after renewal expiry')
  request.done()
  h.evidence(() => broker.queueState('1-1'))
  if (phase === 'waiting') {
    await h.tick(1999)
    assert.equal(h.current().state, 'running', 'confirmed waiting must preserve the full budget after unavailable observations')
    await h.tick(1)
    assert.equal(h.current().state, 'decision-needed')
    await h.tick(1000)
  } else await h.tick(100)
  assert.equal(h.terminal.length, 1, 'an expired run with no admitted request must terminate')
  assert.throws(() => broker.trackQueueRequest(), /timeout/, 'termination authorization must fence later admission')
})

test('verdict: queue-dependent hard bound is not a finite expired deadline', async (t) => {
  const { laneHardBoundAt } = await import(process.env.WT_LANE_SUPERVISOR_MODULE ?? new URL('lane-supervisor-core.mjs', new URL('../', base)))
  const h = harness(t)
  h.writeState({ timeoutSeconds: 2, decisionGraceSeconds: 1, maxExtensions: 0, unattendedMaxSeconds: 3 })
  h.queued()
  await h.tick(10000)
  assert.equal(laneHardBoundAt(h.current()), null, 'a queue-dependent bound cannot report a finite overdue deadline')
  h.evidence(null)
  await h.tick(100)
  assert.ok(Number.isFinite(laneHardBoundAt(h.current())), 'leaving the queue must restore a finite bound')
})

test('verdict: queue decision journal retries after a committed pause', async (t) => {
  const h = harness(t), push = h.journal.push.bind(h.journal)
  let attempts = 0
  h.journal.push = (event) => {
    if (event.source === 'suite-lock-queue' && ++attempts === 1) throw new Error('fixture journal failed once')
    return push(event)
  }
  h.queued()
  await h.tick(300)
  assert.equal(h.journal.filter((event) => event.source === 'suite-lock-queue').length, 1, 'committed queue entry must retry its failed journal exactly once')
  assert.equal(attempts, 2)
})

test('transport: downstream attachment and real worker use private broker IPC', async (t) => {
  const file = process.env.WT_LANE_FENCE_MODULE ?? new URL('opencode-skill-fence.mjs', new URL('../', base))
  const body = /function finishSpawnSetup\(child, sandbox, usageOptions\) \{([\s\S]*?)\n\}/.exec(fs.readFileSync(file, 'utf8'))?.[1]
  assert.ok(body)
  const relay = new EventEmitter(), messages = []
  relay.connected = true
  relay.send = (message) => {
    messages.push(message)
    relay.emit('message', { requestId: message.requestId, queue: { runId: '1-1', status: 'running', since: Date.now(), observedAt: Date.now() }, verdict: { terminate: false, reason: 'admitted' } })
  }
  const child = new EventEmitter()
  new Function('child', 'sandbox', 'usageOptions', 'finishOpencodeUsage', body)(child, { kind: 'fixture', suiteBroker: relay }, {}, () => {})
  assert.equal(child.laneSandbox?.suiteBroker, relay, 'downstream child must retain the private IPC authority')
  const h = harness(t, { child })
  await h.tick(3100)
  assert.ok(messages.some((message) => message.queueRunId === '1-1'), 'real worker must query its attached private IPC relay')
  assert.ok(messages.some((message) => message.timeoutRunId === '1-1'), 'real worker must request a serialized timeout verdict')
  assert.equal(h.terminal.length, 0)
})

test('verdict: unanswered broker protects possible leases; absent broker grants no allowance', async (t) => {
  const relay = new EventEmitter()
  relay.connected = true
  relay.send = () => {}
  const h = harness(t, { child: { pid: 4, laneSandbox: { suiteBroker: relay } } })
  await h.tick(5000)
  assert.equal(h.terminal.length, 0, 'an unanswered broker cannot prove the absence of a lease')
  relay.connected = false
  await h.tick(500)
  assert.equal(h.terminal.length, 0, 'a disconnected broker with unknown lease ownership must fail protected')
  relay.exitCode = 0
  await h.tick(100)
  assert.equal(h.terminal.length, 1, 'a confirmed exited broker has no live admitted lease and must not hide an idle lane')
})

test('verdict: a failed signal cancels its admission fence before work can resume', async (t) => {
  const relay = new EventEmitter()
  relay.connected = true
  let broker, failed = false, failedQueueReads = 0
  relay.send = (message) => {
    if (message.cancelTimeoutRunId) {
      const verdict = broker.cancelTimeout('1-1')
      setTimeout(() => relay.emit('message', { requestId: message.requestId, verdict }), 300)
      return
    }
    if (message.queueRunId && failed) failedQueueReads++
    relay.emit('message', { requestId: message.requestId, queue: message.queueRunId ? broker.queueState('1-1') : null, verdict: message.timeoutRunId ? broker.decideTimeout('1-1') : null })
  }
  const h = harness(t, { child: { pid: 4, laneSandbox: { suiteBroker: relay } }, terminalHandler: () => { failed = true; throw new Error('fixture signal unavailable') } })
  broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => broker.close())
  await h.tick(3750)
  assert.equal(failed, true)
  assert.equal(failedQueueReads, 0, 'a retained fence must be retried before starting another queue observation')
  assert.doesNotThrow(() => broker.trackQueueRequest().waiting(), 'a failed signal must cancel its fence before resumed work or an owner extension')
  h.opts.terminalHandler = (...args) => h.terminal.push(args)
  await h.tick(500)
  assert.equal(h.terminal.length, 0, 'a retry must ask the broker again after cancelling its previous fence')
})

function serialReplyFixture(t) {
  const relay = new EventEmitter(), pending = new Map(), signals = []
  let h, peak = 0, broker
  relay.connected = true
  relay.send = (message) => {
    const kind = message.queueRunId ? 'queue' : message.timeoutRunId ? 'timeout' : 'cancel'
    const reply = { requestId: message.requestId, queue: kind === 'queue' ? broker.queueState('1-1') : null, verdict: kind === 'timeout' ? broker.decideTimeout('1-1') : kind === 'cancel' ? broker.cancelTimeout('1-1') : null }
    if (kind !== 'queue' || fs.existsSync(`${h.decisionFile}.claimed`)) {
      pending.set(kind, reply); peak = Math.max(peak, pending.size)
    } else relay.emit('message', reply)
  }
  h = harness(t, { maxExtensions: 1, idleTimeout: 2.05, idleWindow: 0.1, child: { pid: 4, laneSandbox: { suiteBroker: relay } }, terminalHandler: () => {
    let fenced = false
    try { broker.trackQueueRequest().done() } catch { fenced = true }
    signals.push({ fenced, extensions: h.current().extensionCount })
  } })
  h.modules.hostAdapter.readProcessSnapshot = () => ({ processes: [{ pid: 4, ppid: 2, cpuTicks: 0 }] })
  broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => broker.close())
  return { h, signals, peak: () => peak, pending, deliver: (kind) => { const reply = pending.get(kind); pending.delete(kind); relay.emit('message', reply) } }
}

const replyOrders = [['queue', 'timeout', 'cancel'], ['queue', 'cancel', 'timeout'], ['timeout', 'queue', 'cancel'], ['timeout', 'cancel', 'queue'], ['cancel', 'queue', 'timeout'], ['cancel', 'timeout', 'queue']]
for (const order of replyOrders) test(`verdict: serial idle and extension replies ${order.join('-')}`, async (t) => {
  const f = serialReplyFixture(t)
  f.h.publish({ requestId: 'serial-owner', preemptive: true, extendSeconds: 10 })
  await f.h.tick(2075)
  assert.ok(f.pending.has('queue'), 'owner extension must be waiting for its queue reply when idle requests a stop')
  for (let pass = 0; pass < 3; pass++) for (const kind of order) {
    if (f.pending.has(kind)) f.deliver(kind)
    for (let n = 0; n < 32; n++) await Promise.resolve()
  }
  assert.ok(f.signals.every((signal) => signal.fenced && !signal.extensions), 'a lane must never be signalled under a cancelled admission fence or after committing this extension')
  assert.equal(f.peak(), 1, 'idle callbacks must not start broker IPC beside an in-flight tick')
  assert.ok(f.signals.length === 1 || f.h.current().extensionCount === 1, 'the serial path must make one decision')
})

test('pause: delayed queue replies credit cumulative time rather than receipt intervals', async (t) => {
  const relay = new EventEmitter()
  relay.connected = true
  const h = harness(t, { child: { pid: 4, laneSandbox: { suiteBroker: relay } } })
  relay.send = (message) => {
    const elapsed = Date.now() - 100_000
    const reply = { requestId: message.requestId, queue: { runId: '1-1', status: elapsed < 400 ? 'queued' : 'running', since: elapsed < 400 ? 100_000 : 100_400, observedAt: Date.now(), queuedMs: Math.min(elapsed, 400) } }
    if (elapsed === 100) setTimeout(() => relay.emit('message', reply), 200)
    else relay.emit('message', reply)
  }
  await h.tick(400)
  assert.equal(h.current().remainingTimeoutMs, 2000, 'unequal reply latency must preserve all 400 ms of confirmed queue time')
  await h.tick(1999)
  assert.equal(h.current().state, 'running')
  await h.tick(1)
  assert.equal(h.current().state, 'decision-needed', 'cumulative credit must not refill the budget')
})

test('pause: a missing cumulative counter cannot grant wall-clock credit', async (t) => {
  const h = harness(t)
  h.evidence(() => ({ runId: '1-1', status: 'queued', since: 100_000, observedAt: Date.now() }))
  await h.tick(400)
  h.evidence({ runId: '1-1', status: 'running', since: Date.now(), observedAt: Date.now(), queuedMs: 0 })
  await h.tick(100)
  assert.equal(h.current().remainingTimeoutMs, 1500, 'only the broker cumulative counter may refund queue time')
})

for (const exit of [{ exitCode: 0 }, { signalCode: 'SIGTERM' }]) test(`verdict: exited broker cancellation commits owner extension on first attempt (${JSON.stringify(exit)})`, async (t) => {
  const relay = Object.assign(new EventEmitter(), { connected: false, ...exit })
  const h = harness(t, { maxExtensions: 1, child: { pid: 4, laneSandbox: { suiteBroker: relay } } })
  await h.tick(2999)
  h.publish({ requestId: 'exited-owner', extendSeconds: 10 })
  await h.tick(1)
  assert.equal(h.current().extensionCount, 1, 'a confirmed exited broker has no admission fence and must accept the first owner extension attempt')
  assert.equal(h.terminal.length, 0)
  assert.equal(fs.existsSync(`${h.decisionFile}.claimed`), false)
})

test('verdict: refused cancellation cannot suppress an authorized grace default', async (t) => {
  const relay = new EventEmitter()
  const h = harness(t, { maxExtensions: 1, child: { pid: 4, laneSandbox: { suiteBroker: relay } } })
  servePrivateRelay(t, h, relay)
  const send = relay.send
  relay.send = (message) => message.cancelTimeoutRunId ? relay.emit('message', { requestId: message.requestId, verdict: { cancelled: false } }) : send(message)
  await h.tick(2999)
  h.publish({ requestId: 'refused-owner', extendSeconds: 10 })
  await h.tick(1)
  assert.equal(h.terminal.length, 1, 'a refused extension must allow an authorized abandon at the same expired grace deadline')
  assert.equal(h.current().extensionCount, 0)
})

test('verdict: repeated idle callbacks share one in-flight broker decision', async (t) => {
  const relay = new EventEmitter()
  relay.connected = true
  let pending = 0, peak = 0
  relay.send = (message) => {
    if (message.timeoutRunId) {
      peak = Math.max(peak, ++pending)
      setTimeout(() => { pending--; relay.emit('message', { requestId: message.requestId, verdict: { terminate: true } }) }, 150)
    } else relay.emit('message', { requestId: message.requestId, queue: { runId: '1-1', status: 'running', since: Date.now(), observedAt: Date.now() } })
  }
  const h = harness(t, { child: { pid: 4, laneSandbox: { suiteBroker: relay } }, idleTimeout: 0.2, idleWindow: 0.1 })
  h.modules.hostAdapter.readProcessSnapshot = () => ({ processes: [{ pid: 4, ppid: 2, cpuTicks: 0 }] })
  await h.tick(3500)
  assert.equal(peak, 1, 'idle and deadline callbacks must serialize broker termination reservations')
  assert.equal(h.terminal.length, 1)
})

test('verdict: grant after protected grace keeps the published hard bound queue-dependent', async (t) => {
  const { laneHardBoundAt } = await import(new URL('lane-supervisor-core.mjs', new URL('../', base)))
  const h = harness(t), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => broker.close())
  h.writeState({ timeoutSeconds: 2, decisionGraceSeconds: 1, maxExtensions: 0, unattendedMaxSeconds: 3 })
  await h.tick(2999)
  const request = broker.trackQueueRequest()
  request.waiting()
  h.evidence(() => broker.queueState('1-1'))
  h.authority(() => broker.decideTimeout('1-1'))
  await h.tick(1)
  request.holding()
  await h.tick(100)
  assert.equal(h.terminal.length, 0)
  assert.equal(laneHardBoundAt(h.current()), null, 'a granted request must retain the broker-dependent bound after queue pause ends')
})

function servePrivateRelay(t, h, relay, deliver = () => true) {
  const broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => broker.close())
  relay.connected = true
  relay.send = (message) => {
    const queue = message.queueRunId ? broker.queueState('1-1') : null
    const verdict = message.timeoutRunId ? broker.decideTimeout('1-1') : message.cancelTimeoutRunId ? broker.cancelTimeout('1-1') : null
    if (deliver(message, verdict)) relay.emit('message', { requestId: message.requestId, queue, verdict })
  }
  return broker
}

for (const preemptive of [false, true]) test(`verdict: lost timeout reply cannot fence an accepted ${preemptive ? 'preemptive' : 'grace'} extension`, async (t) => {
  const relay = new EventEmitter()
  const h = harness(t, { maxExtensions: 1, child: { pid: 4, laneSandbox: { suiteBroker: relay } } })
  const broker = servePrivateRelay(t, h, relay, (message) => !message.timeoutRunId)
  await h.tick(3250)
  assert.throws(() => broker.trackQueueRequest(), /timeout authorized/, 'the lost reply must leave a real broker fence')
  h.publish({ requestId: 'resume-after-lost-verdict', preemptive, extendSeconds: 10 })
  await h.tick(100)
  assert.equal(h.current().state, 'running')
  assert.equal(h.current().extensionCount, 1)
  assert.doesNotThrow(() => broker.trackQueueRequest().waiting(), 'an accepted owner extension must cancel even an unacknowledged timeout fence')
  assert.equal(h.terminal.length, 0)
})

test('verdict: lost cancellation acknowledgement preserves the owner extension before fence recovery', async (t) => {
  const relay = new EventEmitter()
  const h = harness(t, { maxExtensions: 1, child: { pid: 4, laneSandbox: { suiteBroker: relay } }, terminalHandler: () => { throw new Error('fixture signal failed') } })
  let acknowledge = false
  const broker = servePrivateRelay(t, h, relay, (message) => !message.cancelTimeoutRunId || acknowledge)
  await h.tick(3250)
  h.publish({ requestId: 'resume-after-lost-cancel', extendSeconds: 10 })
  h.opts.terminalHandler = (...args) => h.terminal.push(args)
  acknowledge = true
  await h.tick(450)
  assert.equal(h.terminal.length, 0, 'a retained fence must not bypass a pending owner extension')
  assert.equal(h.current().extensionCount, 1)
  assert.doesNotThrow(() => broker.trackQueueRequest().waiting())
})

test('verdict: an unacknowledged extension cancellation is retried before committing', async (t) => {
  const relay = new EventEmitter()
  const h = harness(t, { maxExtensions: 1, child: { pid: 4, laneSandbox: { suiteBroker: relay } } })
  let cancellations = 0
  const broker = servePrivateRelay(t, h, relay, (message) => !message.timeoutRunId && (!message.cancelTimeoutRunId || ++cancellations > 1))
  await h.tick(3250)
  h.publish({ requestId: 'retry-cancel', preemptive: true, extendSeconds: 10 })
  await h.tick(350)
  assert.equal(h.current().extensionCount, 0, 'an extension must wait for acknowledged admission recovery')
  assert.ok(fs.existsSync(`${h.decisionFile}.claimed`), 'the uncommitted owner request must remain retryable')
  await h.tick(100)
  assert.equal(h.current().extensionCount, 1)
  assert.equal(h.journal.filter((event) => event.requestId === 'retry-cancel').length, 1)
  assert.doesNotThrow(() => broker.trackQueueRequest().waiting())
})

for (const gap of [1000, 3500]) for (const recovered of ['queued', 'running']) test(`pause: recovered ${recovered} evidence refunds a ${gap} ms observation gap exactly once`, async (t) => {
  const h = harness(t), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => broker.close())
  const request = broker.trackQueueRequest()
  request.waiting()
  h.authority(() => broker.decideTimeout('1-1'))
  h.evidence(() => broker.queueState('1-1'))
  await h.tick(100)
  h.evidence(new Error('fixture observation lost'))
  await h.tick(gap)
  if (recovered === 'running') request.holding()
  h.evidence(() => broker.queueState('1-1'))
  await h.tick(100)
  if (recovered === 'queued') request.holding()
  const remaining = recovered === 'queued' ? 2000 : 1900
  await h.tick(remaining - 1)
  assert.equal(h.current().state, 'running', 'confirmed cumulative queue time must restore the entire remaining work budget')
  await h.tick(1)
  assert.equal(h.current().state, 'decision-needed', 'recovered queue time must be credited once without refilling the budget')
})

test('pause: recovered budget survives a failed resume publication without early termination', async (t) => {
  const h = harness(t), broker = createSuiteLockBroker({ runId: '1-1', env: { WT_SUITE_LOCK_DIR: h.lock } })
  t.after(() => broker.close())
  const request = broker.trackQueueRequest()
  request.waiting()
  h.authority(() => broker.decideTimeout('1-1'))
  h.evidence(() => broker.queueState('1-1'))
  await h.tick(100)
  h.evidence(new Error('fixture observation lost'))
  await h.tick(3500)
  request.done()
  h.evidence(() => broker.queueState('1-1'))
  let publications = 0
  h.fail((extra) => { if (extra.state === 'running' && ++publications === 1) throw new Error('fixture resume publication failed') })
  await h.tick(100)
  assert.equal(h.terminal.length, 0, 'a resume-state failure must not terminate a lane with recovered work budget')
  await h.tick(100)
  assert.equal(h.current().state, 'running', 'the next tick must retry the recovered-budget publication')
  assert.equal(publications, 2)
  await h.tick(1799)
  assert.equal(h.current().state, 'running')
  await h.tick(1)
  assert.equal(h.current().state, 'decision-needed')
})

function startBrokerTransport(registered) {
  const root = fs.mkdtempSync(join(tmpdir(), 'broker-query-')), lock = join(root, 'lock')
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\broker-query-${process.pid}-${Date.now()}` : join(root, 'broker.sock')
  const helper = fork(new URL('lane-suite-lock-broker.mjs', base), ['--socket', socket, ...(registered ? ['--run-id', '1-1'] : []), '--parent', String(process.pid)], { env: { ...process.env, WT_SUITE_LOCK_DIR: lock, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', WT_SUITE_LOCK_STATIC_LANE: '0' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  return { root, lock, socket, helper, clients: [] }
}

function connectBrokerClient(socket, clients) {
  const client = net.createConnection(socket), state = { text: '', client }
  clients.push(client)
  client.on('data', (data) => { state.text += data })
  client.on('connect', () => client.write(`${JSON.stringify({ argv: ['fixture'], waitS: 10 })}\n`))
  return state
}

function stopBrokerTransport(clients, holder, helper) {
  for (const client of clients) client.destroy()
  if (holder) releaseSuiteLock(holder)
  const exited = once(helper, 'exit')
  helper.kill('SIGTERM')
  return exited
}

for (const registered of [true, false]) test(`native-transport: ${registered ? 'prebound' : 'parent-registered'} helper reports grant and overlap atomically`, { skip: process.platform === 'win32' && 'the installed sandbox broker uses Unix sockets' }, async () => {
  const { root, lock, socket, helper, clients } = startBrokerTransport(registered)
  let holder
  try {
    holder = await acquireSuiteLock({ root: lock, env: { WT_SUITE_LOCK_STATIC_LANE: '0' } })
    await until(() => fs.existsSync(`${socket}.ready`))
    const connect = () => connectBrokerClient(socket, clients)
    const first = connect()
    await until(() => first.text.includes('wait '))
    assert.equal((await queryBrokerQueue(helper, '1-1')).status, 'queued')
    assert.equal((await queryBrokerQueue(helper, '1-1', true)).terminate, false, 'a waiting request must veto the serialized timeout decision')
    assert.equal(await queryBrokerQueue(helper, 'foreign'), null)
    releaseSuiteLock(holder); holder = null
    await until(() => first.text.includes('granted '))
    assert.equal((await queryBrokerQueue(helper, '1-1')).status, 'running', 'last wait record cannot outlive the grant')
    assert.equal((await queryBrokerQueue(helper, '1-1', true)).terminate, false, 'an admitted holder must veto timeout termination')
    const second = connect()
    await until(() => second.text.includes('wait '))
    assert.equal((await queryBrokerQueue(helper, '1-1')).status, 'running', 'one holding plus one waiting never pauses')
    assert.equal((await queryBrokerQueue(helper, '1-1', true)).terminate, false)
    first.client.end()
    await until(() => second.text.includes('granted '))
    assert.equal((await queryBrokerQueue(helper, '1-1')).status, 'running')
    second.client.end()
    let verdict
    for (let attempt = 0; attempt < 100; attempt++) {
      verdict = await queryBrokerQueue(helper, '1-1', true)
      if (verdict?.terminate) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(verdict?.terminate, true, 'no admitted request must authorize termination')
    const late = connect()
    await until(() => late.text.includes('error '))
    assert.match(late.text, /timeout authorized/, 'the IPC verdict must fence subsequent socket admission')
  } finally {
    await stopBrokerTransport(clients, holder, helper)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
