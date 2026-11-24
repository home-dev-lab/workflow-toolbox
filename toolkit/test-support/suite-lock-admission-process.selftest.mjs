import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
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
const { acquireSuiteLock, releaseSuiteLock, suiteLeaseMarker, readSuiteLock } = await import(lib)
const { replaceQueuedCommand } = await import(pathToFileURL(path.join(scratch, 'bin/lib/host/suite-lock-replace.mjs')))
const { readQueueSnapshot } = await import(pathToFileURL(path.join(scratch, 'bin/lib/host/suite-lock-queue.mjs')))
const { currentPidNamespace } = await import(pathToFileURL(path.join(scratch, 'bin/lib/host/pid-namespace.mjs')))
const { setSuiteLockPrecedence } = await import(pathToFileURL(path.join(scratch, 'bin/lib/host/suite-lock-rank-state.mjs')))
const { suiteJournalEvent, readSuiteLockJournal } = await import(pathToFileURL(path.join(scratch, 'bin/lib/suite-lock-journal.mjs')))
const reservations = await import(pathToFileURL(path.join(scratch, 'bin/lib/host/suite-lock-reservations.mjs'))).catch(() => ({}))
const machine = { cores: 4, memMiB: 4096, load: 0, loadLimit: 4, availableMiB: 8192, floorMiB: 1024 }
// Real children and groups, deterministic host readings in this OS-temp copy.
writeFileSync(path.join(scratch, 'bin/lib/host/suite-lock-machine.mjs'),
  `export function readSuiteMachine() { return ${JSON.stringify(machine)} }\nexport const reservationHostSupported = (platform = process.platform) => ['linux', 'darwin'].includes(platform)\n`)
const children = new Set()
after(() => { for (const child of children) child.kill('SIGKILL'); rmSync(scratch, { recursive: true, force: true }) })
const pause = () => new Promise((resolve) => setTimeout(resolve, 20))
const reservationTest = (name, fn) => test(name, { skip: process.platform === 'win32' }, fn)

async function until(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (check()) return; await pause() }
  assert.fail(message)
}

