import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import tseslint from 'typescript-eslint'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'suite-admission-process-'))
const source = process.env.WT_ADMISSION_BIN ?? path.resolve(import.meta.dirname, '../../plugin/bin')
cpSync(source, path.join(scratch, 'bin'), { recursive: true })
mkdirSync(path.join(scratch, '.claude-plugin'))
cpSync(path.join(source, '../.claude-plugin/plugin.json'), path.join(scratch, '.claude-plugin/plugin.json'))
if (process.env.WT_ADMISSION_RECOVERY_MUTATION === '1') {
  const file = path.join(scratch, 'bin/lib/suite-lock.mjs')
  const before = readFileSync(file, 'utf8')
  const reaper = `  for (const root of [state.root, staticLeaseRoot(state.root)]) {
    const current = readSuiteLock({ root })
    if (headReclaimed(place, current, root, current.lockDir, options)) return { again: true, place }
  }
`
  assert.ok(before.includes(reaper), 'recovery mutation must remove the actual managed reaper branch')
  writeFileSync(file, before.replace(reaper, ''))
}
const lib = pathToFileURL(path.join(scratch, 'bin/lib/suite-lock.mjs')).href
const { acquireSuiteLock: acquireRealSuiteLock, releaseSuiteLock, suiteLeaseMarker, readSuiteLock, readSuiteLockStatus } = await import(lib)
// Policy fixtures train on controlled successful samples, not this test runner's
// incidental process tree (an incomplete success correctly revokes sharing).
const acquireSuiteLock = (options) => acquireRealSuiteLock({ ...options,
  resourceSampler: () => ({ stop: () => ({ peakCores: 1, peakMemMiB: 100, wallMs: 1000, unknownReasons: [] }) }) })
const { formatSuiteLockStatus, suiteLockStatusJson } = await import(pathToFileURL(path.join(scratch, 'bin/lib/suite-lock-status.mjs')))
const { replaceQueuedCommand } = await import(pathToFileURL(path.join(scratch, 'bin/lib/host/suite-lock-replace.mjs')))
const { readQueueSnapshot } = await import(pathToFileURL(path.join(scratch, 'bin/lib/host/suite-lock-queue.mjs')))
const { currentPidNamespace } = await import(pathToFileURL(path.join(scratch, 'bin/lib/host/pid-namespace.mjs')))
const { setSuiteLockPrecedence } = await import(pathToFileURL(path.join(scratch, 'bin/lib/host/suite-lock-rank-state.mjs')))
const { suiteJournalEvent, readSuiteLockJournal } = await import(pathToFileURL(path.join(scratch, 'bin/lib/suite-lock-journal.mjs')))
const reservations = await import(pathToFileURL(path.join(scratch, 'bin/lib/host/suite-lock-reservations.mjs'))).catch(() => ({}))
const machine = { cores: 4, memMiB: 4096, load: 0, loadLimit: 4, availableMiB: 8192, floorMiB: 1024 }
// Real children and groups, deterministic host readings in this OS-temp copy.
writeFileSync(path.join(scratch, 'bin/lib/host/suite-lock-machine.mjs'),
  `import fs from 'node:fs';
export function readSuiteMachine() {
  try { return JSON.parse(fs.readFileSync(process.env.WT_SUITE_LOCK_DIR + '/machine.json', 'utf8')) } catch { return ${JSON.stringify(machine)} }
}
export const reservationHostSupported = (platform = process.platform) => ['linux', 'darwin'].includes(platform)
export const isWsl = () => false
export const startWindowsMemoryReader = () => { throw new Error('unexpected Windows reader in fixture') }\n`)
const children = new Set()
after(() => { for (const child of children) child.kill('SIGKILL'); rmSync(scratch, { recursive: true, force: true }) })
const pause = () => new Promise((resolve) => setTimeout(resolve, 20))
const reservationTest = (name, fn) => test(name, { skip: process.platform === 'win32' }, fn)

async function until(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (check()) return; await pause() }
  assert.fail(message)
}

function history(root, cores = 1, memMiB = 100) {
  mkdirSync(root, { recursive: true })
  const rows = [0, 1, 2].map((number) => ({ leaseId: `history-${number}`, kind: 'exclusive', cmd: 'other', jobClass: 'fixture', event: 'release',
    ts: new Date().toISOString(), exit: 0, overlaps: [], resources: { peakCores: cores, peakMemMiB: memMiB,
      wallMs: 1000, unknownReasons: [] } }))
  writeFileSync(path.join(root, 'journal.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  warmSupervisor(root)
}

// Sharing assertions need a fresh supervisor: round-five cold starts grant exclusively.
function warmSupervisor(root) {
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'admission-reservation.enabled'), '')
  const generation = `${path.basename(root)}-supervised`
  const child = spawn(process.execPath, [path.join(scratch, 'bin/lib/host/suite-lock-watchdog.mjs'), root, generation],
    { stdio: 'ignore' })
  children.add(child)
  writeFileSync(path.join(root, 'reservations.json'), JSON.stringify({ version: 1, generation, holders: [], bypasses: {},
    createdAt: Date.now(), watchdog: { pid: child.pid, pidNamespace: currentPidNamespace(), heartbeat: 0 } }))
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (reservations.readReservationState(root).watchdog.heartbeat > 0) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
  assert.fail('fixture watchdog must be warm before testing shared admission')
}

