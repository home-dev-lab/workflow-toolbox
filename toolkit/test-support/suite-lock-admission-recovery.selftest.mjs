import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'suite-recovery-'))
const source = process.env.WT_ADMISSION_BIN ?? path.resolve(import.meta.dirname, '../../plugin/bin')
cpSync(source, path.join(scratch, 'bin'), { recursive: true })
mkdirSync(path.join(scratch, '.claude-plugin'))
cpSync(path.join(source, '../.claude-plugin/plugin.json'), path.join(scratch, '.claude-plugin/plugin.json'))
const url = (name) => pathToFileURL(path.join(scratch, 'bin', name)).href
const reservations = await import(url('lib/host/suite-lock-reservations.mjs'))
const sections = await import(url('lib/host/suite-lock-section.mjs'))
const machineApi = await import(url('lib/host/suite-lock-machine.mjs'))
const policy = await import(url('lib/suite-lock-admission.mjs'))
const { currentPidNamespace, processStartTime } = await import(url('lib/host/pid-namespace.mjs'))
const children = new Set()
const roots = []
const healthy = { cores: 8, memMiB: 7000, load: 0, loadLimit: 8, availableMiB: 8000, floorMiB: 1000 }
// CLI children use an injected module in the private copy: never PowerShell or host pressure.
writeFileSync(path.join(scratch, 'bin/lib/host/suite-lock-machine.mjs'), `
export const readSuiteMachine = () => (${JSON.stringify(healthy)});
export const reservationHostSupported = () => true;
export const isWsl = () => false;
export const startWindowsMemoryReader = () => { throw new Error('unexpected Windows reader in fixture') };
`)
const identity = () => ({ pid: process.pid, startTime: processStartTime(process.pid), pidNamespace: currentPidNamespace() })
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
after(() => {
  for (const child of children) child.kill('SIGKILL')
  for (const root of roots) {
    const state = reservations.readReservationState(root)
    if (state?.watchdog?.pid !== process.pid) { try { process.kill(state.watchdog.pid, 'SIGKILL') } catch { /* fixture ended */ } }
  }
  rmSync(scratch, { recursive: true, force: true })
})

async function until(check, message, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (check()) return; await pause() }
  assert.fail(message)
}

function fixture(name, holders = []) {
  const root = path.join(scratch, name)
  mkdirSync(path.join(root, 'queue.d'), { recursive: true })
  roots.push(root)
  const state = { version: 1, generation: name, holders, bypasses: {}, createdAt: Date.now(),
    watchdog: { ...identity(), heartbeat: Date.now() } }
  save(root, state)
  return { root, state }
}

function save(root, state) { writeFileSync(path.join(root, 'reservations.json'), JSON.stringify(state)) }

function holder(leaseId, extra = {}) {
  return { ...identity(), leaseId, level: 1, priority: 'P1', argv: ['fixture'], overlaps: [],
    reservation: { mode: 'reservation', cores: 1, memMiB: 100 }, ...extra }
}

function waiting(root, number = 1) {
  const record = { ...holder(`candidate-${number}`), reservationProtocol: 1, levelOrderVersion: 4,
    project: 'fixture', journal: { cmd: 'other', jobClass: 'fixture' }, jobClass: 'fixture' }
  writeFileSync(path.join(root, 'queue.d', `${String(number).padStart(16, '0')}.json`), JSON.stringify(record))
  return { root, ticket: number, record, lockDir: path.join(root, 'lock.d') }
}

function seedHistory(root) {
  const rows = [1, 2, 3].map((n) => ({ event: 'release', leaseId: `history-${n}`, kind: 'exclusive',
    ts: new Date().toISOString(), cmd: 'other', jobClass: 'fixture', exit: 0, overlaps: [],
    resources: { peakCores: 1, peakMemMiB: 100, wallMs: 1000, unknownReasons: [] } }))
  writeFileSync(path.join(root, 'journal.jsonl'), rows.map(JSON.stringify).join('\n') + '\n')
}

