import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { harness } from './fixtures/broker-deadline-harness.mjs'

const { terminateLane, appendSupervisorJournal } = await import(process.env.WT_LANE_SUPERVISOR_MODULE ?? new URL('../../../../plugin/bin/lib/lane-supervisor-core.mjs', import.meta.url))

function observeTermination(t, h) {
  const timers = [], calls = [], schedule = globalThis.setTimeout
  h.opts.terminalHandler = (...args) => { calls.push('terminate'); h.terminal.push(args) }
  t.mock.method(globalThis, 'setTimeout', (...args) => { if (h.terminal.length) timers.push(args[1]); return schedule(...args) })
  return { timers, calls }
}

function eio() { throw Object.assign(new Error('fixture EIO'), { code: 'EIO' }) }

test('termination: pre-signal adapter failure keeps supervision armed until recovery', async (t) => {
  const h = harness(t)
  let attempts = 0, unavailable = true
  h.opts.terminalHandler = (...args) => {
    attempts += 1
    if (unavailable) eio()
    h.terminal.push(args)
  }
  await h.tick(3000)
  assert.ok(attempts > 0)
  assert.equal(h.terminal.length, 0)
  unavailable = false
  await h.tick(100)
  assert.equal(h.terminal.length, 1, 'a pre-signal failure must leave an armed retry that terminates after recovery')
  const completedAttempts = attempts
  await h.tick(1000)
  assert.equal(attempts, completedAttempts, 'successful termination must stop every further retry')
})

test('termination: launcher pre-signal clearing cannot disarm a failed termination attempt', async (t) => {
  const h = harness(t)
  const file = process.env.WT_LANE_LAUNCHER_MODULE ?? new URL('../../../../plugin/bin/wt-lane.mjs', import.meta.url)
  const body = /const endGroup = \(code, \{ writeReceipt = true, receiptLines = \[\], terminal = null \} = \{\}\) => \{([\s\S]*?)\n  \}/.exec(fs.readFileSync(file, 'utf8'))?.[1]
  assert.ok(body)
  const calls = []
  let unavailable = true
  const consentModules = { terminateLane: () => { calls.push('signal'); if (unavailable) eio(); h.terminal.push([126]); return { killed: true } } }
  const endGroup = new Function('clearDeadline', 'finish', 'process', 'consentModules', 'currentState', 'GRACE_MS', 'journal', 'child', 'writeState', `return (code, { writeReceipt = true, receiptLines = [], terminal = null } = {}) => {${body}\n}`)(() => { calls.push('clear'); h.clearBeforeSignal() }, () => {}, { removeAllListeners() {}, on() {} }, consentModules, {}, 0, () => {}, {}, () => {})
  h.opts.terminalHandler = endGroup
  await h.tick(3000)
  assert.equal(h.terminal.length, 0)
  assert.ok(calls.includes('clear'), 'exercise the real launcher clear before its throwing signal adapter')
  unavailable = false
  await h.tick(100)
  assert.equal(h.terminal.length, 1, 'the real launcher pre-signal clear must leave supervision armed after failure')
  const completedAttempts = calls.length
  await h.tick(1000)
  assert.equal(calls.length, completedAttempts, 'successful launcher termination must stop every further retry')
})