function legacyHead(root, queued, acquired, release) {
  const script = `import fs from 'node:fs';
const { acquireSuiteLock, releaseSuiteLock } = await import(${JSON.stringify(lib)});
const lease = await acquireSuiteLock({root:${JSON.stringify(root)},priority:'P0',waitS:5,staleS:5,pollMs:10,argv:['fixture'],env:{},onQueuePlace:()=>fs.writeFileSync(${JSON.stringify(queued)},'queued')});
fs.writeFileSync(${JSON.stringify(acquired)},'acquired');
await new Promise(resolve=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);resolve()}},10)});
releaseSuiteLock(lease,{exit:0});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' })
  children.add(child)
  return { child, ended: new Promise((resolve) => child.once('exit', resolve)) }
}

function injectStopError(trigger) {
  const file = path.join(scratch, 'bin/lib/host/suite-lock-host.mjs')
  const before = readFileSync(file, 'utf8')
  const ast = tseslint.parser.parseForESLint(before, { sourceType: 'module', range: true }).ast
  const name = trigger === 'signal' ? 'signalCoveredCommand' : 'stopCoveredCommandTree'
  const declaration = ast.body.find((node) => node.declaration?.id?.name === name).declaration
  const finish = trigger === 'signal'
    ? "setTimeout(()=>child.kill('SIGKILL'),100);return false;"
    : "return new Promise(resolve=>setTimeout(()=>{child.kill('SIGKILL');resolve(false)},100));"
  const replacement = `function ${name}(child) {
child.emit('error', Object.assign(new Error('injected stop failure'), {code:'EPERM'}));
${finish}
}`
  writeFileSync(file, before.slice(0, declaration.range[0]) + replacement + before.slice(declaration.range[1]))
  return () => writeFileSync(file, before)
}

test('a large overlap family still publishes one terminal without a job-count cap', () => {
  const root = path.join(scratch, 'many-overlaps')
  mkdirSync(root)
  const overlaps = Array.from({ length: 200 }, (_, i) => ({ leaseId: `overlapping-lease-${i}`, durationMs: i + 0.12345 }))
  suiteJournalEvent({ base: { root, leaseId: 'many', kind: 'exclusive', cmd: 'other' } }, 'release', {
    exit: 0, reservation: { cores: 1, memMiB: 1, mode: 'reservation' }, overlaps,
  })
  const [row] = readSuiteLockJournal(root).tickets
  assert.equal(row?.release?.overlaps.length, 200, 'every overlapped lease must survive terminal publication')
})

reservationTest('unavailable advisory journal keeps declared admission and release working', () => {
  const root = path.join(scratch, 'journal-unavailable')
  mkdirSync(path.join(root, 'lock.d'), { recursive: true })
  mkdirSync(path.join(root, 'queue.d'))
  const record = { pid: process.pid, leaseId: 'no-journal', level: 1, levelOrderVersion: 4, project: 'p', argv: ['fixture'], reservationProtocol: 1 }
  writeFileSync(path.join(root, 'queue.d/0000000000000001.json'), JSON.stringify(record))
  writeFileSync(path.join(root, 'lock.d/holder.json'), JSON.stringify({ reservationProtocol: 1, leaseId: 'g', pid: 1 }))
  writeFileSync(path.join(root, 'reservations.json'), JSON.stringify({ version: 1, generation: 'g', holders: [], bypasses: {},
    createdAt: Date.now(), watchdog: { pid: process.pid, startTime: null, heartbeat: Date.now() } }))
  const waiting = { root, lockDir: path.join(root, 'lock.d'), queueDir: path.join(root, 'queue.d'), ticket: 1, record }
  const lease = reservations.pollReservationLease(waiting, record, { readMachine: () => machine })
  assert.equal(lease?.holder.reservation.mode, 'exclusive', 'journal unavailability must fall back to declared exclusive admission')
  assert.equal(releaseSuiteLock(lease, { exit: 0 }), true)
  assert.equal(reservations.readReservationState(root).holders.length, 0)
})

reservationTest('resource history follows completion append order rather than request or wall-clock order', async () => {
  const root = path.join(scratch, 'completion-order')
  mkdirSync(root)
  const row = (leaseId, event, cores = 1) => ({ leaseId, kind: 'exclusive', cmd: 'other', jobClass: 'fixture', event,
    ts: new Date(event === 'release' && leaseId === 'long' ? 500 : 1000).toISOString(), exit: 0, overlaps: [],
    resources: { peakCores: cores, peakMemMiB: 100, wallMs: 1000, unknownReasons: [] } })
  const rows = [row('long', 'request'), ...Array.from({ length: 10 }, (_, i) => row(`short-${i}`, 'request')),
    ...Array.from({ length: 10 }, (_, i) => row(`short-${i}`, 'release')), row('long', 'release', 2)]
  writeFileSync(path.join(root, 'journal.jsonl'), rows.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  warmSupervisor(root)
  const lease = await acquireSuiteLock({ root, reservation: true, jobClass: 'fixture', readMachine: () => machine,
    waitS: 2, pollMs: 10, argv: ['fixture'], env: {} })
  try {
    assert.equal(lease.holder.reservation.cores, 2.5, 'the newest completed peak must survive the ten-run window')
  } finally { releaseSuiteLock(lease, { exit: 0 }) }
})

reservationTest('third non-fitting lease waits; load overload requests no stop', async () => {
  const root = path.join(scratch, 'fit')
  history(root)
  const controller = new AbortController()
  const budget = { ...machine, cores: 2.6 }
  const options = { root, reservation: true, jobClass: 'fixture', readMachine: () => budget, waitS: 2, pollMs: 10, argv: ['fixture'], env: {} }
  const one = await acquireSuiteLock(options)
  const two = await acquireSuiteLock(options)
  let third
  let observed = false
  const pending = acquireSuiteLock({ ...options, signal: controller.signal, onWait: () => { observed = true } })
    .then((lease) => { third = lease }, (error) => { assert.equal(error.code, 'ABORT_ERR') })
  try {
    await until(() => observed, 'non-fitting ticket must queue')
    assert.equal(third, undefined)
    budget.load = 10
    releaseSuiteLock(two, { exit: 0 })
    await pause()
    assert.equal(third, undefined, 'CPU overload must keep the now-fitting third ticket waiting')
    assert.equal(reservations.reservationStopReason(one), null, 'CPU overload never stops a holder')
  } finally { controller.abort(); await pending; releaseSuiteLock(one); releaseSuiteLock(two); if (third) releaseSuiteLock(third) }
})

reservationTest('legacy API holder never overlaps reservation holders', async () => {
  const root = path.join(scratch, 'legacy')
  history(root)
  const options = { root, reservation: true, jobClass: 'fixture', readMachine: () => machine, waitS: 2, pollMs: 10, argv: ['fixture'], env: {} }
  const one = await acquireSuiteLock(options)
  assert.equal(one.reservationLease, true, 'fixture must exercise a reservation fence')
  let old
  let observed = false
  const waiting = acquireSuiteLock({ ...options, reservation: false, onWait: () => { observed = true } }).then((lease) => { old = lease })
  try {
    await until(() => observed, 'exclusive client must wait behind reservation fence')
    assert.equal(old, undefined)
    releaseSuiteLock(one, { exit: 0 })
    await waiting
    assert.equal(old.reservationLease, undefined)
  } finally { releaseSuiteLock(one); await waiting; if (old) releaseSuiteLock(old) }
})

reservationTest('a lower-ranked warming client cannot fence a higher-ranked legacy head', async () => {
  const root = path.join(scratch, 'legacy-head')
  history(root)
  const queued = path.join(scratch, 'head-queued')
  const acquired = path.join(scratch, 'head-acquired')
  const release = path.join(scratch, 'head-release')
  const blocker = await acquireSuiteLock({ root, argv: ['fixture'], env: {} })
  const head = legacyHead(root, queued, acquired, release)
  let managed
  let pending
  let polls = 0
  try {
    await until(() => { try { return readFileSync(queued, 'utf8') === 'queued' } catch { return false } }, 'legacy head must queue')
    head.child.kill('SIGSTOP')
    pending = acquireSuiteLock({ root, reservation: true, jobClass: 'fixture', priority: 'P2', readMachine: () => machine,
      pollMs: 10, argv: ['fixture'], env: {}, onQueuePlace: () => { polls++ } }).then((lease) => { managed = lease })
    releaseSuiteLock(blocker, { exit: 0 })
    await until(() => polls >= 3, 'warming client must poll the ranked queue')
    assert.equal(readSuiteLock({ root }).held, false, 'a warming client must not fence an eligible legacy head')
    assert.equal(readSuiteLock({ root: path.join(root, 'static-lane') }).held, false)
    head.child.kill('SIGCONT')
    await until(() => { try { return readFileSync(acquired, 'utf8') === 'acquired' } catch { return false } }, 'legacy head must start first')
    writeFileSync(release, 'release')
    assert.equal(await head.ended, 0)
  } finally {
    releaseSuiteLock(blocker)
    head.child.kill('SIGCONT'); head.child.kill('SIGTERM')
    await head.ended; children.delete(head.child)
    await pending
    if (managed) releaseSuiteLock(managed)
  }
})

reservationTest('a legacy static holder drains before reservation admission', async () => {
  const root = path.join(scratch, 'static-first')
  history(root)
  const options = { root, jobClass: 'fixture', readMachine: () => machine, waitS: 2, pollMs: 10, argv: ['fixture'], env: {} }
  const legacy = await acquireSuiteLock({ ...options, static: true })
  let managed
  let polls = 0
  const pending = acquireSuiteLock({ ...options, reservation: true, onQueuePlace: () => { polls++ } })
    .then((lease) => { managed = lease })
  try {
    await until(() => managed || polls >= 3, 'reservation candidate must inspect the static compatibility holder')
    assert.equal(managed, undefined, 'legacy static work must never overlap reservation holders')
    releaseSuiteLock(legacy, { exit: 0 })
    await pending
    assert.equal(managed.reservationLease, true)
  } finally { releaseSuiteLock(legacy); await pending; if (managed) releaseSuiteLock(managed) }
})

reservationTest('reservation rank uses the same injected precedence clock as the existing queue', async () => {
  const root = path.join(scratch, 'precedence-clock')
  history(root)
  setSuiteLockPrecedence(root, { project: 'favored', until: new Date(2000).toISOString(), source: 'fixture' })
  const seen = new Set()
  const order = []
  const held = []
  const budget = { ...machine, load: 99 }
  const launch = (project, priority) => acquireSuiteLock({ root, reservation: true, jobClass: 'fixture', readMachine: () => budget,
    now: () => 1000, project, priority, size: 'L', pollMs: 10, argv: ['fixture'], env: {},
    onQueuePlace: () => seen.add(project) }).then((lease) => { order.push(project); held.push(lease) })
  const pending = [launch('favored', 'P2'), launch('ordinary', 'P0')]
  try {
    await until(() => seen.size === 2, 'both ranked candidates must queue under overload')
    budget.load = 0
    await Promise.all(pending)
    assert.deepEqual(order, ['favored', 'ordinary'], 'reservation admission must preserve precedence under the injected clock')
  } finally { for (const lease of held) releaseSuiteLock(lease, { exit: 0 }) }
})

reservationTest('reservation holders fence newly arriving legacy static work', async () => {
  const root = path.join(scratch, 'static-last')
  history(root)
  const options = { root, jobClass: 'fixture', readMachine: () => machine, waitS: 2, pollMs: 10, argv: ['fixture'], env: {} }
  const managed = await acquireSuiteLock({ ...options, reservation: true })
  let legacy
  let polls = 0
  const pending = acquireSuiteLock({ ...options, static: true, onQueuePlace: () => { polls++ } })
    .then((lease) => { legacy = lease })
  try {
    await until(() => legacy || polls >= 3, 'static candidate must inspect the compatibility fence')
    assert.equal(legacy, undefined, 'static admission must be excluded in the reverse direction too')
    releaseSuiteLock(managed, { exit: 0 })
    await pending
  } finally { releaseSuiteLock(managed); await pending; if (legacy) releaseSuiteLock(legacy) }
})

reservationTest('a static ancestor can still run its legacy main-queue child', async () => {
  const root = path.join(scratch, 'static-nested')
  history(root)
  const parent = await acquireSuiteLock({ root, static: true, argv: ['fixture'], env: {} })
  const marker = path.join(scratch, 'static-child')
  const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'done')`
  const child = spawn(process.execPath, [path.join(scratch, 'bin/wt-suite-lock.mjs'), 'run', '--', process.execPath, '-e', script], {
    env: { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LEASE: suiteLeaseMarker(parent), WT_SUITE_LOCK_BROKER: '', WT_SUITE_LOCK: '1' }, stdio: 'ignore',
  })
  children.add(child)
  const ended = new Promise((resolve) => child.once('exit', resolve))
  try {
    await until(() => child.exitCode !== null, 'a legacy static ancestor must not deadlock its main-queue child')
    assert.equal(await ended, 0)
    assert.equal(readFileSync(marker, 'utf8'), 'done')
  } finally {
    releaseSuiteLock(parent)
    if (children.has(child)) { child.kill('SIGTERM'); await ended; children.delete(child) }
  }
})