test('R6 unknown supervision never becomes an automatic stop', () => {
  const { root, state } = fixture('unknown-supervision', [holder('live')])
  const lease = { root, holder: state.holders[0] }
  state.watchdog.heartbeat = Date.now() - 8000
  save(root, state)
  assert.equal(reservations.reservationStopReason(lease), null, 'stale watchdog must not stop healthy work')
  state.watchdog.heartbeat = Date.now()
  state.memory = { unknown: 'unreadable' }
  save(root, state)
  assert.equal(reservations.reservationStopReason(lease), null, 'unknown memory must not stop work')
  writeFileSync(path.join(root, 'reservations.json'), '{')
  assert.equal(reservations.reservationStopReason(lease), null, 'unreadable state must not stop work')
  save(root, state)
})

function managedChild(root) {
  const marker = path.join(root, 'child-started')
  const child = spawn(process.execPath, [path.join(scratch, 'bin/wt-suite-lock.mjs'), 'run', '--', process.execPath, '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`], {
    stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_ADMISSION: 'reservation',
      WT_SUITE_LOCK_JOB_CLASS: 'fixture', WT_SUITE_LEASE: '', WT_SUITE_LOCK_BROKER: '', WT_SUITE_LOCK: '1' },
  })
  children.add(child)
  child.stderr.resume()
  return { child, marker, ended: new Promise((resolve) => child.once('exit', resolve)) }
}

for (const action of ['pause', 'kill']) test(`R6 real watchdog ${action} never stops its healthy child`, { skip: process.platform === 'win32' }, async () => {
  const { root } = fixture(`watchdog-${action}`)
  // Give this fixture a real supervisor rather than the unit fixture's identity.
  rmSync(path.join(root, 'reservations.json'))
  const run = managedChild(root)
  let pid
  try {
    await until(() => existsSync(run.marker), 'managed command must start')
    pid = reservations.readReservationState(root).watchdog.pid
    process.kill(pid, action === 'pause' ? 'SIGSTOP' : 'SIGKILL')
    if (action === 'pause') {
      await pause(8000)
      assert.equal(run.child.exitCode, null, 'eight seconds of watchdog silence must not stop a healthy child')
      process.kill(pid, 'SIGCONT')
    } else {
      await until(() => reservations.readReservationState(root).watchdog.pid !== pid,
        'holder launcher must elect a replacement without a waiter', 8000)
      assert.equal(run.child.exitCode, null, 'watchdog death must not stop a healthy child')
    }
    assert.ok(reservations.readReservationState(root).holders.every((entry) => !entry.stop), 'supervision loss journals no memory stop')
    const journal = readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(journal.every((row) => row.cause !== 'memory-pressure'), 'watchdog loss must journal no memory stop')
  } finally {
    if (action === 'pause' && pid) { try { process.kill(pid, 'SIGCONT') } catch { /* fixture ended */ } }
    run.child.kill('SIGTERM')
    await run.ended
    children.delete(run.child)
  }
})

for (const sensor of ['unknown', 'heartbeat', 'windows']) test(`R5 ${sensor} falls through to exclusive without a holder`, () => {
  const { root, state } = fixture(`fallback-${sensor}`)
  seedHistory(root)
  if (sensor === 'heartbeat') state.watchdog.heartbeat = Date.now() - 8000
  save(root, state)
  const request = waiting(root)
  const reading = sensor === 'unknown' ? { unknown: 'test-unavailable' } : { ...healthy, wsl: sensor === 'windows' }
  const lease = reservations.pollReservationLease(request, request.record, { readMachine: () => reading })
  assert.equal(lease?.holder.reservation.mode, 'exclusive', `${sensor} must admit one exclusive job instead of waiting for a sensor`)
})

test('R5 stale sensors never share with an existing holder', () => {
  const { root } = fixture('fallback-held', [holder('existing')])
  const request = waiting(root)
  assert.equal(reservations.pollReservationLease(request, request.record, { readMachine: () => ({ unknown: 'missing' }) }), null)
  assert.equal(reservations.readReservationState(root).holders[0].stop, undefined)
})

