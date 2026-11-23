import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const bin = process.env.WT_TERMINAL_MODULE_ROOT
  ? pathToFileURL(`${process.env.WT_TERMINAL_MODULE_ROOT}/`)
  : new URL('../../../../plugin/bin/', import.meta.url)
const load = (name) => import(new URL(name, bin).href)
const lock = await load('lib/suite-lock.mjs')
const recovery = await load('lib/host/suite-lock-recovery.mjs')
const lifecycle = await load('lib/suite-lock-journal-lifecycle.mjs')
const journal = await load('lib/host/suite-lock-journal-append.mjs')
const options = (root) => ({ root, env: { WT_SUITE_LOCK_STATIC_LANE: '0' } })
const ticketFile = (root) => join(root, 'queue.d/0000000000000001.json')
const terminals = new Set(['release', 'timeout', 'abort'])
const events = (root) => journal.suiteJournalLines(root).map((line) => JSON.parse(line))
const ends = (root, id) => events(root).filter((event) => event.leaseId === id && terminals.has(event.event))
const denied = (code) => Object.assign(new Error('injected filesystem failure'), { code })
let spawnChild = spawn
export const setTerminalOnceSpawn = (implementation) => { spawnChild = implementation }

export async function withTerminalOnceRoot(run) {
  const root = fs.mkdtempSync(join(tmpdir(), 'wt-terminal-once-'))
  try { await run(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

function proveGone(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'client pid must be proven gone')
}

async function childRun(source, env = {}) {
  const child = spawnChild(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve(child.pid) : reject(new Error(`child exit ${code}: ${stderr}`)))
  })
  const ready = new Promise((resolve) => child.once('message', resolve))
  const timer = setTimeout(() => child.kill(), 15_000)
  exited.finally(() => clearTimeout(timer)).catch(() => {})
  return { child, exited, ready }
}

// The replacement throws the final EPERM that rmSync reports after its retries.
// Restoring the builtin also restores existing ESM named imports.
export async function failedWaiter(root) {
  const remove = fs.rmSync
  let attempts = 0
  try {
    await assert.rejects(lock.acquireSuiteLock({ ...options(root), beforeAcquire() {
      fs.rmSync = (file, settings) => {
        if (file !== ticketFile(root)) return remove(file, settings)
        attempts++
        assert.equal(settings.maxRetries, 10)
        assert.equal(settings.recursive, true)
        throw denied('EPERM')
      }
      syncBuiltinESMExports()
      throw denied('ABORT_ERR')
    } }), { code: 'EPERM' })
  } finally { fs.rmSync = remove; syncBuiltinESMExports() }
  assert.equal(attempts, 1, 'fault must hit the real waiter cleanup')
}

async function caseA(root) {
  const run = await childRun(`import {failedWaiter} from ${JSON.stringify(import.meta.url)};await failedWaiter(${JSON.stringify(root)})`)
  const pid = await run.exited
  proveGone(pid)
  const record = JSON.parse(fs.readFileSync(ticketFile(root), 'utf8'))
  assert.equal(record.pid, pid)
  assert.equal(ends(root, record.leaseId).length, 1, 'waiter must record its abort before reaping')
  assert.equal(ends(root, record.leaseId)[0].event, 'abort')
  recovery.reapSuiteTicket(join(root, 'queue.d'), { number: 1, holder: record })
  assert.equal(fs.existsSync(ticketFile(root)), false, 'reaper must consume the leftover ticket')
  assert.equal(ends(root, record.leaseId).length, 1, 'case A: failed ticket removal then reaping must have exactly one terminal')
}

async function caseB(root) {
  const lease = await lock.acquireSuiteLock(options(root))
  const run = await childRun('process.exit(0)')
  const pid = await run.exited
  proveGone(pid)
  const record = { ...lease.holder, pid }
  fs.writeFileSync(ticketFile(root), JSON.stringify(record))
  const read = fs.readFileSync
  let failures = 0
  try {
    fs.readFileSync = (file, ...args) => {
      if (file !== ticketFile(root)) return read(file, ...args)
      failures++
      throw denied('EACCES')
    }
    syncBuiltinESMExports()
    assert.equal(lock.releaseSuiteLock(lease), true)
  } finally { fs.readFileSync = read; syncBuiltinESMExports() }
  assert.equal(failures, 1, 'fault must hit the release ticket sweep')
  assert.equal(fs.existsSync(ticketFile(root)), true, 'unreadable ticket must survive release')
  recovery.reapSuiteTicket(join(root, 'queue.d'), { number: 1, holder: record })
  assert.equal(fs.existsSync(ticketFile(root)), false, 'reaper must consume the leftover ticket')
  assert.equal(ends(root, record.leaseId).length, 1, 'case B: unreadable release ticket then reaping must have exactly one terminal')
  assert.equal(ends(root, record.leaseId)[0].event, 'release', 'case B must preserve the release')
}