for (const domain of ['main', 'static']) reservationTest(`a dead legacy ${domain} holder is reclaimed before reservations`, async () => {
  const root = path.join(scratch, `dead-${domain}`)
  history(root)
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('exit', resolve))
  const lockDir = path.join(root, domain === 'static' ? 'static-lane/lock.d' : 'lock.d')
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(path.join(lockDir, 'holder.json'), JSON.stringify({ pid: child.pid, startTime: null,
    pidNamespace: currentPidNamespace(), startedAt: new Date().toISOString(), leaseId: `dead-${domain}`, argv: ['fixture'] }))
  const lease = await acquireSuiteLock({ root, reservation: true, jobClass: 'fixture', readMachine: () => machine, waitS: 5, staleS: 5,
    pollMs: 10, argv: ['fixture'], env: {} })
  try {
    assert.equal(lease.reservationLease, true, 'a proven dead legacy holder must not strand the new queue')
    assert.notEqual(JSON.parse(readFileSync(path.join(lockDir, 'holder.json'), 'utf8')).leaseId, `dead-${domain}`,
      'the stale compatibility holder must actually be reclaimed')
  }
  finally { releaseSuiteLock(lease, { exit: 0 }) }
})

reservationTest('replacing a queued command retains its explicit class footprint whatever the argv', async () => {
  const root = path.join(scratch, 'replace')
  history(root)
  const options = { root, reservation: true, jobClass: 'fixture', readMachine: () => machine, waitS: 2, pollMs: 10, argv: ['fixture'], env: {} }
  const one = await acquireSuiteLock(options)
  let load = 99
  let polls = 0
  let two
  const pending = acquireSuiteLock({ ...options, replaceable: true, readMachine: () => { polls++; return { ...machine, load } } })
    .then((lease) => { two = lease })
  try {
    await until(() => polls > 0, 'replacement candidate must queue')
    const [queued] = readQueueSnapshot(path.join(root, 'queue.d'))
    assert.equal(queued.holder.journal?.cmd, 'other', 'replacement fixture starts in the other argv category')
    replaceQueuedCommand(root, queued.number, ['test'])
    load = 0
    const before = polls
    await until(() => two || polls > before + 2, 'explicit class footprint must be checked')
    assert.equal(polls - before, 2, 'replacement must use class history on the first fitting poll, not repair an argv-keyed decision on a later poll')
    assert.ok(two, 'replacement must share using its class history despite a different argv category')
    await pending
    assert.deepEqual(two.replacementArgv, ['test'], 'execute the accepted replacement')
    assert.equal(two.holder.reservation.mode, 'reservation')
    assert.equal(two.holder.jobClass, 'fixture')
    assert.equal(two.holder.reservation.cores, 1.25)
    assert.equal(two.record.journal.cmd, 'test', 'replacement must exercise the changed-category history lookup')
  } finally { releaseSuiteLock(one); await pending; if (two) releaseSuiteLock(two) }
})