test('R5 an invalid Windows sample cannot authorize sharing', () => {
  const { root, state } = fixture('invalid-windows', [holder('peer')])
  seedHistory(root)
  state.windowsMemory = { availableMiB: null, sampledAt: Date.now() }
  save(root, state)
  const request = waiting(root)
  assert.equal(reservations.pollReservationLease(request, request.record, { readMachine: () => ({ ...healthy, wsl: true }) }),
    null, 'a timestamp without a valid Windows memory value must not authorize sharing')
})

async function deadWriter(root, name, owner = true) {
  const directory = path.join(root, name)
  const script = `const f=require('fs');(async()=>{const m=await import(${JSON.stringify(url('lib/host/suite-lock-section.mjs'))});
if(${owner}&&m.claimOwnedSuiteSection){m.claimOwnedSuiteSection(${JSON.stringify(root)},${JSON.stringify(name)},()=>{process.stdout.write('ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000)});return}
f.mkdirSync(${JSON.stringify(directory)});${owner ? `f.writeFileSync(${JSON.stringify(path.join(directory, 'owner.json'))},JSON.stringify({pid:process.pid,pidNamespace:${JSON.stringify(currentPidNamespace())}}));` : ''}process.stdout.write('ready');setInterval(()=>{},1000)})()`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.add(child)
  await new Promise((resolve) => child.stdout.once('data', resolve))
  child.kill('SIGKILL')
  await new Promise((resolve) => child.once('exit', resolve))
  children.delete(child)
  if (!owner) utimesSync(directory, new Date(0), new Date(0))
}

for (const name of ['reservation-write.d', 'reclaim.d']) test(`R8 dead writer in ${name} is reclaimed`, async () => {
  const { root } = fixture(`dead-${name}`)
  await deadWriter(root, name)
  const request = waiting(root)
  let lease
  await until(() => (lease = reservations.pollReservationLease(request, request.record, { readMachine: () => healthy })),
    'a proven-dead writer must not strand admission')
  assert.ok(lease)
})

test('R8 ownerless writer older than ten seconds is reclaimed', async () => {
  const { root } = fixture('ownerless')
  await deadWriter(root, 'reservation-write.d', false)
  const request = waiting(root)
  await until(() => reservations.pollReservationLease(request, request.record, { readMachine: () => healthy }),
    'an old ownerless writer must recover')
})

test('R8 live writer is never reclaimed merely by age', () => {
  const { root } = fixture('live-section')
  const directory = path.join(root, 'reclaim.d')
  mkdirSync(directory)
  writeFileSync(path.join(directory, 'owner.json'), JSON.stringify(identity()))
  utimesSync(directory, new Date(0), new Date(0))
  assert.equal(sections.claimSuiteSection(root, () => assert.fail('live owner was bypassed')), sections.RECLAIM_BUSY)
  assert.equal(existsSync(directory), true, 'age must not remove a live writer')
})

test('R8 two concurrent reclaimers cannot both enter the writer section', async () => {
  const { root } = fixture('concurrent-reclaim')
  await deadWriter(root, 'reclaim.d')
  const barrier = path.join(root, 'go')
  const script = `import * as f from 'node:fs';const m=await import(${JSON.stringify(url('lib/host/suite-lock-section.mjs'))});
process.stdout.write('ready');while(!f.existsSync(${JSON.stringify(barrier)}))await new Promise(r=>setTimeout(r,5));
let result;const entered=${JSON.stringify(path.join(root, 'entered'))},release=${JSON.stringify(path.join(root, 'release'))};
while(!f.existsSync(entered)){result=m.claimSuiteSection(${JSON.stringify(root)},()=>{f.writeFileSync(entered,String(process.pid),{flag:'wx'});process.stdout.write('entered');const end=Date.now()+5000;while(!f.existsSync(release)&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);return true});if(result===true)break;await new Promise(r=>setTimeout(r,5+Math.random()*10))}process.stdout.write(result===true?'done':'busy');`
  const runs = [0, 1].map(() => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    children.add(child)
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    return { child, output: () => output, ended: new Promise((resolve) => child.once('exit', resolve)) }
  })
  await until(() => runs.every((run) => run.output().includes('ready')), 'reclaimers must reach the barrier')
  writeFileSync(barrier, '')
  try {
    await until(() => runs.some((run) => run.output().includes('busy') || run.child.exitCode !== null),
      'second reclaimer must finish while the winner retains the section')
  } finally { writeFileSync(path.join(root, 'release'), '') }
  assert.deepEqual(await Promise.all(runs.map((run) => run.ended)), [0, 0])
  assert.equal(runs.filter((run) => run.output().includes('entered')).length, 1, 'exactly one concurrent reclaimer enters')
  for (const run of runs) children.delete(run.child)
})