function history(root) {
  mkdirSync(root, { recursive: true })
  const rows = [0, 1, 2].map((number) => ({ leaseId: `history-${number}`, kind: 'exclusive', cmd: 'other', event: 'release',
    ts: new Date().toISOString(), exit: 0, overlaps: [], resources: { peakCores: 1, peakMemMiB: 100,
      wallMs: 1000, unknownReasons: [] } }))
  writeFileSync(path.join(root, 'journal.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
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
  const row = (leaseId, event, cores = 1) => ({ leaseId, kind: 'exclusive', cmd: 'other', event,
    ts: new Date(event === 'release' && leaseId === 'long' ? 500 : 1000).toISOString(), exit: 0, overlaps: [],
    resources: { peakCores: cores, peakMemMiB: 100, wallMs: 1000, unknownReasons: [] } })
  const rows = [row('long', 'request'), ...Array.from({ length: 10 }, (_, i) => row(`short-${i}`, 'request')),
    ...Array.from({ length: 10 }, (_, i) => row(`short-${i}`, 'release')), row('long', 'release', 2)]
  writeFileSync(path.join(root, 'journal.jsonl'), rows.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const lease = await acquireSuiteLock({ root, reservation: true, readMachine: () => machine,
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
  const options = { root, reservation: true, readMachine: () => budget, waitS: 2, pollMs: 10, argv: ['fixture'], env: {} }
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
  const options = { root, reservation: true, readMachine: () => machine, waitS: 2, pollMs: 10, argv: ['fixture'], env: {} }
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
    pending = acquireSuiteLock({ root, reservation: true, priority: 'P2', readMachine: () => machine,
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
  const options = { root, readMachine: () => machine, waitS: 2, pollMs: 10, argv: ['fixture'], env: {} }
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
  const launch = (project, priority) => acquireSuiteLock({ root, reservation: true, readMachine: () => budget,
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
  const options = { root, readMachine: () => machine, waitS: 2, pollMs: 10, argv: ['fixture'], env: {} }
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
  const lease = await acquireSuiteLock({ root, reservation: true, readMachine: () => machine, waitS: 5, staleS: 5,
    pollMs: 10, argv: ['fixture'], env: {} })
  try {
    assert.equal(lease.reservationLease, true, 'a proven dead legacy holder must not strand the new queue')
    assert.notEqual(JSON.parse(readFileSync(path.join(lockDir, 'holder.json'), 'utf8')).leaseId, `dead-${domain}`,
      'the stale compatibility holder must actually be reclaimed')
  }
  finally { releaseSuiteLock(lease, { exit: 0 }) }
})

reservationTest('replacing a queued command recomputes its footprint before publication', async () => {
  const root = path.join(scratch, 'replace')
  history(root)
  const options = { root, reservation: true, readMachine: () => machine, waitS: 2, pollMs: 10, argv: ['fixture'], env: {} }
  const one = await acquireSuiteLock(options)
  let load = 99
  let polls = 0
  let two
  const pending = acquireSuiteLock({ ...options, replaceable: true, readMachine: () => { polls++; return { ...machine, load } } })
    .then((lease) => { two = lease })
  try {
    await until(() => polls > 0, 'replacement candidate must queue')
    const [queued] = readQueueSnapshot(path.join(root, 'queue.d'))
    replaceQueuedCommand(root, queued.number, ['test'])
    load = 0
    const before = polls
    await until(() => two || polls > before + 2, 'new command footprint must be checked')
    assert.equal(two, undefined, 'unmeasured replacement must wait for exclusive capacity')
    releaseSuiteLock(one, { exit: 0 })
    await pending
    assert.deepEqual(two.replacementArgv, ['test'], 'execute the accepted replacement')
    assert.equal(two.holder.reservation.mode, 'exclusive')
  } finally { releaseSuiteLock(one); await pending; if (two) releaseSuiteLock(two) }
})

reservationTest('concurrent API leases each publish exactly one terminal and symmetric overlap', async () => {
  const root = path.join(scratch, 'terminal')
  history(root)
  const options = { root, reservation: true, readMachine: () => machine, waitS: 2, pollMs: 10,
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
  const options = { root, reservation: true, readMachine: () => machine, waitS: 2, pollMs: 10, argv: ['fixture'],
    priority: 'P2', size: 'L', env: {} }
  const one = await acquireSuiteLock(options)
  const two = await acquireSuiteLock(options)
  try {
    reservations.watchReservationMemory(root, { ...machine, availableMiB: 0 })
    reservations.watchReservationMemory(root, { ...machine, availableMiB: 0 })
    const state = reservations.readReservationState(root)
    assert.equal(state.holders.filter((holder) => holder.stop).length, 1, 'one outstanding stop')
    assert.equal(state.holders.find((holder) => holder.stop).leaseId, two.holder.leaseId)
    releaseSuiteLock(two, { exit: 75, served: false })
    releaseSuiteLock(one, { exit: 0 })
    const again = await acquireSuiteLock({ ...options, priority: 'P0', requeue: two })
    try {
      assert.equal(again.ticket, two.ticket, 'requeue keeps original ticket')
      assert.equal(again.holder.level, 2, 'requeue keeps original priority')
      assert.notEqual(again.holder.leaseId, two.holder.leaseId, 'new attempt has its own terminal identity')
    } finally { releaseSuiteLock(again, { exit: 0 }) }
    const rows = readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const stopped = rows.filter((row) => row.leaseId === two.holder.leaseId && row.event === 'release')
    assert.equal(stopped.length, 1)
    assert.equal(stopped[0].cause, 'memory-pressure')
  } finally { releaseSuiteLock(one); releaseSuiteLock(two) }
})

test('real CLI children overlap and see their reservation environment', { skip: process.platform === 'win32' }, async () => {
  const root = path.join(scratch, 'real')
  history(root)
  const launch = (name) => {
    const marker = path.join(scratch, name)
    const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({mode:process.env.WT_SUITE_LEASE_MODE,reservation:process.env.WT_SUITE_LEASE_RESERVATION}));setInterval(()=>{},1000)`
    const child = spawn(process.execPath, [path.join(scratch, 'bin/wt-suite-lock.mjs'), 'run', '--', process.execPath, '-e', script], {
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
  const child = spawn(process.execPath, [path.join(scratch, 'bin/wt-suite-lock.mjs'), 'run', '--priority', 'P2', '--', process.execPath, '-e', script], {
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

test('watchdog death stops its own managed child and journals the named failure', { skip: process.platform === 'win32' }, async () => {
  const root = path.join(scratch, 'watchdog-death')
  history(root)
  const marker = path.join(scratch, 'watchdog-death-started')
  const script = `require('fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`
  const child = spawn(process.execPath, [path.join(scratch, 'bin/wt-suite-lock.mjs'), 'run', '--', process.execPath, '-e', script], {
    env: { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LEASE: '', WT_SUITE_LOCK_BROKER: '', WT_SUITE_LOCK: '1' }, stdio: 'ignore',
  })
  children.add(child)
  const ended = new Promise((resolve) => child.once('exit', resolve))
  try {
    await until(() => { try { return readFileSync(marker, 'utf8') === 'started' } catch { return false } }, 'managed child must start')
    const state = reservations.readReservationState(root)
    process.kill(state.watchdog.pid, 'SIGKILL') // This watchdog was started by this fixture's CLI.
    await until(() => child.exitCode !== null, 'watchdog loss must stop the owned group', 15000)
    assert.equal(await ended, 75)
    const rows = readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const release = rows.find((row) => row.leaseId === state.holders[0].leaseId && row.event === 'release')
    assert.equal(release?.cause, 'watchdog-unavailable', 'watchdog failure must not masquerade as a timing-sensitive red')
  } finally { if (children.has(child)) { child.kill('SIGTERM'); await ended; children.delete(child) } }
})

for (const trigger of ['memory', 'signal']) reservationTest(`${trigger} process-group stop error retains capacity until completion is confirmed`, async () => {
  const root = path.join(scratch, `stop-error-${trigger}`)
  history(root)
  const restore = injectStopError(trigger)
  const marker = path.join(scratch, `stop-error-started-${trigger}`)
  const script = `require('fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`
  const child = spawn(process.execPath, [path.join(scratch, 'bin/wt-suite-lock.mjs'), 'run', '--', process.execPath, '-e', script], {
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