reservationTest('concurrent API leases each publish exactly one terminal and symmetric overlap', async () => {
  const root = path.join(scratch, 'terminal')
  history(root)
  const options = { root, reservation: true, jobClass: 'fixture', readMachine: () => machine, waitS: 2, pollMs: 10,
    argv: ['fixture'], env: { WT_SUITE_LOCK_PRIORITY: 'P1' } }
  const one = await acquireSuiteLock(options)
  let two
  const waiting = acquireSuiteLock(options).then((lease) => { two = lease })
  try {
    await until(() => two, 'a second fitting reservation must acquire while the first holds')
    await pause()
    releaseSuiteLock(one, { exit: 0, served: true })
    releaseSuiteLock(one, { exit: 0, served: true })
    releaseSuiteLock(two, { exit: 0, served: true })
    const rows = readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    for (const lease of [one, two]) {
      const ends = rows.filter((row) => row.leaseId === lease.holder.leaseId && row.event === 'release')
      assert.equal(ends.length, 1, 'one terminal per concurrent lease')
      assert.equal(ends[0].overlaps.length, 1)
      assert.ok(ends[0].overlaps[0].durationMs > 0)
    }
  } finally { releaseSuiteLock(one); await waiting; if (two) releaseSuiteLock(two) }
})

reservationTest('watchdog stop is serialized and requeue preserves original ticket and rank', async () => {
  assert.equal(typeof reservations.watchReservationMemory, 'function', 'watchdog transaction seam exists')
  const root = path.join(scratch, 'watchdog')
  history(root)
  const options = { root, reservation: true, jobClass: 'fixture', readMachine: () => machine, waitS: 2, pollMs: 10, argv: ['fixture'],
    priority: 'P2', size: 'L', env: {} }
  const one = await acquireSuiteLock(options)
  const two = await acquireSuiteLock(options)
  try {
    reservations.watchReservationMemory(root, { ...machine, availableMiB: 0 })
    reservations.watchReservationMemory(root, { ...machine, availableMiB: 0 })
    const state = reservations.readReservationState(root)
    assert.equal(state.holders.filter((holder) => holder.stop).length, 1, 'one outstanding stop')
    assert.equal(state.holders.find((holder) => holder.stop).leaseId, two.holder.leaseId)
    releaseSuiteLock(two, { exit: 75, served: false, requeue: true })
    const [retry] = readQueueSnapshot(path.join(root, 'queue.d'))
    assert.equal(retry?.number, two.ticket, 'retry ticket must exist before freed capacity is observable')
    assert.equal(retry.holder.level, two.record.level)
    assert.equal(retry.holder.startedAt, two.record.startedAt)
    assert.equal(retry.holder.lightGrantsAtQueue, two.record.lightGrantsAtQueue)
    assert.equal(retry.holder.p0GrantsAtQueue, two.record.p0GrantsAtQueue)
    assert.equal(retry.holder.memoryRetries, 1)
    assert.notEqual(retry.holder.leaseId, two.holder.leaseId)
    releaseSuiteLock(one, { exit: 0 })
    const again = await acquireSuiteLock({ ...options, priority: 'P0', light: true, project: 'different', size: 'S', requeue: two })
    try {
      assert.equal(again.ticket, two.ticket, 'requeue keeps original ticket')
      assert.equal(again.holder.level, 2, 'requeue keeps original priority')
      assert.equal(again.record.light, two.record.light, 'requeue must not inherit a newly requested light class')
      assert.equal(again.record.project, two.record.project)
      assert.equal(again.record.size, two.record.size)
      assert.notEqual(again.holder.leaseId, two.holder.leaseId, 'new attempt has its own terminal identity')
    } finally { releaseSuiteLock(again, { exit: 0 }) }
    const rows = readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const stopped = rows.filter((row) => row.leaseId === two.holder.leaseId && row.event === 'release')
    assert.equal(stopped.length, 1)
    assert.equal(stopped[0].cause, 'memory-pressure')
  } finally { releaseSuiteLock(one); releaseSuiteLock(two) }
})