test('R8 reconciliation removes a dead launcher and journals unknown release', async () => {
  const { root, state } = fixture('dead-launcher')
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  await new Promise((resolve) => child.once('exit', resolve))
  state.used = true
  state.holders = [holder('dead-grant', { pid: child.pid, startTime: null, stop: { cause: 'memory-pressure' } })]
  save(root, state)
  mkdirSync(path.join(root, 'lock.d'))
  writeFileSync(path.join(root, 'lock.d/holder.json'), JSON.stringify({ reservationProtocol: 1, leaseId: state.generation, pid: 1 }))
  reservations.watchReservationMemory(root, healthy)
  assert.equal(reservations.readReservationState(root).holders.length, 0, 'dead launchers must release capacity at writer entry')
  assert.equal(existsSync(path.join(root, 'lock.d')), false, 'last dead holder must remove its fence')
  const rows = readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(rows[0].cause, 'launcher-dead')
  assert.equal(rows[0].exit, null)
})

test('R8 a launcher killed after grant before spawn is reconciled', { skip: process.platform === 'win32' }, async () => {
  const { root } = fixture('grant-before-spawn')
  const ready = path.join(root, 'granted')
  const script = `import * as f from 'node:fs';const m=await import(${JSON.stringify(url('lib/suite-lock.mjs'))});
const lease=await m.acquireSuiteLock({root:${JSON.stringify(root)},reservation:true,argv:['fixture'],env:{},pollMs:10,waitS:5,readMachine:()=>(${JSON.stringify(healthy)})});
f.writeFileSync(${JSON.stringify(ready)},lease.holder.leaseId);process.kill(process.pid,'SIGSTOP');setInterval(()=>{},1000);`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' })
  children.add(child)
  const ended = new Promise((resolve) => child.once('exit', resolve))
  await until(() => existsSync(ready), 'launcher must publish the grant before the crash')
  child.kill('SIGKILL')
  await ended
  children.delete(child)
  reservations.watchReservationMemory(root, healthy)
  assert.equal(reservations.readReservationState(root).holders.length, 0, 'grant-before-spawn crash must not retain capacity')
  assert.equal(existsSync(path.join(root, 'lock.d')), false)
})

test('R8 release retries a live writer beyond the old three-second cutoff', async () => {
  const { root, state } = fixture('release-retry', [holder('release')])
  const directory = path.join(root, 'reservation-write.d')
  const script = `const f=require('fs');f.mkdirSync(${JSON.stringify(directory)});f.writeFileSync(${JSON.stringify(path.join(directory, 'owner.json'))},JSON.stringify({pid:process.pid}));process.stdout.write('ready');setTimeout(()=>f.rmSync(${JSON.stringify(directory)},{recursive:true}),3300)`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.add(child)
  await new Promise((resolve) => child.stdout.once('data', resolve))
  const lease = { root, holder: state.holders[0] }
  assert.equal(reservations.releaseReservationLease(lease, { exit: 0 }), true, 'release must retry a busy inner writer, not abandon its holder')
  assert.equal(reservations.readReservationState(root).holders.length, 0)
  children.delete(child)
})

