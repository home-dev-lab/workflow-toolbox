import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const bin = process.env.WT_OUTCOME_MODULE_ROOT
  ? pathToFileURL(`${process.env.WT_OUTCOME_MODULE_ROOT}/`)
  : new URL('../../../../plugin/bin/', import.meta.url)
const load = (name) => import(new URL(`lib/${name}.mjs`, bin).href)
const terminals = ['release', 'timeout', 'abort']
const event = (name, ms, leaseId = 'one') => ({ event: name, ts: new Date(ms).toISOString(), leaseId, kind: 'light' })
const terminalKinds = (ticket) => terminals.filter((kind) => ticket[kind])
const writeRecords = (root, name, records) => writeFileSync(join(root, name), records.map((record) => JSON.stringify(record)).join('\n') + '\n')

async function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'wt-outcome-'))
  try { await run(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

function assertTicket(result, first, holdS) {
  assert.equal(result.tickets.length, 1, 'the lease must be counted once')
  assert.deepEqual(terminalKinds(result.tickets[0]), [first], 'only the first terminal kind must be set')
  assert.equal(result.tickets[0][first].ts, new Date(3000).toISOString(), 'the first terminal record must survive')
  assert.equal(result.tickets[0].holdS, holdS, 'holdS must follow the first terminal')
  assert.equal(result.tickets[0].censored, false)
  assert.equal(result.summary.light.count, 1)
  assert.equal(result.summary.light.censored, 0)
  assert.equal(result.summary.light.hold.count, holdS === null ? 0 : 1)
  assert.equal(result.ignoredDuplicateTerminals, 1, 'one duplicate terminal must be counted')
}

async function readerPair(first, second, rotated = false) {
  const { readSuiteLockJournal } = await load('suite-lock-journal')
  await withRoot((root) => {
    const records = [event('request', 0), event('grant', 1000), event(first, 3000)]
    if (rotated) writeRecords(root, 'journal.1.jsonl', records)
    writeRecords(root, 'journal.jsonl', [...(rotated ? [] : records), event(second, 2000)])
    assertTicket(readSuiteLockJournal(root), first, first === 'release' ? 2 : null)
  })
}

async function readerWindow() {
  const { readSuiteLockJournal } = await load('suite-lock-journal')
  await withRoot((root) => {
    writeRecords(root, 'journal.jsonl', [event('request', 0), event('grant', 1000), event('abort', 3000), event('release', 2000)])
    const result = readSuiteLockJournal(root, { until: new Date(2500).toISOString() })
    assert.deepEqual(terminalKinds(result.tickets[0]), [], 'windowing must not promote a later appended terminal')
    assert.equal(result.tickets[0].holdS, null)
    assert.equal(result.censored, 1)
    assert.equal(result.ignoredDuplicateTerminals, 1)
    const excluded = readSuiteLockJournal(root, { since: new Date(1500).toISOString() })
    assert.equal(excluded.tickets.length, 0)
    assert.equal(excluded.ignoredDuplicateTerminals, 1, 'duplicate count covers the journal before windowing')
    writeFileSync(join(root, 'journal.jsonl'), '{torn\n' + JSON.stringify(event('abort', 0)) + '\nnull\n')
    const malformed = readSuiteLockJournal(root)
    assert.equal(malformed.invalidLines, 2, 'malformed lines must still be counted')
    assert.equal(malformed.ignoredDuplicateTerminals, 0)
  })
}

function randomFor(seed) {
  let state = seed
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 4294967296
  }
}

function interleaving(random) {
  const records = []
  for (let lease = 0; lease < 5; lease++) {
    for (const kind of ['request', 'grant', ...Array.from({ length: 1 + Math.floor(random() * 6) }, () => terminals[Math.floor(random() * 3)])]) {
      records.push(event(kind, Math.floor(random() * 10000), String(lease)))
    }
  }
  records.push({ event: 'abort' }, { event: 'release', leaseId: 1 }, { event: 'abort', leaseId: null }, { event: 'precedence' })
  for (let index = records.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[records[index], records[other]] = [records[other], records[index]]
  }
  return records
}

function checkInterleaving(firstTerminalPerLease, records, label) {
  const expected = records.filter((record, index) => typeof record?.leaseId !== 'string' || !terminals.includes(record.event)
    || !records.slice(0, index).some((prior) => prior?.leaseId === record.leaseId && terminals.includes(prior.event)))
  const result = firstTerminalPerLease(records)
  assert.deepEqual(result.records, expected, `${label}: first terminal and stable record order`)
  assert.equal(result.records.length + result.ignoredDuplicateTerminals, records.length, `${label}: kept plus dropped equals input`)
  for (const leaseId of new Set(records.filter((record) => typeof record?.leaseId === 'string').map((record) => record.leaseId))) {
    const input = records.filter((record) => record?.leaseId === leaseId && terminals.includes(record.event))
    const kept = result.records.filter((record) => record?.leaseId === leaseId && terminals.includes(record.event))
    assert.equal(kept.length, input.length ? 1 : 0, `${label}: one terminal per lease ${leaseId}`)
    assert.equal(kept[0], input[0], `${label}: first input terminal identity ${leaseId}`)
  }
  result.records.forEach((record, index) => assert.equal(record, expected[index], `${label}: retained record identity`))
}

async function property() {
  const { firstTerminalPerLease, SUITE_TERMINAL_EVENTS } = await load('suite-lock-terminal-outcome')
  assert.deepEqual([...SUITE_TERMINAL_EVENTS].sort(), [...terminals].sort())
  const seed = 0x51a7e123
  const random = randomFor(seed)
  for (let index = 0; index < 300; index++) {
    checkInterleaving(firstTerminalPerLease, interleaving(random), `seed=${seed} case=${index}`)
  }
  checkInterleaving(firstTerminalPerLease, [], `seed=${seed} empty`)
  checkInterleaving(firstTerminalPerLease, [null, undefined, 42, 'release', {}], `seed=${seed} records without lease`)
  checkInterleaving(firstTerminalPerLease, [event('abort', 0, ''), event('release', 1, '')], `seed=${seed} empty string lease`)
}

async function realWriters() {
  const lock = await load('suite-lock')
  const { suiteJournalEvent, readSuiteLockJournal } = await load('suite-lock-journal')
  const { reapSuiteTicket, journalReclaimedHolder } = await load('host/suite-lock-recovery')
  await withRoot(async (root) => {
    const lease = await lock.acquireSuiteLock({ root, env: { WT_SUITE_LOCK_STATIC_LANE: '0' } })
    lock.releaseSuiteLock(lease)
    suiteJournalEvent(lease.journal, 'abort', { cause: 'signal', signal: 'SIGTERM' })
    const dead = { ...lease.holder, pid: 2147483647 }
    writeFileSync(join(root, 'queue.d/0000000000000001.json'), JSON.stringify(dead))
    reapSuiteTicket(join(root, 'queue.d'), { number: 1, holder: dead })
    journalReclaimedHolder(dead, {})
    const lines = readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const ends = lines.filter((record) => record.leaseId === lease.holder.leaseId && terminals.includes(record.event))
    assert.deepEqual(ends.map((record) => record.event), ['release', 'abort', 'abort', 'release'], 'real writers must retain their terminal lines')
    assert.equal(ends[2].cause, 'client-gone')
    assert.equal(ends[3].cause, 'reclaimed')
    const result = readSuiteLockJournal(root)
    assert.deepEqual(terminalKinds(result.tickets[0]), ['release'], 'real writer journal must yield exactly one terminal outcome')
    assert.equal(result.ignoredDuplicateTerminals, ends.length - 1, 'real writer duplicates must equal terminal lines minus one')
    assert.equal(result.summary.exclusive.count, 1)
  })
}

export const outcomeCases = {
  'Lock A release then abort': () => readerPair('release', 'abort'),
  'Lock A abort then release': () => readerPair('abort', 'release'),
  'Lock A abort then abort': () => readerPair('abort', 'abort'),
  'Lock A timeout then release': () => readerPair('timeout', 'release'),
  'Lock A rotated generation first': () => readerPair('release', 'abort', true),
  'Lock A dedupe before window and preserve invalid lines': readerWindow,
  'Lock B seeded property (300 cases, seed=1369956643)': property,
  'Lock C real writers retain lines and reader keeps one outcome': realWriters,
}