reservationTest('a released memory victim keeps its place ahead of an already polling peer', async () => {
  const root = path.join(scratch, 'retry-place')
  history(root)
  const options = { root, reservation: true, jobClass: 'fixture', readMachine: () => ({ ...machine, cores: 2.5 }),
    waitS: 5, pollMs: 10, argv: ['fixture'], priority: 'P2', project: 'same', env: {} }
  const keeper = await acquireSuiteLock(options)
  const victim = await acquireSuiteLock(options)
  let peer
  let polls = 0
  const pending = acquireSuiteLock({ ...options, onQueuePlace: () => { polls++ } }).then((lease) => { peer = lease })
  let retry
  try {
    await until(() => polls > 0, 'peer must already be polling')
    reservations.watchReservationMemory(root, { ...machine, availableMiB: 0 })
    releaseSuiteLock(victim, { exit: 75, served: false, requeue: true })
    const before = polls
    await until(() => peer || polls > before + 2, 'peer must observe the released capacity')
    assert.equal(peer, undefined, 'a polling peer must not steal the memory retry position')
    retry = await acquireSuiteLock({ ...options, requeue: victim })
    assert.equal(retry.ticket, victim.ticket)
    releaseSuiteLock(retry, { exit: 0 })
    await pending
    assert.ok(peer.ticket > retry.ticket)
  } finally { releaseSuiteLock(keeper); releaseSuiteLock(victim); if (retry) releaseSuiteLock(retry); await pending; if (peer) releaseSuiteLock(peer) }
})

reservationTest('memory retry preserves populated light size and explicit class against conflicting inputs', async () => {
  const root = path.join(scratch, 'populated-retry')
  history(root)
  const options = { root, reservation: true, jobClass: 'fixture', light: true, size: 'M',
    readMachine: () => machine, waitS: 2, pollMs: 10, argv: ['fixture'], env: {} }
  const victim = await acquireSuiteLock(options)
  let again
  try {
    for (const record of [victim.record, reservations.readReservationState(root).holders[0]]) {
      assert.equal(Object.hasOwn(record, 'light'), true, 'light metadata must be populated before the stop')
      assert.equal(Object.hasOwn(record, 'size'), true, 'size metadata must be populated before the stop')
      assert.equal(record.light, true)
      assert.equal(record.size, 'M')
      assert.equal(record.jobClass, 'fixture')
    }
    reservations.watchReservationMemory(root, { ...machine, availableMiB: 0 })
    releaseSuiteLock(victim, { exit: 75, served: false, requeue: true })
    again = await acquireSuiteLock({ ...options, light: false, size: 'S', jobClass: 'conflicting', requeue: victim })
    assert.equal(again.ticket, victim.ticket)
    for (const record of [again.record, again.holder]) {
      assert.equal(record.light, true, 'resumed record retains its explicit light metadata')
      assert.equal(record.size, 'M', 'resumed record retains its explicit non-default size')
      assert.equal(record.jobClass, 'fixture', 'resumed record retains its workload identity')
    }
  } finally { releaseSuiteLock(victim); if (again) releaseSuiteLock(again, { exit: 0 }) }
})