test('R8 release retries a temporarily unreadable reservation state', async () => {
  const { root, state } = fixture('release-unreadable', [holder('release')])
  const file = path.join(root, 'reservations.json')
  const script = `const f=require('fs');f.writeFileSync(${JSON.stringify(file)},'{');process.stdout.write('ready');setTimeout(()=>f.writeFileSync(${JSON.stringify(file)},${JSON.stringify(JSON.stringify(state))}),100)`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  children.add(child)
  await new Promise((resolve) => child.stdout.once('data', resolve))
  const ended = new Promise((resolve) => child.once('exit', resolve))
  try {
    assert.equal(reservations.releaseReservationLease({ root, holder: state.holders[0] }, { exit: 0 }), true,
      'temporary state failure must retry release instead of replacing the command result with an exception')
  } finally { await ended; children.delete(child) }
})

test('R6 victim order is total for absent sequence and timestamps', () => {
  const holders = [holder('a'), holder('z'), holder('timed', { startedAtMs: 20 })]
  assert.equal(policy.watchdogDecision(holders, { availableMiB: 0, floorMiB: 1 })?.leaseId, 'timed', 'missing age counts as oldest')
  const tied = holders.slice(0, 2)
  assert.equal(policy.watchdogDecision(tied, { availableMiB: 0, floorMiB: 1 })?.leaseId,
    policy.watchdogDecision([...tied].reverse(), { availableMiB: 0, floorMiB: 1 })?.leaseId, 'lease id must break every remaining tie')
  assert.equal(policy.watchdogDecision([holder('newer-sequenced', { admittedSequence: 2, startedAtMs: 20 }),
    holder('older-legacy', { startedAtMs: 10 })], { availableMiB: 0, floorMiB: 1 })?.leaseId,
  'newer-sequenced', 'mixed sequence records must compare admission times rather than incompatible numeric units')
})

test('R6 expired stops are abandoned and the next victim can be chosen', () => {
  const { root, state } = fixture('expired-stop', [holder('old-stop', { admittedSequence: 2,
    stop: { cause: 'memory-pressure', at: Date.now() - 21_000, deadline: Date.now() - 1000 } }), holder('next', { admittedSequence: 1 })])
  reservations.watchReservationMemory(root, { ...healthy, availableMiB: 0 })
  const updated = reservations.readReservationState(root)
  assert.equal(updated.holders[0].stop.abandoned, true, 'expired stop must no longer block the safety net')
  assert.equal(updated.holders[1].stop?.cause, 'memory-pressure')
  assert.equal(updated.holders[1].stop.deadline - updated.holders[1].stop.at, 20_000)
  assert.equal(state.holders.length, 2)
  reservations.releaseReservationLease({ root, holder: updated.holders[0] }, { exit: 0 })
  assert.equal(reservations.readReservationState(root).lastStopConfirmedAt, undefined, 'an abandoned request is not a confirmed memory stop')
})

test('R6 a killed victim launcher cannot block the next victim past its deadline', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  children.add(child)
  const ended = new Promise((resolve) => child.once('exit', resolve))
  const { root } = fixture('victim-launcher-crash', [holder('older', { admittedSequence: 1 }),
    holder('doomed', { pid: child.pid, startTime: null, admittedSequence: 2 })])
  reservations.watchReservationMemory(root, { ...healthy, availableMiB: 0 })
  const stop = reservations.readReservationState(root).holders[1].stop
  assert.equal(stop?.cause, 'memory-pressure')
  assert.equal(stop.deadline - stop.at, 20_000, 'stop request must have a twenty-second deadline')
  child.kill('SIGKILL')
  await ended
  children.delete(child)
  await pause(Math.max(0, stop.deadline - Date.now() + 20))
  reservations.watchReservationMemory(root, { ...healthy, availableMiB: 0 })
  assert.equal(reservations.readReservationState(root).holders[0].stop?.cause, 'memory-pressure',
    'dead victim launcher must not strand the next memory stop')
})