test('termination: launcher signals before journal and terminal state writes despite receipt failure', () => {
  const file = process.env.WT_LANE_LAUNCHER_MODULE ?? new URL('../../../../plugin/bin/wt-lane.mjs', import.meta.url)
  const body = /const endGroup = \(code, \{ writeReceipt = true, receiptLines = \[\], terminal = null \} = \{\}\) => \{([\s\S]*?)\n  \}/.exec(fs.readFileSync(file, 'utf8'))?.[1]
  assert.ok(body, 'exercise the installed launcher termination adapter')
  const calls = []
  const write = (name) => () => { calls.push(name); eio() }
  const child = { pid: 4, kill: () => calls.push('force') }, state = { childPid: 4, workerPid: 2 }
  const consentModules = { terminateLane(record, settings) {
    return terminateLane(record, { ...settings, graceMs: 0, platform: 'linux', kill: (_pid, signal) => calls.push(signal === 0 ? 'probe' : 'kill') })
  } }
  const finishBody = /const finish = \(code, receiptLines = \[\]\) => \{([\s\S]*?)\n  \}/.exec(fs.readFileSync(file, 'utf8'))?.[1]
  assert.ok(finishBody, 'exercise the installed best-effort receipt writer')
  const finish = new Function('opts', 'appendFileSync', `let finished = false; return (code, receiptLines = []) => {${finishBody}\n}`)({ log: 'fixture.log' }, write('receipt'))
  const endGroup = new Function('clearDeadline', 'finish', 'process', 'consentModules', 'currentState', 'GRACE_MS', 'journal', 'child', 'writeState', `return (code, { writeReceipt = true, receiptLines = [], terminal = null } = {}) => {${body}\n}`)(() => {}, finish, { removeAllListeners() {}, on() {} }, consentModules, state, 0, write('journal'), child, write('state'))
  assert.doesNotThrow(() => endGroup(126, { terminal: { state: 'abandoned' } }), 'launcher bookkeeping must be best-effort after signalling')
  assert.equal(calls[0], 'receipt')
  assert.equal(calls.filter((name) => name !== 'receipt')[0], 'kill', 'launcher must signal before journal or terminal-state writes')
  assert.ok(calls.indexOf('force') < calls.indexOf('journal') && calls.indexOf('force') < calls.indexOf('state'), 'force signal must precede every journal and state attempt')
  assert.ok(calls.includes('state') && calls.includes('journal') && calls.includes('receipt'))
  assert.equal(calls.filter((name) => name === 'kill').length, 1)
  assert.equal(calls.filter((name) => name === 'force').length, 1)
})

test('termination: journal storage failure is diagnosed before a legacy adapter catches it', (t) => {
  const h = harness(t), diagnostics = [], append = fs.appendFileSync
  t.mock.method(process.stderr, 'write', (text) => { diagnostics.push(String(text)); return true })
  t.mock.method(fs, 'appendFileSync', (file, ...args) => { if (file === join(h.root, 'lane-supervisor.jsonl')) eio(); return append(file, ...args) })
  syncBuiltinESMExports()
  assert.throws(() => appendSupervisorJournal(h.root, { event: 'terminated' }), /fixture EIO/)
  assert.match(diagnostics.join(''), /supervisor journal.*fixture EIO/, 'journal storage errors must be visible even when the caller absorbs them')
})

test('termination: wall-clock rollback cannot extend timeout or grace', async (t) => {
  const h = harness(t, { realTime: true, monotonic: true, timeout: 0.2, decisionGrace: 0.1 })
  await h.tick(100)
  const now = Date.now
  let rollback = 3_600_000
  t.mock.method(Date, 'now', () => now() - rollback)
  await h.tick(125)
  assert.equal(h.current().state, 'decision-needed', 'rollback must not delay the monotonic timeout')
  rollback += 3_600_000
  assert.equal(h.terminal.length, 0, 'rollback must not shorten the monotonic grace')
  await h.tick(150)
  assert.equal(h.terminal.length, 1, 'rollback must not delay termination beyond timeout plus grace')
})

test('termination: every write failing still kills first exactly once at grace expiry', async (t) => {
  const h = harness(t), { timers, calls } = observeTermination(t, h)
  await h.tick(2999)
  h.fail(() => { calls.push('state'); eio() })
  h.journal.push = () => { calls.push('journal'); eio() }
  h.opts.cleanupHandler = () => { calls.push('cleanup'); eio() }
  await h.tick(1)
  assert.equal(h.terminal.length, 1, 'write failures must not prevent timeout termination')
  assert.equal(calls[0], 'terminate', 'termination must precede all fallible bookkeeping')
  await h.tick(1000)
  assert.equal(h.terminal.length, 1, 'failed bookkeeping must never repeat termination')
  assert.deepEqual(timers, [], 'failed bookkeeping must never schedule another deadline tick')
})