reservationTest('thirty-three measured heavy leases fit without a holder-count cap', async () => {
  const root = path.join(scratch, 'many-holders')
  history(root)
  const count = 33
  const held = []
  try {
    for (let i = 0; i < count; i++) held.push(await acquireSuiteLock({ root, reservation: true, jobClass: 'fixture',
      readMachine: () => ({ ...machine, cores: count * 1.25, memMiB: count * 125 }),
      waitS: 5, pollMs: 10, argv: ['fixture'], env: {} }))
    assert.equal(reservations.readReservationState(root).holders.length, count,
      'resource fit, not a fixed number of jobs, must determine concurrent holders')
  } finally { for (const lease of held) releaseSuiteLock(lease, { exit: 0 }) }
})

for (const sensitive of [false, true]) reservationTest(`same-name light jobs use history, not their name: sensitive=${sensitive}`, async () => {
  const root = path.join(scratch, `sensitivity-${sensitive}`)
  if (!sensitive) warmSupervisor(root)
  if (sensitive) {
    history(root)
    const rows = readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    rows[1].exit = 1
    rows[1].overlaps = [{ leaseId: 'concurrent', durationMs: 1 }]
    writeFileSync(path.join(root, 'journal.jsonl'), rows.map(JSON.stringify).join('\n') + '\n')
  }
  const options = { root, reservation: true, jobClass: 'fixture', light: true, readMachine: () => machine,
    waitS: 5, pollMs: 10, argv: ['fixture'], env: {} }
  const first = await acquireSuiteLock(options)
  let second
  let polls = 0
  const pending = acquireSuiteLock({ ...options, onQueuePlace: () => { polls++ } }).then((lease) => { second = lease })
  try {
    await until(() => second || polls > 2, 'second same-name ticket must be inspected')
    assert.equal(first.holder.reservation.mode, 'exclusive')
    assert.equal(first.holder.reservation.basis, sensitive ? 'timing-history' : 'declared')
    assert.equal(second, undefined, 'both unmeasured and timing-sensitive light jobs must stay exclusive')
    releaseSuiteLock(first, { exit: 0 })
    await pending
  } finally { releaseSuiteLock(first); await pending; if (second) releaseSuiteLock(second) }
})

reservationTest('queue status exposes the same full-precision reservation used by admission', async () => {
  const root = path.join(scratch, 'queue-reservations')
  history(root, 1.00000001, 100.00000001)
  const budget = { ...machine, load: 99 }
  const controller = new AbortController()
  let polls = 0
  const pending = acquireSuiteLock({ root, reservation: true, jobClass: 'fixture', readMachine: () => budget, light: false,
    signal: controller.signal, pollMs: 10, argv: ['fixture'], env: {}, onQueuePlace: () => { polls++ } })
    .catch((error) => assert.equal(error.code, 'ABORT_ERR'))
  try {
    await until(() => polls > 1, 'resource waiter must queue')
    const state = readSuiteLockStatus({ root })
    assert.deepEqual(state.queue[0].reservation, { mode: 'reservation', cores: 1.00000001 * 1.25, memMiB: 100.00000001 * 1.25, basis: 'measured' },
      'every queued managed job must show its admission reservation')
    assert.deepEqual(suiteLockStatusJson(state).queue[0].reservation, state.queue[0].reservation)
    const text = formatSuiteLockStatus(state, 'fixture')
    assert.match(text, /reservation 1\.25 cores, 125\.00 MiB \(measured\)/)
    assert.match(text, /P[012] reserved,/, 'a shareable heavy waiter must not be labelled exclusive')
  } finally { controller.abort(); await pending }
})