function seededRandom() {
  let seed = 0x5eed1234
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000 }
}

async function waiterWriter(root, record, timeout) {
  const failure = denied(timeout ? 'WT_SUITE_LOCK_TIMEOUT' : 'ABORT_ERR')
  await assert.rejects(lifecycle.acquireJournalLease(async (settings) => {
    const waiter = lifecycle.journalWaiterRecord({ ...record }, settings, 'P2')
    waiter.leaseId = record.leaseId
    lifecycle.takeJournalTicket(join(root, 'queue.d'), waiter)
    throw failure
  }, options(root), root, () => null, () => { throw new Error('unexpected inheritance') }), failure)
}

async function driveWriter(root, lease, writer, random) {
  const record = { ...lease.holder, pid: 2147483647 }
  fs.rmSync(lease.lockDir, { recursive: true, force: true })
  fs.rmSync(join(root, 'queue.d'), { recursive: true, force: true })
  fs.mkdirSync(join(root, 'queue.d'))
  if (writer === 'waiter') return waiterWriter(root, record, random() < 0.5)
  if (writer === 'reaper') {
    fs.writeFileSync(ticketFile(root), JSON.stringify(record))
    return recovery.reapSuiteTicket(join(root, 'queue.d'), { number: 1, holder: record })
  }
  fs.mkdirSync(lease.lockDir)
  fs.writeFileSync(join(lease.lockDir, 'holder.json'), JSON.stringify(record))
  if (writer === 'release') assert.equal(lock.releaseSuiteLock(lease), true)
  else assert.equal(lock.operatorReleaseSuiteLock({ ...options(root), force: random() < 0.5 }).released, true)
}

async function writerProperty(root) {
  proveGone(2147483647)
  const random = seededRandom()
  const failures = []
  const coverage = new Set()
  for (let index = 0; index < 256; index++) {
    const directory = join(root, String(index))
    fs.mkdirSync(directory)
    const lease = await lock.acquireSuiteLock(options(directory))
    const writers = ['release', 'waiter', 'reaper', 'reclaim'].filter(() => random() < 0.65)
    for (let cursor = writers.length - 1; cursor > 0; cursor--) {
      const other = Math.floor(random() * (cursor + 1))
      ;[writers[cursor], writers[other]] = [writers[other], writers[cursor]]
    }
    coverage.add(writers.join(','))
    for (const writer of writers) await driveWriter(directory, lease, writer, random)
    const count = ends(directory, lease.holder.leaseId).length
    if (count !== (writers.length ? 1 : 0)) failures.push({ index, writers, count })
  }
  assert.ok(coverage.size > 40, 'seed must exercise varied subsets and orderings')
  assert.deepEqual(failures, [], 'property: all 256 seeded writer sequences must have exactly one terminal iff a writer ran')
}

async function crossProcessRace(root) {
  const leaseId = randomUUID()
  const source = `import{appendSuiteLockJournal}from ${JSON.stringify(new URL('lib/host/suite-lock-journal-append.mjs', bin).href)};
    process.on('message',()=>{appendSuiteLockJournal(${JSON.stringify(root)},{event:'abort',leaseId:${JSON.stringify(leaseId)}});process.disconnect()});process.send('ready')`
  const runs = await Promise.all([childRun(source), childRun(source)])
  try {
    await Promise.all(runs.map(({ ready, exited }) => Promise.race([ready, exited.then(() => { throw new Error('child exited before ready') })])))
    for (const { child } of runs) child.send('append')
    await Promise.all(runs.map(({ exited }) => exited))
    assert.equal(ends(root, leaseId).length, 1, 'race: simultaneous terminal appenders must produce exactly one line')
  } finally {
    for (const { child } of runs) if (child.exitCode === null) child.kill()
    await Promise.allSettled(runs.map(({ exited }) => exited))
  }
}

function invalidIds(root) {
  const invalid = ['../outside', '..\\outside', '', 'not-a-uuid', `../${randomUUID()}`, 42, null, {}]
  for (const leaseId of invalid) {
    journal.appendSuiteLockJournal(root, { event: 'abort', leaseId })
    journal.appendSuiteLockJournal(root, { event: 'abort', leaseId })
  }
  assert.equal(events(root).length, invalid.length * 2, 'invalid lease IDs must append without dedupe')
  assert.equal(fs.existsSync(join(root, 'terminal.d')), false, 'invalid IDs must never become paths')
}

