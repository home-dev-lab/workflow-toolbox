import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parkQualityParity } from './suite-lock-terminal-park-parity.mjs'

const bin = process.env.WT_TERMINAL_MODULE_ROOT
  ? pathToFileURL(`${process.env.WT_TERMINAL_MODULE_ROOT}/`)
  : new URL('../../../../plugin/bin/', import.meta.url)
const load = (name) => import(new URL(name, bin).href)
const lock = await load('lib/suite-lock.mjs')
const recovery = await load('lib/host/suite-lock-recovery.mjs')
const parkFiles = await load('lib/host/suite-lock-park-files.mjs')
const parkRuntime = await load('lib/suite-lock-park.mjs')
const cli = await load('wt-suite-lock.mjs')
export const terminalEvents = (root) => ['journal.1.jsonl', 'journal.jsonl'].flatMap((name) => existsSync(join(root, name))
  ? readFileSync(join(root, name), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
const ends = (root, id) => terminalEvents(root).filter((e) => e.leaseId === id && ['release', 'abort', 'timeout'].includes(e.event))
const ticketFile = (root) => join(root, 'queue.d/0000000000000001.json')
const options = (root) => ({ root, env: { WT_SUITE_LOCK_STATIC_LANE: '0' } })
const journalBytes = (root) => ['journal.1.jsonl', 'journal.jsonl'].map((name) => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : null)

export async function withTerminalRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'wt-terminal-review-'))
  try { await run(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

function liveHolderSource(root) {
  const module = JSON.stringify(new URL('lib/suite-lock.mjs', bin).href)
  const source = `import{acquireSuiteLock,readSuiteLock}from ${module};
    const lease=await acquireSuiteLock(${JSON.stringify(options(root))});
    process.send(lease);
    const timer=setInterval(()=>{if(readSuiteLock({root:${JSON.stringify(root)}}).holder?.leaseId!==lease.holder.leaseId){clearInterval(timer);process.exit(0)}},20);`
  // IPC publishes the lease before the launcher exits; the actual holder stays
  // alive until its directory is released or the fixture root is cleaned.
  return `import{spawn}from'node:child_process';
    const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(source)}],{stdio:['ignore','ignore','ignore','ipc']});
    let published=false;
    child.once('message',lease=>{published=true;console.log(JSON.stringify(lease));child.disconnect();child.unref()});
    child.once('exit',code=>{if(!published)process.exit(code||1)});`
}

async function releaseHandover(root, spawn) {
  const a = await lock.acquireSuiteLock(options(root))
  let b
  let switched = false
  const outcome = { get served() {
    if (!switched) {
      switched = true
      lock.operatorReleaseSuiteLock({ root, force: true })
      const child = spawn(process.execPath, ['--input-type=module', '-e', liveHolderSource(root)], { encoding: 'utf8' })
      assert.equal(child.status, 0, child.stderr)
      b = JSON.parse(child.stdout)
      assert.doesNotThrow(() => process.kill(b.holder.pid, 0), 'B must still be live when A resumes')
    }
    return false
  } }
  lock.releaseSuiteLock(a, outcome)
  assert.equal(ends(root, a.holder.leaseId).length, 1, 'A must have exactly one release')
  assert.equal(lock.readSuiteLock({ root }).holder?.leaseId, b.holder.leaseId, 'B holder must survive A release')
  lock.releaseSuiteLock(b)
  assert.equal(ends(root, b.holder.leaseId).length, 1, 'B later release must be journaled')
}

async function operatorFirst(root) {
  const lease = await lock.acquireSuiteLock(options(root))
  const dead = { ...lease.holder, pid: 2147483647 }
  writeFileSync(ticketFile(root), JSON.stringify(dead))
  const claim = join(root, `queue.d/.reaped-${process.pid}-paused`)
  writeFileSync(claim, JSON.stringify(dead))
  lock.operatorReleaseSuiteLock({ root, force: true })
  recovery.reapSuiteTicket(join(root, 'queue.d'), { number: 1, holder: dead })
  assert.equal(ends(root, lease.holder.leaseId).length, 1, 'operator-first recovery must have one terminal')
  assert.equal(existsSync(claim), false, 'holder removal must sweep same-lease claims')
}

async function busyTicket(root) {
  const lease = await lock.acquireSuiteLock(options(root))
  lock.releaseSuiteLock(lease)
  const dead = { ...lease.holder, pid: 2147483647, leaseId: 'busy', journal: { ...lease.journal.base, leaseId: 'busy' } }
  writeFileSync(ticketFile(root), JSON.stringify(dead))
  mkdirSync(join(root, 'reclaim.d'))
  recovery.reapSuiteTicket(join(root, 'queue.d'), { number: 1, holder: dead })
  assert.equal(existsSync(ticketFile(root)), true, 'busy section must restore ticket')
  assert.equal(ends(root, 'busy').length, 0, 'busy section must not append')
}

async function asideTicket(root) {
  const lease = await lock.acquireSuiteLock(options(root))
  const dead = { ...lease.holder, pid: 2147483647 }
  writeFileSync(ticketFile(root), JSON.stringify(dead))
  lock.operatorReleaseSuiteLock({ root, force: true, afterLockAside() {
    recovery.reapSuiteTicket(join(root, 'queue.d'), { number: 1, holder: dead })
  } })
  assert.equal(ends(root, lease.holder.leaseId).length, 1, 'ticket reaper must not append while holder is aside')
}

async function busyRelease(root) {
  const lease = await lock.acquireSuiteLock(options(root))
  mkdirSync(join(root, 'reclaim.d'))
  assert.equal(lock.releaseSuiteLock(lease), false, 'busy release must retain holder at retry bound')
  assert.equal(lock.readSuiteLock({ root }).holder.leaseId, lease.holder.leaseId)
  assert.equal(ends(root, lease.holder.leaseId).length, 0)
  rmSync(join(root, 'reclaim.d'), { recursive: true })
  lock.releaseSuiteLock(lease)
  assert.equal(ends(root, lease.holder.leaseId).length, 1)
}

async function admissionFailure(root) {
  const controller = new AbortController()
  await assert.rejects(lock.acquireSuiteLock({ ...options(root), signal: controller.signal, afterPublish() { controller.abort() } }))
  const request = terminalEvents(root).find((event) => event.event === 'request')
  assert.equal(ends(root, request.leaseId).length, 1, 'published admission error must have one terminal')
  assert.equal(ends(root, request.leaseId)[0].event, 'release')
}

async function handbackEnding(root, throws) {
  const queue = await load('lib/host/suite-lock-queue.mjs')
  let blocker
  const request = lock.acquireSuiteLock({ ...options(root), light: true, beforeAcquire() {
    if (blocker !== undefined) return
    const counter = queue.readLightCounter(root)
    blocker = queue.takeTicket(join(root, 'queue.d'), {
      pid: process.pid, argv: ['release'], startedAt: new Date().toISOString(), priority: 'release',
      lightGrantsAtQueue: counter.grants, lightGrantsGeneration: counter.generation, pidNamespace: null, startTime: null,
    })
  }, afterHandBack() {
    queue.removeTicket(join(root, 'queue.d'), blocker)
    if (throws) throw Object.assign(new Error('hand-back failure'), { code: 'EINJECTED' })
  } })
  if (throws) await assert.rejects(request, { code: 'EINJECTED' })
  else lock.releaseSuiteLock(await request)
  const requests = terminalEvents(root).filter((event) => event.event === 'request')
  for (const event of requests) {
    const terminal = ends(root, event.leaseId)
    assert.equal(terminal.length, 1, 'published hand-back must have exactly one terminal')
    assert.equal(terminal[0].event, 'release', 'published hand-back must release, never abort')
  }
  assert.equal(requests.length, throws ? 1 : 2, 'retry after an ended publication must use a fresh lease')
}

function liveClaims(root) {
  for (const prefix of ['.reaped-', 'lock.d.reclaimed-']) {
    const file = join(root, `${prefix}${process.pid}-active`)
    writeFileSync(file, '{}')
    const old = new Date(Date.now() - 601_000)
    utimesSync(file, old, old)
    recovery.cleanSuiteRecoveryFiles(root, prefix)
    assert.equal(existsSync(file), true, 'old claim owned by live pid must survive')
  }
}

async function publishedFailure(root, cleanup, code = 'EINJECTED', staticRun = false) {
  const error = Object.assign(new Error('post-publication failure'), { code })
  const remove = fs.rmSync
  try {
    await assert.rejects(lock.acquireSuiteLock({ ...options(root), static: staticRun, env: { WT_SUITE_LOCK_STATIC_LANE: '1' }, waitS: 0, staleS: 0, afterPublish() {
      if (!cleanup) throw error
      fs.rmSync = (file, ...args) => {
        if (file === ticketFile(root)) { fs.rmSync = remove; syncBuiltinESMExports(); throw error }
        return remove(file, ...args)
      }
      syncBuiltinESMExports()
    } }))
  } finally { fs.rmSync = remove; syncBuiltinESMExports() }
  const request = terminalEvents(root).find((event) => event.event === 'request')
  const terminal = ends(root, request.leaseId)
  assert.equal(terminal.length, 1, 'published failure must have one terminal')
  assert.equal(terminal[0].event, 'release', 'published failure must release, never abort')
  assert.equal(terminal[0].cause, 'error')
  assert.equal(terminal[0].kind, staticRun ? 'static' : 'exclusive')
  assert.equal(terminal[0].code, code)
  assert.equal(lock.readSuiteLock({ root: staticRun ? join(root, 'static-lane') : root }).held, false)
}

async function mismatchedJournal(root, holder) {
  const lease = await lock.acquireSuiteLock(options(root))
  lock.releaseSuiteLock(lease)
  const dead = { ...lease.holder, pid: 2147483647, leaseId: 'artifact-A', journal: { ...lease.journal.base, leaseId: 'journal-B' } }
  if (holder) {
    mkdirSync(join(root, 'lock.d'))
    writeFileSync(join(root, 'lock.d/holder.json'), JSON.stringify(dead))
    lock.operatorReleaseSuiteLock({ root, force: true })
  } else {
    writeFileSync(ticketFile(root), JSON.stringify(dead))
    recovery.reapSuiteTicket(join(root, 'queue.d'), { number: 1, holder: dead })
  }
  assert.equal(ends(root, 'journal-B').length, 0, 'mismatched metadata must not journal another lease')
}

async function spawnFailure(root) {
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']
  const counts = () => signals.map((signal) => process.listenerCount(signal))
  const before = counts()
  await assert.rejects(cli.runLeasedCommand([join(root, 'nonexistent-executable')], { inherited: true, domain: root, holder: { leaseId: 'inherited' } }, { attempt: {} }), { code: 'ENOENT' })
  assert.deepEqual(counts(), before, 'spawn failure must remove forwarding handlers')
}

async function signalOverYield(root) {
  const directory = join(root, 'park')
  mkdirSync(directory, { mode: 0o700 }); writeFileSync(join(directory, 'key'), 'k'.repeat(32), { mode: 0o600 })
  const park = { ...parkFiles.validateParkDirectory(directory, process.pid), windowMs: 60_000, yieldToParked: true }
  const first = await lock.acquireSuiteLock({ ...options(root), park })
  parkRuntime.finishParkRun(first, park, true); lock.releaseSuiteLock(first)
  const lease = await lock.acquireSuiteLock({ ...options(root), park: { ...park, keyHash: 'another', directory: root } })
  assert.equal(parkRuntime.shouldYieldParkLease(lease, park, lock.readSuiteLockParked), true, 'fixture must be eligible to yield')
  const controller = new AbortController(); controller.abort({ signal: 'SIGTERM' })
  const exit = await cli.runLeasedCommand(['never-spawn'], lease, { park, attempt: {}, waiting: { signal: controller.signal, close() {} } })
  assert.equal(exit, 143, 'recorded TERM must win over park exit 75')
  assert.equal(ends(root, lease.holder.leaseId)[0].signal, 'SIGTERM')
}

function firstParkSignal() {
  const waiting = parkFiles.watchParkWait()
  try {
    process.emit('SIGTERM'); process.emit('SIGINT')
    assert.equal(waiting.signal.reason.signal, 'SIGTERM')
    assert.equal(waiting.exit(), 143, 'park wait exit must keep first signal')
  } finally { waiting.close() }
}

async function cleanupBytes(root) {
  const lease = await lock.acquireSuiteLock(options(root)); lock.releaseSuiteLock(lease)
  for (const prefix of ['.reaped-', 'lock.d.reclaimed-']) {
    const file = join(root, `${prefix}unparseable`)
    writeFileSync(file, '{}')
    const old = new Date(Date.now() - 601_000); utimesSync(file, old, old)
    const before = journalBytes(root)
    recovery.cleanSuiteRecoveryFiles(root, prefix)
    assert.equal(existsSync(file), false)
    assert.deepEqual(journalBytes(root), before, 'cleanup must preserve journal bytes')
  }
}

async function bothGenerations(root) {
  const lease = await lock.acquireSuiteLock(options(root)); lock.releaseSuiteLock(lease)
  renameSync(join(root, 'journal.jsonl'), join(root, 'journal.1.jsonl'))
  const terminal = JSON.parse(readFileSync(join(root, 'journal.1.jsonl'), 'utf8').trim().split('\n').at(-1))
  writeFileSync(join(root, 'journal.jsonl'), `${JSON.stringify(terminal)}\n`)
  assert.equal(ends(root, lease.holder.leaseId).length, 2, 'terminal helper must detect duplicates across generations')
}

export const terminalReviewCases = {
  '1 normal release preserves handover': releaseHandover,
  '1 busy release retains holder at bound': busyRelease,
  '2 operator-first ticket recovery': operatorFirst,
  '2 busy ticket reaper restores claim': busyTicket,
  '2 ticket reaper waits for holder aside': asideTicket,
  '3 live old recovery claim': liveClaims,
  '5 afterPublish failure releases': (root) => publishedFailure(root, false),
  '5 ticket cleanup failure releases': (root) => publishedFailure(root, true),
  '5 published admission failure releases': admissionFailure,
  '5 transient post-publication failure releases': (root) => publishedFailure(root, false, 'EACCES'),
  '5 static post-publication failure releases': (root) => publishedFailure(root, false, 'EINJECTED', true),
  '5 hand-back failure releases published lease': (root) => handbackEnding(root, true),
  '5 hand-back retry uses a fresh lease': (root) => handbackEnding(root, false),
  '6 ticket journal identity': (root) => mismatchedJournal(root, false),
  '6 holder journal identity': (root) => mismatchedJournal(root, true),
  '7 spawn error removes signal handlers': spawnFailure,
  '8 recorded signal wins over yield': signalOverYield,
  '8 park wait keeps first signal exit': firstParkSignal,
  'T1 cleanup preserves journal bytes': cleanupBytes,
  'T2 terminal helper reads both generations': bothGenerations,
  'quality park refactor preserves 16 execution cases': () => parkQualityParity(new URL('lib/host/suite-lock-park-files.mjs', bin)),
}