function managedChild(root, script) {
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'admission-reservation.enabled'), '')
  const child = spawn(process.execPath, [path.join(scratch, 'bin/wt-suite-lock.mjs'), 'run', '--job-class', 'fixture', '--', process.execPath, '-e', script], {
    env: { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LEASE: '', WT_SUITE_LOCK_BROKER: '', WT_SUITE_LOCK: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  children.add(child)
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  return { child, stderr: () => stderr, ended: new Promise((resolve) => child.once('exit', resolve)) }
}

async function finishManaged(run) {
  if (run.child.exitCode === null) run.child.kill('SIGTERM')
  await run.ended
  children.delete(run.child)
}

reservationTest('a job that repeatedly exceeds memory alone ends after three requeues', async () => {
  const root = path.join(scratch, 'bounded-retry')
  history(root)
  const marker = path.join(root, 'attempts')
  const script = `const fs=require('fs'),p=${JSON.stringify(marker)};fs.writeFileSync(p,String(Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1));setInterval(()=>{},1000)`
  const run = managedChild(root, script)
  try {
    for (let attempt = 1; attempt <= 4; attempt++) {
      await until(() => { try { return readFileSync(marker, 'utf8') === String(attempt) } catch { return false } }, 'bounded attempt must start')
      assert.equal(reservations.readReservationState(root).holders.length, 1)
      await until(() => Date.now() - (reservations.readReservationState(root).lastStopConfirmedAt ?? 0) > 5000,
        'successive memory stops must respect the settle window', 7000)
      reservations.watchReservationMemory(root, { ...machine, availableMiB: 0 })
    }
    await until(() => run.child.exitCode !== null, 'memory retries must stop after three requeues (four attempts)')
    assert.equal(await run.ended, 75)
    assert.equal(readFileSync(marker, 'utf8'), '4')
    assert.match(run.stderr(), /memory retry limit reached \(3 requeues\)/)
    const grants = readSuiteLockJournal(root).tickets.filter((entry) => entry.grant)
    assert.equal(grants.length, 4)
    assert.equal(new Set(grants.map((entry) => entry.ticket)).size, 1)
    assert.equal(reservations.readReservationState(root).holders.length, 0)
    assert.equal(readQueueSnapshot(path.join(root, 'queue.d')).length, 0)
  } finally { await finishManaged(run) }
})

reservationTest('CPU overload leaves real running jobs unsignalled and only pauses new admission', async () => {
  const root = path.join(scratch, 'cpu-no-signals')
  history(root)
  const started = path.join(root, 'started')
  const signalled = path.join(root, 'signalled')
  const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'started');for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>{fs.writeFileSync(${JSON.stringify(signalled)},s);process.exit(0)});setInterval(()=>{},1000)`
  const run = managedChild(root, script)
  let waiter
  try {
    await until(() => { try { return readFileSync(started, 'utf8') === 'started' } catch { return false } }, 'real child must start')
    writeFileSync(path.join(root, 'machine.json'), JSON.stringify({ ...machine, load: 99 }))
    const since = Date.now()
    const next = path.join(root, 'next')
    waiter = managedChild(root, `require('fs').writeFileSync(${JSON.stringify(next)},'admitted')`)
    await until(() => readQueueSnapshot(path.join(root, 'queue.d')).length === 1, 'CPU waiter must queue')
    await until(() => reservations.readReservationState(root).watchdog.heartbeat > since + 1000, 'watchdog must sample CPU overload twice')
    assert.equal(run.child.exitCode, null, 'CPU overload must not kill the running job')
    assert.throws(() => readFileSync(signalled), { code: 'ENOENT' }, 'CPU overload must signal no running job')
    assert.throws(() => readFileSync(next), { code: 'ENOENT' }, 'CPU overload must stop new admissions')
    writeFileSync(path.join(root, 'machine.json'), JSON.stringify(machine))
    assert.equal(await waiter.ended, 0)
    assert.equal(readFileSync(next, 'utf8'), 'admitted')
  } finally { await finishManaged(run); if (waiter) await finishManaged(waiter) }
})

const nestedSandboxAvailable = process.platform === 'linux' && spawnSync('bwrap',
  ['--unshare-pid', '--unshare-user', '--dev-bind', '/', '/', '--proc', '/proc', 'true'], { stdio: 'ignore' }).status === 0
test('a foreign PID namespace cannot replace a live watchdog (Linux bwrap required)', { skip: !nestedSandboxAvailable }, async () => {
  const root = path.join(scratch, 'watchdog-namespace')
  mkdirSync(root)
  const watchdog = path.join(scratch, 'bin/lib/host/suite-lock-watchdog.mjs')
  const before = readFileSync(watchdog, 'utf8')
  // Make the erroneous zero-heartbeat replacement deterministic, rather than
  // depending on a new watchdog's import latency crossing the owner's poll.
  writeFileSync(watchdog, 'await new Promise(resolve => setTimeout(resolve, 300));\n' + before)
  const marker = path.join(root, 'started')
  const run = managedChild(root, `require('fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`)
  try {
    await until(() => { try { return readFileSync(marker, 'utf8') === 'started' } catch { return false } }, 'outer holder must start')
    const identity = reservations.readReservationState(root).watchdog
    const result = spawnSync('bwrap', ['--unshare-pid', '--unshare-user', '--dev-bind', '/', '/', '--proc', '/proc',
      process.execPath, path.join(scratch, 'bin/wt-suite-lock.mjs'), 'run', '--wait-s', '0.7', '--stale-s', '0.7', '--',
      process.execPath, '-e', 'process.exit(0)'], {
      env: { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', WT_SUITE_LOCK: '1' },
      encoding: 'utf8', timeout: 10_000,
    })
    assert.equal(result.status, 75, 'a foreign waiter must not replace the live supervisor and stop its holder')
    assert.equal(run.child.exitCode, null, 'the outer command must remain running')
    const after = reservations.readReservationState(root).watchdog
    assert.equal(after.pid, identity.pid, 'watchdog ownership must remain with the original namespace')
    assert.equal(after.pidNamespace, identity.pidNamespace)
  } finally { writeFileSync(watchdog, before); await finishManaged(run) }
})

test('real CLI children overlap and see their reservation environment', { skip: process.platform === 'win32' }, async () => {
  const root = path.join(scratch, 'real')
  history(root)
  const launch = (name) => {
    const marker = path.join(scratch, name)
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({mode:process.env.WT_SUITE_LEASE_MODE,reservation:process.env.WT_SUITE_LEASE_RESERVATION}));setInterval(()=>{},1000)`
    const child = spawn(process.execPath, [path.join(scratch, 'bin/wt-suite-lock.mjs'), 'run', '--job-class', 'fixture', '--', process.execPath, '-e', script], {
      env: { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LEASE: '', WT_SUITE_LOCK_BROKER: '', WT_SUITE_LOCK: '1' }, stdio: 'ignore',
    })
    children.add(child)
    return { child, marker, ended: new Promise((resolve) => child.once('exit', resolve)) }
  }
  const first = launch('first')
  const second = launch('second')
  try {
    await until(() => { try { return readFileSync(first.marker) && readFileSync(second.marker) } catch { return false } }, 'two real fitting jobs must overlap')
    const frame = JSON.parse(readFileSync(first.marker, 'utf8'))
    assert.equal(frame.mode, 'reservation')
    assert.ok(JSON.parse(frame.reservation).cores > 0)
  } finally {
    first.child.kill('SIGTERM'); second.child.kill('SIGTERM')
    await Promise.all([first.ended, second.ended])
    children.delete(first.child); children.delete(second.child)
  }
  const releases = readSuiteLockJournal(root).tickets.filter((ticket) => ticket.grant).map((ticket) => ticket.release)
  assert.equal(releases.length, 2)
  for (const release of releases) assert.equal(release.cause, 'signal', 'operator signals must not train a timing-sensitive failure')
})

test('real memory stop escalates TERM to KILL then requeues the same ranked ticket', { skip: process.platform === 'win32' }, async () => {
  assert.equal(typeof reservations.watchReservationMemory, 'function', 'memory watchdog must support real-process exercise')
  const root = path.join(scratch, 'real-requeue')
  history(root)
  const marker = path.join(scratch, 'restarts')
  const script = `const fs=require('fs');const p=${JSON.stringify(marker)};const n=Number(fs.existsSync(p)?fs.readFileSync(p,'utf8'):0)+1;fs.writeFileSync(p,String(n));if(n===1){process.on('SIGTERM',()=>{});setInterval(()=>{},1000)}`
  const child = spawn(process.execPath, [path.join(scratch, 'bin/wt-suite-lock.mjs'), 'run', '--job-class', 'fixture', '--priority', 'P2', '--', process.execPath, '-e', script], {
    env: { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LEASE: '', WT_SUITE_LOCK_BROKER: '', WT_SUITE_LOCK: '1' }, stdio: 'ignore',
  })
  children.add(child)
  const ended = new Promise((resolve) => child.once('exit', resolve))
  try {
    await until(() => { try { return readFileSync(marker, 'utf8') === '1' } catch { return false } }, 'first attempt must start')
    reservations.watchReservationMemory(root, { ...machine, availableMiB: 0 })
    reservations.watchReservationMemory(root, { ...machine, availableMiB: 0 })
    await until(() => readFileSync(marker, 'utf8') === '2', 'stopped job must automatically start its second attempt', 15000)
    assert.equal(await ended, 0)
    children.delete(child)
    const rows = readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const grants = rows.filter((row) => row.event === 'grant')
    const stops = rows.filter((row) => row.cause === 'memory-pressure')
    assert.equal(grants.length, 2)
    assert.equal(grants[0].ticket, grants[1].ticket, 'automatic retry preserves ticket')
    assert.equal(grants[0].priority, grants[1].priority, 'automatic retry preserves rank')
    assert.equal(stops.length, 1, 'exactly one memory stop terminal')
    for (const grant of grants) assert.equal(rows.filter((row) => row.leaseId === grant.leaseId && row.event === 'release').length, 1)
  } finally { if (children.has(child)) { child.kill('SIGTERM'); await ended; children.delete(child) } }
})

test('watchdog death keeps its managed child running and elects a replacement', { skip: process.platform === 'win32' }, async () => {
  const root = path.join(scratch, 'watchdog-death')
  history(root)
  const marker = path.join(scratch, 'watchdog-death-started')
  const script = `require('fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`
  const child = spawn(process.execPath, [path.join(scratch, 'bin/wt-suite-lock.mjs'), 'run', '--job-class', 'fixture', '--', process.execPath, '-e', script], {
    env: { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LEASE: '', WT_SUITE_LOCK_BROKER: '', WT_SUITE_LOCK: '1' }, stdio: 'ignore',
  })
  children.add(child)
  const ended = new Promise((resolve) => child.once('exit', resolve))
  try {
    await until(() => { try { return readFileSync(marker, 'utf8') === 'started' } catch { return false } }, 'managed child must start')
    const state = reservations.readReservationState(root)
    process.kill(state.watchdog.pid, 'SIGKILL') // This watchdog was started by this fixture's CLI.
    await until(() => reservations.readReservationState(root).watchdog.pid !== state.watchdog.pid,
      'holder launcher must replace a dead watchdog without stopping work', 15000)
    assert.equal(child.exitCode, null, 'watchdog loss must keep the owned group running')
    const rows = readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const release = rows.find((row) => row.leaseId === state.holders[0].leaseId && row.event === 'release')
    assert.equal(release, undefined, 'watchdog loss must publish no stop terminal')
  } finally { if (children.has(child)) { child.kill('SIGTERM'); await ended; children.delete(child) } }
})

for (const trigger of ['memory', 'signal']) reservationTest(`${trigger} process-group stop error retains capacity until completion is confirmed`, async () => {
  const root = path.join(scratch, `stop-error-${trigger}`)
  history(root)
  const restore = injectStopError(trigger)
  const marker = path.join(scratch, `stop-error-started-${trigger}`)
  const script = `require('fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`
  const child = spawn(process.execPath, [path.join(scratch, 'bin/wt-suite-lock.mjs'), 'run', '--job-class', 'fixture', '--', process.execPath, '-e', script], {
    env: { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LEASE: '', WT_SUITE_LOCK_BROKER: '', WT_SUITE_LOCK: '1' }, stdio: 'ignore',
  })
  children.add(child)
  const ended = new Promise((resolve) => child.once('exit', resolve))
  try {
    await until(() => { try { return readFileSync(marker, 'utf8') === 'started' } catch { return false } }, 'owned command must start')
    if (trigger === 'memory') reservations.watchReservationMemory(root, { ...machine, availableMiB: 0 })
    else child.kill('SIGTERM')
    assert.notEqual(await ended, 0)
    const state = reservations.readReservationState(root)
    assert.equal(state.holders.length, 1, 'a stop error must not release possibly live command capacity')
    const ticket = readSuiteLockJournal(root).tickets.find((entry) => entry.leaseId === state.holders[0].leaseId)
    assert.equal(ticket.release, undefined, 'unconfirmed ownership must not publish a release terminal')
  } finally {
    restore()
    if (child.exitCode === null) { child.kill('SIGTERM'); await ended }
    children.delete(child)
  }
})