function nonTerminals(root) {
  const leaseId = randomUUID().toUpperCase()
  for (const event of ['request', 'request', 'grant', 'grant', 'release', 'abort', 'timeout']) {
    journal.appendSuiteLockJournal(root, { event, leaseId })
  }
  assert.deepEqual(events(root).map((event) => event.event), ['request', 'request', 'grant', 'grant', 'release'])
  if (process.platform !== 'win32') assert.equal(fs.statSync(join(root, 'terminal.d', leaseId)).mode & 0o777, 0o600)
}

function claimFailure(root) {
  fs.writeFileSync(join(root, 'terminal.d'), 'not a directory')
  const leaseId = randomUUID()
  for (const event of ['abort', 'release']) assert.doesNotThrow(() => journal.appendSuiteLockJournal(root, { event, leaseId }))
  assert.equal(ends(root, leaseId).length, 2, 'failed marker creation must still append best-effort lines')
}

async function markerWriteFailure(root) {
  const fresh = await import(`${new URL('lib/host/suite-lock-journal-append.mjs', bin).href}?warning-test`)
  const leaseId = randomUUID()
  const write = fs.writeFileSync
  const stderr = process.stderr.write
  const warnings = []
  let failures = 0
  try {
    fs.writeFileSync = (file, ...args) => {
      if (file !== join(root, 'terminal.d', leaseId)) return write(file, ...args)
      failures++
      throw denied('EACCES')
    }
    process.stderr.write = (message) => { warnings.push(message); return true }
    syncBuiltinESMExports()
    for (const event of ['abort', 'release']) fresh.appendSuiteLockJournal(root, { event, leaseId })
  } finally { fs.writeFileSync = write; process.stderr.write = stderr; syncBuiltinESMExports() }
  assert.equal(failures, 2, 'fault must hit exclusive marker creation')
  assert.equal(ends(root, leaseId).length, 2, 'exclusive-create errors other than EEXIST must still append')
  assert.equal(warnings.length, 1, 'marker failure must use the existing warn-once path')
  assert.match(warnings[0], /journal unavailable \(EACCES\); event unknown; lock operation continues/)
}

function markerOrder(root) {
  const leaseId = randomUUID()
  const open = fs.openSync
  let witnessed = false
  try {
    fs.openSync = (file, ...args) => {
      if (file === join(root, 'journal.jsonl')) {
        witnessed = fs.existsSync(join(root, 'terminal.d', leaseId))
        throw denied('EACCES')
      }
      return open(file, ...args)
    }
    syncBuiltinESMExports()
    journal.appendSuiteLockJournal(root, { event: 'abort', leaseId })
  } finally { fs.openSync = open; syncBuiltinESMExports() }
  assert.equal(witnessed, true, 'exclusive marker must exist before opening the journal')
  journal.appendSuiteLockJournal(root, { event: 'release', leaseId })
  assert.deepEqual(events(root), [], 'failed append must retain its claim rather than retry another terminal')
}

function markerRetention(root) {
  const directory = join(root, 'terminal.d')
  fs.mkdirSync(directory)
  const old = join(directory, randomUUID())
  const recent = join(directory, randomUUID())
  for (const file of [old, recent]) fs.writeFileSync(file, '')
  const before = new Date(Date.now() - 86_400_001)
  fs.utimesSync(old, before, before)
  journal.appendSuiteLockJournal(root, { event: 'request' })
  assert.equal(fs.existsSync(old), true, 'ordinary appends must not prune markers')
  fs.writeFileSync(join(root, 'journal.jsonl'), 'x'.repeat(journal.SUITE_JOURNAL_ROTATE_BYTES + 1))
  journal.appendSuiteLockJournal(root, { event: 'request' })
  assert.equal(fs.existsSync(old), false, 'rotation must prune markers older than 24 hours')
  assert.equal(fs.existsSync(recent), true, 'rotation must retain recent markers')
}

export const terminalOnceCases = {
  'property over 256 seeded writer sequences': writerProperty,
  'cross-process exclusive-create race': crossProcessRace,
  'case A failed waiter ticket removal then reap': caseA,
  'case B unreadable ticket on release then reap': caseB,
  'untrusted lease IDs never become paths': invalidIds,
  'non-terminal events and uppercase UUIDs': nonTerminals,
  'marker creation failure preserves best-effort appends': claimFailure,
  'exclusive-create failure warns once and still appends': markerWriteFailure,
  'marker precedes the line and survives append failure': markerOrder,
  'marker retention runs only at rotation': markerRetention,
}
