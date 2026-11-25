import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from '../../../../test-support/bounded-hook-spawn.mjs'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSuiteLock, releaseSuiteLock } from '../../../../../plugin/bin/lib/suite-lock.mjs'
import { closeQueuedReplacement, replaceQueuedCommand } from '../../../../../plugin/bin/lib/host/suite-lock-replace.mjs'

const failure = (code) => Object.assign(new Error(`injected ${code}`), { code })
const denied = (code) => () => { throw failure(code) }

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'suite-replace-failure-'))
  const queueDir = join(root, 'queue.d')
  const record = { pid: process.pid, replaceToken: randomUUID(), argv: ['original'] }
  mkdirSync(queueDir)
  const ticketFile = join(queueDir, '0000000000000001.json')
  writeFileSync(ticketFile, JSON.stringify(record))
  const state = { queueDir, record }
  const slot = (n) => join(queueDir, `replace-${record.replaceToken}-${n}.json`)
  return Promise.resolve().then(() => run({ root, queueDir, record, ticketFile, state, slot }))
    .finally(() => rmSync(root, { recursive: true, force: true }))
}

async function admissionFailure(code, seam) {
  return fixture(async ({ root, queueDir }) => {
    rmSync(join(queueDir, '0000000000000001.json'))
    const messages = []
    const argv = [process.execPath, '-e', 'process.stdout.write("original");process.exit(17)']
    const lease = await acquireSuiteLock({ root, env: {}, argv, replaceable: true,
      replacementSeams: seam, onWait: (line) => messages.push(line) })
    try {
      const child = spawnSync(lease.replacementArgv[0], lease.replacementArgv.slice(1), { encoding: 'utf8' })
      assert.equal(child.stdout, 'original', 'closure failure must start the original command')
      assert.equal(child.status, 17)
      releaseSuiteLock(lease, { exit: child.status })
      const events = readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.deepEqual(events.map((event) => event.event), ['request', 'grant', 'release'])
      assert.equal(events.at(-1).exit, 17, 'closure failure must preserve the recorded outcome')
      assert.equal(messages.length, 1, 'closure failure must log exactly one reason line')
      assert.match(messages[0], new RegExp(`replacement.*${code}`, 'i'))
      assert.throws(() => replaceQueuedCommand(root, 1, ['late']), /not queued/)
    } finally { releaseSuiteLock(lease) }
  })
}

function collision(closed) {
  return fixture(({ root, slot, state }) => {
    let calls = 0
    const link = (temporary, destination) => {
      calls++
      if (calls === 1) {
        writeFileSync(destination, JSON.stringify(closed ? { closed: true } : { argv: ['competitor'] }))
        throw failure('EEXIST')
      }
      linkSync(temporary, destination)
    }
    if (closed) {
      assert.throws(() => replaceQueuedCommand(root, 1, ['B'], { link }), /already started/)
      assert.equal(calls, 1, 'collision must re-read the winning closure before advancing')
    } else {
      assert.equal(replaceQueuedCommand(root, 1, ['B'], { link }).revision, 2)
      assert.equal(calls, 2, 'collision must advance past the winning replacement')
      assert.deepEqual(JSON.parse(readFileSync(slot(1), 'utf8')).argv, ['competitor'])
      closeQueuedReplacement(state)
      assert.deepEqual(state.record.argv, ['B'])
    }
  })
}

export const replacementFailureScenarios = {
  ...Object.fromEntries(['EPERM', 'ENOTSUP'].flatMap((code) => [
    [`starts and records the original command when closure linking fails with ${code}`, () => admissionFailure(code, { link: denied(code) })],
    [`refuses replacement clearly without a slot when linking fails with ${code}`, () => fixture(({ root, queueDir }) => {
      assert.throws(() => replaceQueuedCommand(root, 1, ['B'], { link: denied(code) }), new RegExp(`cannot replace.*hard links.*${code}`))
      assert.equal(readdirSync(queueDir).filter((name) => name.startsWith('replace-')).length, 0)
    })],
  ])),
  'starts the original command when closure temporary creation is denied': () => admissionFailure('EACCES', { write: denied('EACCES') }),
  'cleanup failure after publication warns but succeeds and selects the replacement': () => fixture(({ root, state }) => {
    const warnings = []
    assert.equal(replaceQueuedCommand(root, 1, ['B'], { remove: denied('EPERM'), warn: (line) => warnings.push(line) }).revision, 1)
    assert.equal(warnings.length, 1, 'successful publication must warn about failed cleanup')
    assert.match(warnings[0], /cleanup.*EPERM/i)
    closeQueuedReplacement(state)
    assert.deepEqual(state.record.argv, ['B'])
  }),
  'refuses a ticket that disappears during publication and retains harmless history': () => fixture(({ root, ticketFile, slot }) => {
    const link = (temporary, destination) => { rmSync(ticketFile); linkSync(temporary, destination) }
    assert.throws(() => replaceQueuedCommand(root, 1, ['B'], { link }), /not queued.*stale/)
    assert.deepEqual(JSON.parse(readFileSync(slot(1), 'utf8')).argv, ['B'])
  }),
  'refuses an initially stale ticket': () => fixture(({ root, ticketFile, record }) => {
    writeFileSync(ticketFile, JSON.stringify({ ...record, pid: 2147483647 }))
    utimesSync(ticketFile, new Date(0), new Date(0))
    assert.throws(() => replaceQueuedCommand(root, 1, ['B']), /not queued.*stale/)
  }),
  're-reads a deterministic EEXIST winner and refuses closure': () => collision(true),
  're-reads a deterministic EEXIST winner and advances past a replacement': () => collision(false),
  'refuses malformed tokens including misplaced UUID separators': () => fixture(({ root, ticketFile, record }) => {
    for (const token of ['../bad', '-'.repeat(36), 'a'.repeat(36)]) {
      writeFileSync(ticketFile, JSON.stringify({ ...record, replaceToken: token }))
      assert.throws(() => replaceQueuedCommand(root, 1, ['B']), /replacement support/)
    }
  }),
}
