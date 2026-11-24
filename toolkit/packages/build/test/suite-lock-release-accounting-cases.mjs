import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const bin = process.env.WT_RELEASE_ACCOUNTING_MODULE_ROOT
  ? pathToFileURL(`${process.env.WT_RELEASE_ACCOUNTING_MODULE_ROOT}/`)
  : new URL('../../../../plugin/bin/', import.meta.url)
const lock = await import(new URL('lib/suite-lock.mjs', bin).href)
const rank = await import(new URL('lib/host/suite-lock-rank-state.mjs', bin).href)
const snapshot = (root) => rank.readSuiteLockRankState(root, [{ record: { project: 'alpha' } }])
const releases = (root) => fs.readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n')
  .map((line) => JSON.parse(line)).filter((event) => event.event === 'release')

function failTicketCleanup(root, run) {
  const original = fs.readdirSync
  const error = Object.assign(new Error('injected ticket cleanup failure'), { code: 'EINJECTED' })
  fs.readdirSync = function (directory, ...args) {
    if (String(directory) === join(root, 'queue.d')) throw error
    return Reflect.apply(original, this, [directory, ...args])
  }
  syncBuiltinESMExports()
  try { assert.throws(run, (actual) => actual === error) }
  finally { fs.readdirSync = original; syncBuiltinESMExports() }
}

export async function releasePutBackCase() {
  const root = fs.mkdtempSync(join(tmpdir(), 'suite-release-accounting-'))
  try { await checkPutBack(root) }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
}

async function checkPutBack(root) {
  const lease = await lock.acquireSuiteLock({ root, env: { WT_SUITE_LOCK_STATIC_LANE: '0' }, project: 'alpha', size: 'S' })
  const outcome = { served: true, heldMs: 600_001, exit: 0 }
  failTicketCleanup(root, () => lock.releaseSuiteLock(lease, outcome))
  assert.equal(lock.readSuiteLock({ root }).holder.leaseId, lease.holder.leaseId, 'cleanup failure must put the judged holder back')
  assert.equal(releases(root).length, 0, 'put-back must not journal a release')
  assert.deepEqual(snapshot(root).turns, { alpha: 1 }, 'service must publish before the mutex is set aside')
  const history = snapshot(root).history
  failTicketCleanup(root, () => lock.releaseSuiteLock({ ...lease }, outcome))
  assert.deepEqual(snapshot(root).turns, { alpha: 1 }, 'a put-back retry must not stamp a second project turn')
  assert.deepEqual(snapshot(root).history, history, 'retry must preserve the first service sample')
  assert.equal(releases(root).length, 0)
  assert.equal(lock.releaseSuiteLock(lease, outcome), true)
  assert.equal(lock.readSuiteLock({ root }).held, false)
  assert.deepEqual(snapshot(root).turns, { alpha: 1 }, 'successful retry must consume exactly one project turn')
  assert.deepEqual(snapshot(root).history, history)
  assert.equal(releases(root).length, 1, 'successful retry must journal exactly one release')
  lock.releaseSuiteLock(lease, outcome)
  assert.equal(releases(root).length, 1)
}