test('R6 confirmed release settles five seconds before a new fresh low reading', () => {
  const victim = holder('victim', { stop: { cause: 'memory-pressure', at: Date.now(), deadline: Date.now() + 20_000 } })
  const { root } = fixture('settle', [victim, holder('remaining')])
  reservations.releaseReservationLease({ root, holder: victim }, { exit: 75 })
  reservations.watchReservationMemory(root, { ...healthy, availableMiB: 0 })
  assert.equal(reservations.readReservationState(root).holders[0].stop, undefined, 'confirmed stop needs a five-second settle window')
  const state = reservations.readReservationState(root)
  state.lastStopConfirmedAt = Date.now() - 6000
  save(root, state)
  reservations.watchReservationMemory(root, { ...healthy, availableMiB: 0, sampledAt: Date.now() - 7000 })
  assert.equal(reservations.readReservationState(root).holders[0].stop, undefined, 'pre-confirmation samples cannot select another victim')
  reservations.watchReservationMemory(root, { ...healthy, availableMiB: 0, sampledAt: Date.now() })
  assert.equal(reservations.readReservationState(root).holders[0].stop?.cause, 'memory-pressure')
})

test('R5 publication rechecks the sensors after beforePublish', () => {
  const { root } = fixture('publish-reread', [holder('peer')])
  seedHistory(root)
  const request = waiting(root)
  let reading = healthy
  const lease = reservations.pollReservationLease(request, request.record, { readMachine: () => reading,
    beforePublish: () => { reading = { unknown: 'sensor-disappeared' } } })
  assert.equal(lease, null, 'a sensor lost between planning and publication must prevent sharing')
  assert.equal(reservations.readReservationState(root).holders.length, 1)
})

for (const sensor of ['heartbeat', 'windows']) test(`R5 publication rechecks ${sensor} freshness inside the writer`, () => {
  const { root, state } = fixture(`publish-${sensor}`, [holder('peer')])
  state.windowsMemory = { availableMiB: 8000, sampledAt: Date.now() }
  save(root, state)
  seedHistory(root)
  const request = waiting(root)
  const lease = reservations.pollReservationLease(request, request.record, { readMachine: () => ({ ...healthy, wsl: true }),
    beforePublish: () => {
      const current = reservations.readReservationState(root)
      if (sensor === 'heartbeat') current.watchdog.heartbeat = Date.now() - 6000
      else current.windowsMemory.sampledAt = Date.now() - 11_000
      save(root, current)
    } })
  assert.equal(lease, null, `${sensor} going stale before publication must prevent a shared grant`)
})

test('R5 Windows reader parses integer lines, ages samples and respawns one child', () => {
  assert.equal(typeof machineApi.startWindowsMemoryReader, 'function', 'watchdog needs an injectable streaming Windows reader')
  const spawned = []
  let now = 1000
  const reader = machineApi.startWindowsMemoryReader({ now: () => now, spawnReader: (...args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => { child.killed = true } })
    spawned.push({ child, args })
    return child
  } })
  assert.equal(spawned.length, 1)
  spawned[0].child.stdout.write('bad\n1048')
  assert.equal(reader.sample(), null)
  spawned[0].child.stdout.write('576\n')
  assert.deepEqual(reader.sample(), { availableMiB: 1024, sampledAt: 1000 })
  now += 10_001
  assert.equal(reader.sample(), null, 'Windows samples older than ten seconds are unknown')
  spawned[0].child.emit('exit', 0)
  assert.equal(reader.sample(), null)
  assert.equal(spawned.length, 2, 'bounded reader must respawn after exit')
  reader.close()
  assert.equal(spawned[1].child.killed, true)
  assert.match(spawned[0].args[1].join(' '), /FreePhysicalMemory/)
})

test('R4 CPU booking capacity is exactly the online logical CPU count', () => {
  const value = machineApi.readSuiteMachine({ platform: 'linux', read: (file) => file === '/proc/meminfo' ? 'MemAvailable: 8388608 kB\n' : '',
    release: () => 'linux', total: () => 16 * 1024 ** 3, cpus: () => 8, load: () => [2] })
  assert.equal(value.cores, 8, 'CPU capacity must not include the old 1.5 overbooking factor')
})

