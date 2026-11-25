import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'suite-identity-'))
const source = process.env.WT_ADMISSION_BIN ?? path.resolve(import.meta.dirname, '../../plugin/bin')
cpSync(source, path.join(scratch, 'bin'), { recursive: true })
mkdirSync(path.join(scratch, '.claude-plugin'))
cpSync(new URL('../../plugin/.claude-plugin/plugin.json', import.meta.url), path.join(scratch, '.claude-plugin/plugin.json'))
function instrument(file, before, replacement) {
  const target = path.join(scratch, 'bin', file)
  const text = readFileSync(target, 'utf8')
  assert.ok(text.includes(before), `instrumentation must match ${file}`)
  writeFileSync(target, text.replace(before, replacement))
}
instrument('lib/host/suite-lock-reservations.mjs', 'child = spawn(process.execPath,',
  "process.stderr.write('identity-watchdog-spawn\\n'); child = spawn(process.execPath,")
instrument('lib/host/suite-lock-reservations.mjs', 'function reservationSection(root, critical) {',
  "function reservationSection(root, critical) { process.stderr.write('identity-reservation-writer\\n');")
instrument('lib/suite-lock.mjs', 'function tryTakeLock(lockDir, holder, beforePublish) {',
  "function tryTakeLock(lockDir, holder, beforePublish) { process.stderr.write('identity-legacy-acquire\\n');")
instrument('lib/suite-lock.mjs', '  outcome = suiteLockReleaseOutcome(lease, outcome)',
  "  process.stderr.write('identity-legacy-release\\n'); outcome = suiteLockReleaseOutcome(lease, outcome)")
const machine = { cores: 20, load: 0, loadLimit: 20, memMiB: 30000, totalMiB: 40000, availableMiB: 31024, floorMiB: 1024 }
// Inject the reader in the disposable module, never through a machine-reading env override.
writeFileSync(path.join(scratch, 'bin/lib/host/suite-lock-machine.mjs'), `
export const reservationHostSupported = (platform = process.platform) => ['linux', 'darwin'].includes(platform)
export const readSuiteMachine = () => (${JSON.stringify(machine)})
`)
const children = new Set()
after(() => { for (const child of children) child.kill('SIGKILL'); rmSync(scratch, { recursive: true, force: true }) })
const imported = (file) => import(pathToFileURL(path.join(scratch, 'bin/lib', file)))
const api = await imported('suite-lock-admission.mjs')
const host = await imported('host/suite-lock-reservations.mjs')
const journal = await imported('suite-lock-journal.mjs')
const lock = await imported('suite-lock.mjs')
const cli = path.join(scratch, 'bin/wt-suite-lock.mjs')
const pause = () => new Promise((resolve) => setTimeout(resolve, 20))
const rootFor = (name) => mkdtempSync(path.join(scratch, `${name}-`))
const measured = (cores = 1, memMiB = 100, fields = {}) => ({ jobClass: 'repo:check', release: {
  exit: 0, overlaps: [], resources: { peakCores: cores, peakMemMiB: memMiB, wallMs: 1000, unknownReasons: [] }, ...fields,
} })
const history = (count = 3) => Array.from({ length: count }, () => measured())
const candidate = (number, reservation) => ({ number, reservation })
const processTest = (name, fn) => test(name, { skip: process.platform === 'win32' }, fn)

async function until(check, message) {
  const end = Date.now() + 8000
  while (Date.now() < end) { if (check()) return; await pause() }
  assert.fail(message)
}

function environment(root, overrides = {}) {
  const env = { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK: '1', WT_SUITE_LEASE: '', WT_SUITE_LOCK_BROKER: '' }
  for (const key of ['WT_SUITE_LOCK_ADMISSION', 'WT_SUITE_LOCK_JOB_CLASS', 'WT_SUITE_LEASE_MODE',
    'WT_SUITE_LEASE_RESERVATION', 'WT_SUITE_LEASE_RESERVATION_CORES', 'WT_SUITE_LEASE_RESERVATION_MEM_MIB']) delete env[key]
  return { ...env, ...overrides }
}