test('termination: a failed decision-state write cannot postpone timeout plus grace', async (t) => {
  const h = harness(t), { timers } = observeTermination(t, h)
  h.fail(eio)
  h.journal.push = eio
  await h.tick(2999)
  assert.equal(h.terminal.length, 0)
  await h.tick(1)
  assert.equal(h.terminal.length, 1, 'unavailable decision storage must not defer the termination bound')
  await h.tick(1000)
  assert.deepEqual(timers, [], 'terminal storage failure must leave supervision stopped')
})

test('termination: storage unavailable from construction cannot disarm the deadline', async (t) => {
  let h
  assert.doesNotThrow(() => { h = harness(t, { stateWriterFactory: (state) => ({ current: () => state, writeState: eio }) }) }, 'initial state publication must not prevent installing the deadline')
  const { timers } = observeTermination(t, h)
  h.journal.push = eio
  await h.tick(2999)
  assert.equal(h.terminal.length, 0)
  await h.tick(1)
  assert.equal(h.terminal.length, 1, 'persistent storage failure must still terminate at timeout plus grace')
  await h.tick(1000)
  assert.deepEqual(timers, [])
})

test('termination: queue-exit publication failure cannot hide the resumed deadline', async (t) => {
  const h = harness(t), { timers } = observeTermination(t, h)
  await h.tick(1000)
  h.queued()
  await h.tick(4000)
  h.fail(eio)
  h.evidence({ runId: '1-1', status: 'running', since: Date.now(), observedAt: Date.now() })
  await h.tick(1999)
  assert.equal(h.terminal.length, 0, 'queue exit must preserve the remaining timeout and grace')
  await h.tick(1)
  assert.equal(h.terminal.length, 1, 'failed queue bookkeeping cannot postpone the resumed deadline')
  await h.tick(1000)
  assert.deepEqual(timers, [])
})

test('termination: state commit precedes one identified owner decision journal', async (t) => {
  const h = harness(t, { maxExtensions: 1 }), order = []
  let denied = false
  h.fail((extra) => {
    if (extra.decision !== 'extend') return
    if (!denied) { denied = true; throw new Error('fixture state unavailable once') }
    order.push('commit')
  })
  const push = h.journal.push.bind(h.journal)
  h.journal.push = (event) => { if (event.event === 'decision') order.push('journal'); return push(event) }
  h.publish({ preemptive: true, requestId: 'identified', extendSeconds: 10 })
  await h.tick(2000)
  assert.equal(h.journal.filter((event) => event.event === 'decision').length, 0, 'an uncommitted decision must not appear in the journal')
  await h.tick(100)
  assert.equal(h.current().extensionCount, 1)
  const events = h.journal.filter((event) => event.event === 'decision')
  assert.equal(events.length, 1, 'one committed owner decision must produce exactly one journal event')
  assert.equal(events[0].requestId, 'identified', 'the decision event must identify its consumed request')
  assert.deepEqual(order, ['commit', 'journal'])
})

test('termination: throwing claim removal cannot revive a successfully abandoned lane', async (t) => {
  const h = harness(t), { timers, calls } = observeTermination(t, h)
  await h.tick(2000)
  h.publish({ decision: 'abandon', requestId: 'stop' })
  const remove = fs.rmSync
  t.mock.method(fs, 'rmSync', (file, ...args) => { if (file === `${h.decisionFile}.claimed`) { calls.push('remove'); eio() }; return remove(file, ...args) })
  syncBuiltinESMExports()
  await h.tick(100)
  assert.equal(h.terminal.length, 1)
  assert.deepEqual(calls, ['terminate', 'remove'], 'claim removal follows successful termination')
  assert.deepEqual(timers, [], 'claim removal failure must not revive the stopped worker')
  await h.tick(2000)
  assert.equal(h.terminal.length, 1)
})