test('R5 machine reader preserves legacy source getter ordering', () => {
  const reads = []
  const fields = new Set(['platform', 'read', 'free', 'total', 'cpus', 'load'])
  const input = { platform: 'linux', read: () => 'MemAvailable: 8388608 kB\n', free: () => 0,
    total: () => 16 * 1024 ** 3, cpus: () => 8, load: () => [0], release: () => 'linux', exists: () => false }
  machineApi.readSuiteMachine(new Proxy(input, { get(target, key, receiver) {
    if (fields.has(key)) reads.push(key)
    return Reflect.get(target, key, receiver)
  } }))
  assert.deepEqual(reads, [...fields], 'legacy source properties must be read once, in their original order')
  assert.throws(() => machineApi.readSuiteMachine({ platform: 'win32', get read() { throw new Error('getter failed') } }),
    /getter failed/, 'legacy source getter errors must remain outside the measurement catch')
})

test('R5 WSL uses the minimum of Linux and fresh Windows memory', () => {
  const input = { platform: 'linux', read: (file) => file === '/proc/meminfo' ? 'MemAvailable: 8388608 kB\n' : '',
    release: () => 'microsoft-standard', total: () => 16 * 1024 ** 3, cpus: () => 8, load: () => [0], now: () => 1000,
    windowsMemory: { availableMiB: 2000, sampledAt: 1000 } }
  const value = machineApi.readSuiteMachine(input)
  assert.equal(value.availableMiB, 2000, 'WSL effective memory must include fresh Windows physical memory')
  assert.equal(value.wsl, true)
  assert.equal(machineApi.readSuiteMachine({ ...input, windowsMemory: null }).availableMiB, 8192, 'missing Windows memory leaves Linux safety net usable')
})

test('R5 WSL interop marker detects WSL without a Microsoft kernel string', () => {
  assert.equal(typeof machineApi.isWsl, 'function')
  assert.equal(machineApi.isWsl({ platform: 'linux', release: () => 'generic', exists: () => true }), true)
  assert.equal(machineApi.isWsl({ platform: 'darwin', release: () => 'microsoft', exists: () => true }), false)
})

test('R6 test floor can only rise and its memory stops retain the override', () => {
  const warnings = []
  const input = { platform: 'linux', read: (file) => file === '/proc/meminfo' ? 'MemAvailable: 8388608 kB\n' : '',
    release: () => 'linux', total: () => 8 * 1024 ** 3, cpus: () => 8, load: () => [0], warn: (text) => warnings.push(text) }
  const previous = process.env.WT_SUITE_LOCK_TEST_FLOOR_MIB
  try {
    process.env.WT_SUITE_LOCK_TEST_FLOOR_MIB = '9000'
    const raised = machineApi.readSuiteMachine(input)
    assert.equal(raised.floorMiB, 9000, 'test seam must raise the computed floor')
    const { root } = fixture('override-stop', [holder('victim')])
    reservations.watchReservationMemory(root, raised)
    assert.equal(reservations.readReservationState(root).holders[0].stop.floorOverrideMiB, 9000)
    reservations.releaseReservationLease({ root, holder: holder('victim'),
      journal: { base: { root, leaseId: 'victim', kind: 'exclusive' } } }, { exit: 75 })
    const rows = readFileSync(path.join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(rows[0].floorOverrideMiB, 9000, 'memory-stop journal must retain the raised floor')
    process.env.WT_SUITE_LOCK_TEST_FLOOR_MIB = '1'
    assert.equal(machineApi.readSuiteMachine(input).floorMiB, 1024, 'test seam must never lower the floor')
    assert.match(warnings.join('\n'), /ignored/)
  } finally {
    if (previous === undefined) delete process.env.WT_SUITE_LOCK_TEST_FLOOR_MIB
    else process.env.WT_SUITE_LOCK_TEST_FLOOR_MIB = previous
  }
})