function launch(root, flags = [], overrides = {}, script) {
  const body = script ?? `const fs=require('fs'),p=${JSON.stringify(root)};
fs.writeFileSync(p+'/started',JSON.stringify(process.env));
const t=setInterval(()=>{if(fs.existsSync(p+'/done')){clearInterval(t)}},20)`
  const child = spawn(process.execPath, [cli, 'run', ...flags, '--', process.execPath, '-e', body], {
    env: environment(root, overrides), stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let stderr = ''
  let stdout = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdout.on('data', (chunk) => { stdout += chunk })
  return { child, stderr: () => stderr, stdout: () => stdout, ended: new Promise((resolve) => child.once('exit', resolve)) }
}

async function finish(run, root) {
  writeFileSync(path.join(root, 'done'), '')
  const code = await run.ended
  children.delete(run.child)
  return code
}

async function inspectRun(root, flags, env, inspect) {
  const run = launch(root, flags, env)
  try {
    await until(() => existsSync(path.join(root, 'started')) || run.child.exitCode !== null, 'covered command must start')
    assert.equal(run.child.exitCode, null, run.stderr())
    await inspect(run, JSON.parse(readFileSync(path.join(root, 'started'), 'utf8')))
  } finally { assert.equal(await finish(run, root), 0, run.stderr()) }
  return run
}

function assertUnmanaged(root, env) {
  for (const name of ['reservations.json', 'reservation-write.d', 'watchdog.log']) {
    assert.equal(existsSync(path.join(root, name)), false, `default-off must not create ${name}`)
  }
  const holder = JSON.parse(readFileSync(path.join(root, 'lock.d/holder.json'), 'utf8'))
  assert.equal(holder.reservationProtocol, undefined, 'default-off must use the legacy acquisition')
  for (const name of ['WT_SUITE_LEASE_MODE', 'WT_SUITE_LEASE_RESERVATION', 'WT_SUITE_LEASE_RESERVATION_CORES', 'WT_SUITE_LEASE_RESERVATION_MEM_MIB']) {
    assert.equal(env[name], undefined, 'unmanaged child has no managed lease variables')
  }
}

processTest('switch defaults off and uses legacy acquisition and release without a watchdog', async () => {
  const root = rootFor('default')
  const run = await inspectRun(root, [], { WT_SUITE_LEASE_MODE: 'reservation', WT_SUITE_LEASE_RESERVATION: '{}',
    WT_SUITE_LEASE_RESERVATION_CORES: '99', WT_SUITE_LEASE_RESERVATION_MEM_MIB: '99' }, (_run, env) => assertUnmanaged(root, env))
  assert.match(run.stderr(), /identity-legacy-acquire/)
  assert.match(run.stderr(), /identity-legacy-release/)
  assert.doesNotMatch(run.stderr(), /identity-(?:watchdog-spawn|reservation-writer)/, 'default path never enters a writer or spawns a watchdog')
  assert.equal(existsSync(path.join(root, 'lock.d')), false, 'legacy release removes its holder')
  const rows = journal.readSuiteLockJournal(root).tickets
  assert.equal(rows.length, 1)
  assert.ok(rows[0].release.resources, 'phase-one measurement still records a resource row')
})

processTest('explicit reservation switch creates managed state and a live watchdog', async () => {
  const root = rootFor('enabled')
  const run = await inspectRun(root, [], { WT_SUITE_LOCK_ADMISSION: 'reservation' }, (_run, env) => {
    const state = host.readReservationState(root)
    assert.equal(state.holders.length, 1, 'enabled control must create reservation state')
    assert.ok(state.watchdog.pid > 0, 'enabled control must spawn a watchdog')
    assert.doesNotThrow(() => process.kill(state.watchdog.pid, 0))
    assert.equal(JSON.parse(readFileSync(path.join(root, 'lock.d/holder.json'))).reservationProtocol, 1)
    assert.equal(env.WT_SUITE_LEASE_MODE, 'exclusive')
  })
  assert.match(run.stderr(), /identity-watchdog-spawn/, 'enabled control must exercise the actual watchdog spawn')
  assert.match(run.stderr(), /identity-reservation-writer/)
})

processTest('marker enables reservations and exclusive overrides the marker', async () => {
  for (const value of [undefined, 'exclusive']) {
    const root = rootFor('marker')
    writeFileSync(path.join(root, 'admission-reservation.enabled'), '')
    const env = value ? { WT_SUITE_LOCK_ADMISSION: value } : {}
    await inspectRun(root, [], env, (_run, childEnv) => {
      if (value) assertUnmanaged(root, childEnv)
      else assert.equal(host.readReservationState(root)?.holders.length, 1, 'marker alone must enable reservations')
    })
  }
})

processTest('invalid switch warns once and is treated as unset including marker fallback', async () => {
  for (const marker of [false, true]) {
    const root = rootFor('invalid-switch')
    if (marker) writeFileSync(path.join(root, 'admission-reservation.enabled'), '')
    const run = await inspectRun(root, [], { WT_SUITE_LOCK_ADMISSION: 'invalid' }, (_run, env) => {
      if (marker) assert.equal(host.readReservationState(root)?.holders.length, 1)
      else assertUnmanaged(root, env)
    })
    assert.equal(run.stderr().split('\n').filter((line) => /invalid.*WT_SUITE_LOCK_ADMISSION/.test(line)).length, 1,
      'invalid admission switch must warn exactly once')
  }
})

processTest('flag job class wins and request and release journal the explicit identity', async () => {
  const root = rootFor('flag')
  await inspectRun(root, ['--job-class', 'repo:check'], { WT_SUITE_LOCK_JOB_CLASS: 'wrong' }, (_run, env) => {
    assert.equal(env.WT_SUITE_LOCK_JOB_CLASS, undefined, 'flag class must also be absent from the child environment')
  })
  const [row] = journal.readSuiteLockJournal(root).tickets
  assert.equal(row.request.jobClass, 'repo:check', 'request must record the flag class')
  assert.equal(row.release.jobClass, 'repo:check', 'release must retain the flag class')
})

processTest('environment supplies job class and nested CLI cannot inherit it', async () => {
  const root = rootFor('nested')
  const script = `require('child_process').execFileSync(process.execPath,[${JSON.stringify(cli)},'run','--',process.execPath,'-e',
    'process.stdout.write(JSON.stringify(process.env))'],{stdio:'inherit'})`
  const run = launch(root, [], { WT_SUITE_LOCK_JOB_CLASS: 'repo:check' }, script)
  assert.equal(await run.ended, 0, run.stderr())
  children.delete(run.child)
  assert.equal(JSON.parse(run.stdout()).WT_SUITE_LOCK_JOB_CLASS, undefined, 'nested run must not inherit the outer job class')
  const [row] = journal.readSuiteLockJournal(root).tickets
  assert.equal(row.release.jobClass, 'repo:check', 'environment class must be journalled')
})

processTest('job class format accepts boundaries and rejects invalid input with one warning', async () => {
  const values = ['a', `A${'b'.repeat(63)}`, 'repo.check:unit-test_1', '', '-bad', 'has space', 'a'.repeat(65)]
  for (const value of values) {
    const root = rootFor('format')
    const run = launch(root, ['--job-class', value], { WT_SUITE_LOCK_JOB_CLASS: 'fallback' }, 'process.exit(0)')
    assert.equal(await run.ended, 0, 'invalid class must be ignored rather than refusing the command')
    children.delete(run.child)
    const valid = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
    assert.equal(journal.readSuiteLockJournal(root).tickets[0].release.jobClass, valid ? value : undefined)
    assert.equal(run.stderr().split('\n').filter((line) => /invalid.*job.class/i.test(line)).length, valid ? 0 : 1)
  }
})

function seed(root, runs, jobClass = 'repo:check', cmd = 'other') {
  const rows = runs.map((run, index) => ({ leaseId: `seed-${index}`, event: 'release', kind: 'exclusive',
    ts: new Date().toISOString(), cmd, jobClass, ...run.release }))
  writeFileSync(path.join(root, 'journal.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

const queueRecord = (jobClass) => ({ reservationProtocol: 1, light: true, jobClass, journal: { cmd: 'other', jobClass },
  argv: ['setpriv', '--pdeathsig', 'TERM', 'bash', '-c', '<wrapper>', '<scratch>', '123', '<script>', '<deadline>', '<entry>', 'bash', 'workload.sh'] })
const statusReservation = (root, jobClass) => host.reservationQueueStatus(root, [{ number: 1, record: queueRecord(jobClass) }])[0].reservation

test('history is keyed only by job class even for identical wrapper argv categories', () => {
  const root = rootFor('class-key')
  assert.equal(journal.journalCommand(queueRecord().argv), 'other')
  seed(root, history())
  assert.equal(statusReservation(root, 'repo:check').basis, 'measured', 'matching class must train admission')
  assert.equal(statusReservation(root, 'different:check').mode, 'exclusive', 'different class must not borrow other history')
  assert.equal(statusReservation(root, undefined).mode, 'exclusive', 'classless wrapper must not borrow other history')
})

test('timing sensitivity is confined to the explicit workload class', () => {
  const root = rootFor('timing-class')
  seed(root, history())
  journal.suiteJournalEvent({ base: { root, leaseId: 'foreign-red', kind: 'exclusive', cmd: 'other', jobClass: 'different:check' } },
    'release', { ...measured().release, exit: 1, overlaps: [{ leaseId: 'peer', durationMs: 1 }] })
  assert.equal(statusReservation(root, 'repo:check').basis, 'measured', 'another class red must not poison this class timing history')
})

processTest('classless wrapper remains exclusive despite other history for heavy and light', async () => {
  for (const flags of [[], ['--light']]) {
    const root = rootFor('wrapper')
    seed(root, history(), null)
    await inspectRun(root, flags, { WT_SUITE_LOCK_ADMISSION: 'reservation' }, (_run, env) => {
      assert.equal(env.WT_SUITE_LEASE_MODE, 'exclusive', 'classless wrapper may never become shareable from argv')
    })
  }
})

test('unmeasured heavy and light both reserve exclusive declared slots', () => {
  for (const declared of ['heavy', 'light']) {
    assert.equal(api.reservationForJob([], declared, machine).mode, 'exclusive', 'unmeasured light is exclusive too')
  }
})

test('failed and memory-stopped runs cannot train reservations', () => {
  for (const exit of [75, 1, 137, null, 'unknown', undefined]) {
    const runs = history().map((run) => ({ ...run, release: { ...run.release, exit, cause: 'memory-pressure' } }))
    assert.equal(api.reservationForJob(runs, 'heavy', machine).basis, 'declared', 'only exit-zero runs train reservations')
  }
})

test('newer successful incomplete resources revoke old measurements until three complete successes', () => {
  const partial = measured(1, 100)
  partial.release.resources.unknownReasons = ['sample-unavailable']
  const runs = [...history(), partial]
  assert.equal(api.reservationForJob(runs, 'heavy', machine).basis, 'declared', 'new successful incomplete sample must revoke measured status')
  assert.equal(api.reservationForJob([...runs, ...history(2)], 'heavy', machine).basis, 'declared')
  assert.equal(api.reservationForJob([...runs, ...history()], 'heavy', machine).basis, 'measured')
})

test('failed rows between three greens are ignored but still occupy the ten-release window', () => {
  const red = measured(1000, 1000000, { exit: 1, cause: 'signal' })
  assert.equal(api.reservationForJob([measured(), red, measured(), red, measured()], 'heavy', machine).cores, 1.25)
  assert.equal(api.reservationForJob([...history(), ...Array(8).fill(red)], 'heavy', machine).basis, 'declared',
    'latest ten resource releases must contain three qualifying successes')
})

test('resource window includes disqualifying rows and excludes rows with no resources record', () => {
  const incomplete = measured()
  incomplete.release.resources.peakCores = null
  const runs = [measured(10), ...history(9), incomplete]
  assert.equal(api.reservationForJob(runs, 'heavy', machine).basis, 'declared')
  assert.equal(api.reservationForJob([...history(), ...Array(20).fill({ release: { exit: 0 } })], 'heavy', machine).basis, 'measured')
})

test('complete peaks with a null wall time qualify without inventing a duration requirement', () => {
  const runs = history()
  for (const run of runs) run.release.resources.wallMs = null
  assert.equal(api.reservationForJob(runs, 'heavy', machine).basis, 'measured', 'finite peaks and no unknown reasons qualify even without wall time')
})

test('measured peaks use all trainable rows in the window at full precision', () => {
  const runs = [measured(2.00000001, 999.00000001), ...history(9)]
  const value = api.reservationForJob(runs, 'heavy', machine)
  assert.equal(value.cores, 2.00000001 * 1.25)
  assert.equal(value.memMiB, 999.00000001 * 1.25)
  assert.equal(api.reservationForJob([...runs, measured()], 'heavy', machine).cores, 1.25)
})

test('oversize measurements become exclusive and remain runnable alone under any load', () => {
  for (const runs of [history().map(() => measured(20, 100)), history().map(() => measured(1, 40000))]) {
    const value = api.reservationForJob(runs, 'heavy', machine)
    assert.equal(value.basis, 'measured-oversize', 'oversize measurement must become exclusive')
    const plan = api.admissionPlan([candidate(1, value), candidate(2, { mode: 'reservation', cores: 1, memMiB: 100 })], [],
      { ...machine, load: 999 }, { 1: api.ADMISSION_BYPASS_LIMIT })
    assert.deepEqual(plan, { admit: [1], blocked: [2] }, 'oversize head runs alone without accumulating fit bypasses')
  }
})

test('nominal total memory distinguishes temporarily unavailable from oversize', () => {
  const value = api.reservationForJob(history().map(() => measured(1, 1000)), 'heavy', { ...machine, memMiB: 100 })
  assert.equal(value.basis, 'measured', 'low current availability must not relabel a nominally fitting measurement oversize')
  assert.deepEqual(api.admissionPlan([candidate(1, value)], [], { ...machine, memMiB: 100 }, {}).admit, [])
})

test('load plus candidate and sum of holders each stay within online CPUs', () => {
  const queue = Array.from({ length: 24 }, (_, index) => candidate(index + 1, { mode: 'reservation', cores: 1, memMiB: 100 }))
  assert.equal(api.admissionPlan(queue, [], { ...machine, load: 8 }, {}).admit.length, 20, 'twenty-four one-core jobs cannot all fit twenty CPUs')
  assert.deepEqual(api.admissionPlan([candidate(1, { mode: 'reservation', cores: 13, memMiB: 100 })], [], { ...machine, load: 8 }, {}).admit, [],
    'one-minute load plus candidate must fit online CPUs')
})

test('CPU overload blocks shared admissions without a job count cap or memory stop', () => {
  const value = { mode: 'reservation', cores: 0.01, memMiB: 1 }
  const queue = Array.from({ length: 1024 }, (_, index) => candidate(index + 1, value))
  assert.equal(api.admissionPlan(queue, [], machine, {}).admit.length, 1024, 'all 1024 fitting jobs must be admitted')
  assert.deepEqual(api.admissionPlan(queue, [], { ...machine, load: 20.01 }, {}).admit, [])
  assert.equal(api.watchdogDecision([{ leaseId: 'alive', reservation: value }], { ...machine, load: 20.01 }), null,
    'overloaded CPU information must not become a memory stop')
})

test('exclusive candidate needs no machine-reading or load precondition', () => {
  const exclusive = { mode: 'exclusive', cores: 20, memMiB: 30000, basis: 'declared' }
  assert.deepEqual(api.admissionPlan([candidate(1, exclusive)], [], { unknown: 'machine-source-unavailable' }, {}).admit, [1],
    'exclusive work must stay runnable with unknown sensors')
})

test('reservation environment emits positive ceilings only for managed shared leases', () => {
  const lease = { reservationLease: true, holder: { reservation: { mode: 'reservation', cores: 0.00001, memMiB: 512.01, basis: 'measured' } } }
  const env = host.reservationEnvironment(lease)
  assert.equal(env.WT_SUITE_LEASE_RESERVATION_CORES, '1', 'core environment value is a positive integer ceiling')
  assert.equal(env.WT_SUITE_LEASE_RESERVATION_MEM_MIB, '513')
  assert.deepEqual(JSON.parse(env.WT_SUITE_LEASE_RESERVATION), lease.holder.reservation)
  const exclusive = host.reservationEnvironment({ reservationLease: true, holder: { reservation: { mode: 'exclusive' } } })
  assert.equal(exclusive.WT_SUITE_LEASE_MODE, 'exclusive')
  assert.equal(exclusive.WT_SUITE_LEASE_RESERVATION_CORES, undefined)
  assert.equal(exclusive.WT_SUITE_LEASE_RESERVATION_MEM_MIB, undefined)
  assert.deepEqual(host.reservationEnvironment({ holder: {} }), {}, 'unmanaged leases emit no reservation variables')
})

test('child environment removes managed keys using native platform case rules', () => {
  const body = readFileSync(cli, 'utf8').match(/function commandEnvironment\(\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(body, 'exercise the real command environment helper')
  const input = { WT_SUITE_LOCK_JOB_CLASS: 'outer', wt_suite_lock_job_class: 'outer-lower',
    WT_SUITE_LEASE_MODE: 'reservation', wt_suite_lease_reservation_cores: '99',
    WT_SUITE_LEASE_RESERVATION_MEM_MIB: '99', WT_SUITE_LEASE_RESERVATION: '{}', KEEP: 'value' }
  for (const platform of ['linux', 'darwin', 'win32']) {
    const value = vm.runInNewContext(`${body}; commandEnvironment()`, { process: { env: input, platform } })
    assert.equal(value.WT_SUITE_LOCK_JOB_CLASS, undefined)
    assert.equal(value.WT_SUITE_LEASE_MODE, undefined)
    assert.equal(value.WT_SUITE_LEASE_RESERVATION_MEM_MIB, undefined)
    assert.equal(value.WT_SUITE_LEASE_RESERVATION, undefined)
    assert.equal(value.wt_suite_lock_job_class, platform === 'win32' ? undefined : 'outer-lower')
    assert.equal(value.wt_suite_lease_reservation_cores, platform === 'win32' ? undefined : '99')
    assert.equal(value.KEEP, 'value')
  }
  assert.equal(input.WT_SUITE_LOCK_JOB_CLASS, 'outer', 'sanitizing must not mutate the launcher environment')
})

processTest('status shows switch and waiting and running identity mode reservation and basis', async () => {
  const root = rootFor('status')
  seed(root, history())
  await inspectRun(root, ['--job-class', 'repo:check'], { WT_SUITE_LOCK_ADMISSION: 'reservation' }, async () => {
    const waiting = launch(root, ['--job-class', 'unmeasured:check'], { WT_SUITE_LOCK_ADMISSION: 'reservation' }, 'process.exit(0)')
    try {
      await until(() => lock.readSuiteLockStatus({ root }).queue.length === 1, 'exclusive waiter must queue behind reservation')
      for (const json of [false, true]) {
        const args = [cli, 'status', ...(json ? ['--json'] : [])]
        const child = spawn(process.execPath, args, { env: environment(root, { WT_SUITE_LOCK_ADMISSION: 'reservation' }), stdio: ['ignore', 'pipe', 'pipe'] })
        let text = ''
        child.stdout.on('data', (chunk) => { text += chunk })
        assert.equal(await new Promise((resolve) => child.once('exit', resolve)), 0)
        assert.match(text, /repo:check/, 'running class must be visible')
        assert.match(text, /unmeasured:check/, 'waiting class must be visible')
        if (json) {
          const state = JSON.parse(text)
          assert.equal(state.admission.enabled, true, 'status must expose the effective switch')
          assert.equal(state.queue[0].jobClass, 'unmeasured:check')
          assert.equal(state.queue[0].reservation.basis, 'declared')
        } else {
          assert.match(text, /admission.*on/)
          assert.match(text, /reservation.*measured/)
          assert.match(text, /exclusive.*declared/)
        }
      }
    } finally { waiting.child.kill('SIGTERM'); await waiting.ended; children.delete(waiting.child) }
  })
})

processTest('status retains legacy running identity after a reservation epoch has emptied', async () => {
  const root = rootFor('legacy-status')
  writeFileSync(path.join(root, 'reservations.json'), JSON.stringify({ version: 1, generation: 'previous', holders: [], bypasses: {} }))
  await inspectRun(root, ['--job-class', 'repo:legacy'], {}, async () => {
    const child = spawn(process.execPath, [cli, 'status', '--json'], { env: environment(root), stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', (chunk) => { text += chunk })
    assert.equal(await new Promise((resolve) => child.once('exit', resolve)), 0)
    const state = JSON.parse(text)
    assert.equal(state.admission.enabled, false)
    assert.equal(state.admission.running.length, 1, 'an empty prior epoch must not hide the current legacy holder')
    assert.equal(state.admission.running[0].jobClass, 'repo:legacy')
    assert.equal(state.admission.running[0].reservation.mode, 'exclusive')
    assert.equal(state.admission.totals.cores, null, 'unknown legacy budgets must not be summed as zero')
  })
})
