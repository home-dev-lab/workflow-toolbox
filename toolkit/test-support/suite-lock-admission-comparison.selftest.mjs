import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import tseslint from 'typescript-eslint'

const root = path.resolve(import.meta.dirname, '../..')
const referenceFile = new URL('./suite-lock-admission-before-quality.json', import.meta.url)
const targets = {
  'suite-lock.mjs': ['holderIsStale', 'tryTakeLock', 'sameInstance', 'waiterRecord', 'coveredSuiteLease', 'resolveWindowsExecutable'],
  'suite-lock-status.mjs': ['formatSuiteLockStatus', 'suiteLockStatusJson'],
  // Machine readings intentionally changed in round 5 (WSL, nominal budgets,
  // floor and freshness); recovery selftests lock that contract directly.
  'host/suite-lock-reservations.mjs': ['pollReservationLease'],
  'host/suite-lock-watchdog.mjs': ['main'],
  // Explicit default-off admission changes queueAndRun's contract in round 5;
  // its switch, identity and environment are covered by the identity process locks.
  '../wt-suite-lock.mjs': ['forward'],
}
const extractionTargets = { 'host/suite-lock-resources.mjs': ['linuxResourceTree'], 'host/suite-lock-queue.mjs': ['putLockBack'] }
const roundSevenTargets = { 'suite-lock-safety-net.mjs': ['age', 'victimOrder'],
  'host/suite-lock-reservations.mjs': ['readReservationState', 'reservationQueueStatus', 'finishReservationRelease'] }
// Frozen before the warning-only extractions; the earlier policy reference stays intact.
const roundSevenReference = {
  'suite-lock-safety-net.mjs': {
    age: `const age = (holder, sequenced) => {
  const primary = sequenced ? holder.admittedSequence : holder.startedAtMs
  return finite(primary) ? primary : finite(holder.admittedSequence) ? holder.admittedSequence : -Infinity
}`,
    victimOrder: `function victimOrder(left, right, sequenced) {
  const ordered = priority(right, 0) - priority(left, 0) || priority(right, 1) - priority(left, 1)
  if (ordered) return ordered
  if (age(left, sequenced) !== age(right, sequenced)) return age(left, sequenced) > age(right, sequenced) ? -1 : 1
  return String(left.leaseId) < String(right.leaseId) ? -1 : String(left.leaseId) > String(right.leaseId) ? 1 : 0
}`,
  },
  'host/suite-lock-reservations.mjs': {
    readReservationState: `function readReservationState(root) {
  try {
    const state = JSON.parse(readFileSync(stateFile(root), 'utf8'))
    if (state.version !== RESERVATION_PROTOCOL || !Array.isArray(state.holders)) throw new Error('invalid reservation state')
    return state
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}`,
    reservationQueueStatus: `function reservationQueueStatus(root, tickets) {
  if (!tickets.some((ticket) => ticket.record?.reservationProtocol === RESERVATION_PROTOCOL)) return tickets
  const machine = readSuiteMachine()
  const history = readSuiteResourceRuns(root)
  return tickets.map((ticket) => {
    const record = ticket.record
    if (record?.reservationProtocol !== RESERVATION_PROTOCOL) return ticket
    const runs = jobClassHistory(history, record)
    const reservation = machine.unknown ? { unknown: machine.unknown }
      : reservationForJob(runs, record.light === true ? 'light' : 'heavy', machine)
    return { ...ticket, reservation }
  })
}`,
    finishReservationRelease: `function finishReservationRelease(lease, outcome) {
  const state = readReservationState(lease.root)
  const holder = state?.holders.find((entry) => entry.leaseId === lease.holder.leaseId)
  if (!holder) return true
  const now = performance.timeOrigin + performance.now()
  const stop = holder.stop?.abandoned ? null : holder.stop
  const fields = { ...outcome, ...stoppedReleaseFields(stop),
    reservation: holder.reservation, overlaps: releaseOverlaps(holder, now) }
  retryStoppedLease(lease, outcome, stop)
  if (!terminalRecorded(lease.root, holder.leaseId)) {
    recordSuiteLockService(lease, fields)
    suiteJournalEvent(lease.journal, 'release', fields)
  }
  removeReleasedHolder(state, holder, stop, now)
  publish(lease.root, state)
  closeFence(lease.root, state)
  return true
}`,
  },
}
// Round 5 changed the policy of these two functions on purpose, so the traces recorded before it no longer
// describe them in the cases below. Each case is set aside by name, tied to the behaviour test that locks the
// new contract, and must still differ from the recording: an entry that matches again is an error.
const POLL_POLICY = 'Round 5 hands the reservation state to the machine reading and rechecks fresh sensors and the admission plan before publishing a grant; stale or unknown sensors plan an exclusive fallback.'
const POLL_LOCK = 'R5 publication rechecks the sensors after beforePublish'
const WATCHDOG_POLICY = 'Round 5 makes the elected watchdog confirm its ownership first and take machine samples from the Windows memory reader it owns.'
const WATCHDOG_LOCK = 'watchdog main owns and closes its WSL reader'
const policyExclusions = [
  ...['ok', 'stale', 'unknown', 'floor', 'not-head', 'replacement-waits'].map((mode) =>
    ({ function: 'pollReservationLease', variant: { mode }, policy: POLL_POLICY, lock: POLL_LOCK })),
  ...['ok', 'unknown', 'idle', 'busy'].map((mode) =>
    ({ function: 'main', variant: { mode }, policy: WATCHDOG_POLICY, lock: WATCHDOG_LOCK })),
]
const AUTHORIZED_EXCLUSIONS = [
  'pollReservationLease:ok', 'pollReservationLease:stale', 'pollReservationLease:unknown', 'pollReservationLease:floor',
  'pollReservationLease:not-head', 'pollReservationLease:replacement-waits',
  'main:ok', 'main:unknown', 'main:idle', 'main:busy',
]
const helpers = ['holderAgeExpired', 'unpublishedLockDisappeared', 'sameLegacyInstance', 'queueClassFields',
  'coveredBrokerToken', 'windowsExecutableInDirectories', 'hasWindowsPath', 'reservationStatusLines',
  'optionalResourceStatus', 'recordFitBypasses', 'watchdogOwns',
  'admissionMachine', 'machineReading', 'reservationSensorsFresh', 'fallbackMachine', 'recentSample',
  'freshWindowsSample', 'exclusiveFallback', 'safeReservationQueue', 'reservationPlan', 'supervise',
  'cliReservationRequested', 'staticAncestorLease', 'replaceableCliRun', 'shouldRetryReservation', 'watchdogIdle',
  'recordCommandSignal', 'recordForwardedCommand', 'retainedCountersRegressed', 'assertPutBackRetryable',
  'finite', 'age', 'priority', 'leaseIdOrder', 'queueStatusReservation', 'releaseHolderTransaction']

function declarations(text) {
  const parsed = tseslint.parser.parseForESLint(text, { sourceType: 'module', range: true, loc: true })
  const ast = parsed.ast
  const entries = []
  for (const statement of ast.body) {
    const node = statement.declaration ?? statement
    if (node.type === 'FunctionDeclaration') entries.push([node.id.name, text.slice(...node.range)])
    if (node.type === 'VariableDeclaration') {
      for (const item of node.declarations) {
        if (item.id.type === 'Identifier') entries.push([item.id.name, `${node.kind} ${text.slice(...item.range)};`])
      }
    }
  }
  const forward = findVariable(ast, 'forward', parsed.visitorKeys)
  if (forward) entries.push(['forward', `const ${text.slice(...forward.range)};`])
  return Object.fromEntries(entries)
}

function findVariable(node, name, keys) {
  if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === name) return node
  for (const key of keys[node.type] ?? []) {
    const children = Array.isArray(node[key]) ? node[key] : [node[key]]
    for (const child of children) {
      if (!child) continue
      const found = findVariable(child, name, keys)
      if (found) return found
    }
  }
  return null
}

function sources() {
  return Object.fromEntries(Object.keys({ ...targets, ...extractionTargets, ...roundSevenTargets }).map((file) => [file,
    declarations(readFileSync(path.join(root, 'plugin/bin/lib', file), 'utf8'))]))
}

const current = sources()
if (process.argv.includes('--capture')) {
  const selected = Object.fromEntries(Object.entries(targets).map(([file, names]) => [file,
    Object.fromEntries(names.map((name) => [name, current[file][name]]))]))
  writeFileSync(referenceFile, JSON.stringify(selected, null, 2) + '\n')
  console.log('Captured pre-quality function bodies (generated inert reference).')
} else if (process.argv.includes('--capture-forward')) {
  const reference = JSON.parse(readFileSync(referenceFile, 'utf8'))
  const file = '../wt-suite-lock.mjs'
  reference[file].forward = current[file].forward
  reference[file].recordCommandSignal = current[file].recordCommandSignal
  writeFileSync(referenceFile, JSON.stringify(reference, null, 2) + '\n')
  console.log('Captured signal-forwarding extraction reference; earlier references retained.')
} else {
  const reference = JSON.parse(readFileSync(referenceFile, 'utf8'))
  test('quality extraction preserves values, errors, reads, writes, this and outgoing call order', async () => {
    assert.deepEqual(policyExclusions.map(({ function: name, variant }) => `${name}:${variant.mode}`),
      AUTHORIZED_EXCLUSIONS, 'policy exclusions must remain exactly the ten authorized cases')
    const count = await compareTargets(reference, targets)
    console.log(`DIFFERENTIAL_CASES=${count} FUNCTIONS=${Object.values(targets).flat().length}`)
  })
  test('quality ceiling extractions preserve sampler and restore-lock execution traces', async () => {
    const count = await compareTargets(reference, extractionTargets)
    console.log(`EXTRACTION_CASES=${count} FUNCTIONS=2`)
  })
  test('round seven warning extractions preserve every read and release side effect', async () => {
    const count = await compareTargets(roundSevenReference, roundSevenTargets)
    console.log(`ROUND_SEVEN_CASES=${count} FUNCTIONS=5`)
  })
}

async function compareTargets(reference, selected) {
  let count = 0
  let excluded = 0
  const failures = []
  for (const [file, names] of Object.entries(selected)) {
      for (const name of names) {
        for (const variant of variants(name)) {
          const beforeHelpers = reference === roundSevenReference ? { ...current[file], ...reference[file] }
            : name === 'forward' ? { recordCommandSignal: reference[file].recordCommandSignal } : {}
          const before = await execute(reference[file][name], name, beforeHelpers, variant)
          const body = comparisonBody(file, name)
          const after = await execute(body, name, current[file], variant)
          const exclusion = policyExclusions.find((entry) => entry.function === name && JSON.stringify(entry.variant) === JSON.stringify(variant))
          if (exclusion) {
            assert.notDeepEqual(after, before, `${name} exclusion must still differ; remove an obsolete policy exclusion`)
            excluded++
            continue
          }
          try { assert.deepEqual(after, before, `${name} variant ${JSON.stringify(variant)} must preserve its execution trace`) }
          catch (error) { failures.push(error); console.error(`${name} variant ${JSON.stringify(variant)} must preserve its execution trace`) }
          count++
        }
      }
    }
  console.log(`COMPARISON_CASES=${count} MATCHED=${count - failures.length} EXCLUDED=${excluded} FUNCTIONS=${Object.values(selected).flat().length}`)
  if (failures.length) throw new AggregateError(failures, `${failures.length} execution traces differ from the frozen contract`)
  return count
}

function comparisonBody(file, name) {
  let body = current[file][name]
  if (process.env.WT_ADMISSION_COMPARE_MUTATE === '1' && name === 'sameInstance') body = mutationCopy()
  if (process.env.WT_ADMISSION_COMPARE_MUTATE_FORWARD === '1' && name === 'forward') body = mutationCopy('forward')
  if (process.env.WT_ADMISSION_COMPARE_MUTATE_EXTRA === name) body = mutationCopy(name)
  return body
}

function mutationCopy(name = 'sameInstance') {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'admission-comparison-'))
  try {
    const file = path.join(scratch, 'copy.mjs')
    writeFileSync(file, name === 'forward' ? 'const forward = () => {}' : `const ${name} = () => false`)
    return readFileSync(file, 'utf8')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

function variants(name) {
  if (Object.values(roundSevenTargets).flat().includes(name)) return ['ok', 'missing', 'unknown', 'denied', 'light', 'stop', 'abandoned', 'recorded'].map((mode) => ({ mode }))
  if (name === 'linuxResourceTree') return ['ok', 'reused', 'unknown', 'exit', 'regressed', 'missing', 'denied'].map((mode) => ({ mode }))
  if (name === 'putLockBack') return ['ok', 'retry', 'holder', 'expired', 'denied', 'null-error'].flatMap((mode) => [false, true].map((injected) => ({ mode, injected })))
  const legacy = legacyVariants(name)
  if (legacy) return legacy
  if (name === 'readSuiteMachine') return ['linux', 'darwin', 'win32'].flatMap((platform) => ['ok', 'missing', 'throw', 'invalid'].map((mode) => ({ platform, mode })))
  if (name === 'pollReservationLease') return ['ok', 'no-state', 'stale', 'unknown', 'floor', 'not-head', 'replacement-waits', 'busy'].map((mode) => ({ mode }))
  if (name === 'main') return ['ok', 'gone', 'foreign', 'unknown', 'idle', 'busy'].map((mode) => ({ mode }))
  if (name === 'queueAndRun') return ['linux', 'darwin', 'win32'].flatMap((platform) =>
    ['ok', 'refused', 'number', 'offloaded', 'requeue', 'throw'].map((mode) => ({ mode, platform })))
  if (name === 'forward') return [false, true].flatMap((marker) => [false, true].flatMap((group) =>
    [false, true].flatMap((reservation) => ['SIGTERM', 'SIGINT'].map((signal) => ({ marker, group, reservation, signal })))))
  return [true, false].flatMap((held) => [true, false].flatMap((resources) => [null, {}, { holders: [1] }, { holders: [], memory: { unknown: 'denied' } }]
    .map((reservations) => ({ held, resources, reservations }))))
}

function legacyVariants(name) {
  if (name === 'sameInstance') return [null, undefined, {}, { leaseId: 'x' }, { pid: 2, startedAt: 'a' }]
    .flatMap((left) => [null, undefined, {}, { leaseId: 'x' }, { pid: 2, startedAt: 'a' }].map((right) => ({ left, right })))
  if (name === 'holderIsStale') return ['linux', 'win32'].flatMap((platform) => [null, true, false].flatMap((foreign) =>
    [false, true].flatMap((gone) => [0, 100_000_000].map((age) => ({ platform, foreign, gone, age })))))
  if (name === 'tryTakeLock') return ['ok', 'exists', 'denied', 'reclaim', 'publish-gone', 'publish-exists', 'publish-denied'].map((mode) => ({ mode }))
  if (name === 'waiterRecord') return [true, false].flatMap((light) => ['release', 'P1', 'P2'].map((priority) => ({ light, priority })))
  if (name === 'coveredSuiteLease') return ['none', 'broker', 'broker-static', 'main', 'reservation', 'static', 'lost'].flatMap((mode) => [true, false].map((staticRequest) => ({ mode, staticRequest })))
  if (name === 'resolveWindowsExecutable') return ['node', 'dir/node', 'dir\\node', 'absent'].flatMap((executable) => [true, false].map((found) => ({ executable, found })))
  return null
}

function observed(value, trace, label, cache = new WeakMap()) {
  if (!value || typeof value !== 'object') return value
  if (cache.has(value)) return cache.get(value)
  const proxy = new Proxy(value, { get(target, key, receiver) {
    trace.push(`get:${label}.${String(key)}`)
    return observed(Reflect.get(target, key, receiver), trace, `${label}.${String(key)}`, cache)
  }, set(target, key, field, receiver) {
    trace.push(`set:${label}.${String(key)}:${JSON.stringify(copy(field))}`)
    return Reflect.set(target, key, field, receiver)
  } })
  cache.set(value, proxy)
  return proxy
}

const copy = (value) => value === undefined ? '[undefined]' : JSON.parse(JSON.stringify(value, (_key, field) => typeof field === 'function' ? '[function]' : field))

async function execute(body, name, extra, variant) {
  const trace = []
  const environment = fixture(name, variant, trace)
  const helperCode = helpers.filter((helper) => helper !== name && extra[helper]).map((helper) => extra[helper]).join('\n')
  const run = vm.runInNewContext(`${helperCode}\n${body}\n${name}`, environment.globals)
  let result
  let error
  try { result = await run(...environment.args.map((arg, index) => observed(arg, trace, `arg${index}`))) }
  catch (failure) { error = failure === null ? { thrown: null } : { name: failure.name, message: failure.message, code: failure.code } }
  const calls = [...trace]
  return { result: result === undefined ? '[undefined]' : copy(result), error, calls, effects: copy(environment.effects) }
}

function fixture(name, variant, trace) {
  const effects = {}
  const call = (key, implementation = () => undefined) => function (...args) {
    const receiver = this === undefined ? 'undefined' : Object.keys(this).sort().join('|')
    trace.push(`call:${key}:${receiver}:${JSON.stringify(copy(args))}`)
    return implementation.apply(this, args)
  }
  const globals = commonGlobals(call)
  globals.process.platform = variant.platform ?? 'linux'
  globals.reservationHostSupported = () => ['linux', 'darwin'].includes(globals.process.platform)
  globals.linuxAvailable = call('linuxAvailable', (read) => {
    const match = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(read('/proc/meminfo', 'utf8'))
    if (!match) throw new Error('MemAvailable unavailable')
    return Number(match[1]) / 1024
  })
  const args = Object.values(roundSevenTargets).flat().includes(name)
    ? roundSevenFixture(name, variant, globals, call, trace) : functionFixture(name, variant, globals, call, effects, trace)
  return { globals, args, effects }
}

function commonGlobals(call) {
  class FixedDate extends Date { static now() { return 200_000_000 } }
  return { path, Date: FixedDate, performance: { now: () => 123.5, timeOrigin: 1000 },
    process: { pid: 23, platform: 'linux', argv: ['node', 'fixture'], env: {}, cwd: call('cwd', () => '/cwd'),
      stderr: { write: call('stderr') }, stdout: { write: call('stdout') } },
    DEFAULT_SUITE_LOCK_STALE_S: 10_800, HALF_CREATED_LOCK_MS: 60_000, BOUNDED_P0_ORDER_VERSION: 3,
    SUITE_LOCK_ORDER_VERSION: 4, RESERVATION_PROTOCOL: 1, WATCHDOG_STALE_MS: 5000,
    MIB: 1024 ** 2, CPU_FACTOR: 0.8, MEMORY_FLOOR_MIB: 1024, OLDER_BROKER_QUEUE: 'older', RECLAIM_BUSY: 'busy',
    setTimeout: call('timer', (done) => { done(); return 1 }),
    readFileSync: call('readFileSync', () => 'MemAvailable: 4194304 kB\n'),
    freemem: call('freemem', () => 4 * 1024 ** 3), totalmem: call('totalmem', () => 8 * 1024 ** 3),
    availableParallelism: call('cpus', () => 8), loadavg: call('load', () => [2]),
  }
}

function functionFixture(name, v, g, call, effects, trace) {
  if (name === 'linuxResourceTree') return resourceTreeFixture(v, g, call, effects, trace)
  if (name === 'putLockBack') return putBackFixture(v, g, call, trace)
  if (name === 'sameInstance') return [v.left, v.right]
  if (name === 'holderIsStale') {
    Object.assign(g, { platformOf: call('platform', (options) => options.platform), positiveSeconds: call('seconds', Number),
      foreignNamespaceStale: call('foreign', () => v.foreign), pidProvesGone: call('gone', () => v.gone) })
    return [{ held: true, holder: { pid: 2, startTime: 1 }, ageMs: v.age }, { platform: v.platform }]
  }
  if (name === 'tryTakeLock') return lockFixture(v, g, call)
  if (name === 'waiterRecord') return waiterFixture(v, g, call)
  if (name === 'coveredSuiteLease') return coverageFixture(v, g, call)
  if (name === 'resolveWindowsExecutable') return [v.executable, { env: { PATH: '/one:/two', PATHEXT: '.EXE;.CMD' }, exists: call('exists', () => v.found) }]
  if (name === 'readSuiteMachine') return [machineFixture(v, call)]
  return executionFixture(name, v, g, call, effects, trace)
}

function roundSevenFixture(name, v, g, call, trace) {
  if (name === 'age') return roundAgeFixture(v)
  if (name === 'victimOrder') return [{ leaseId: v.mode === 'light' ? 'z' : 'a', level: 1,
    startedAtMs: v.mode === 'stop' ? 4 : 3 }, { leaseId: v.mode === 'recorded' ? 'a' : 'b', level: v.mode === 'denied' ? 2 : 1, startedAtMs: 3 }, false]
  if (name === 'readReservationState') return roundStateFixture(v, g, call)
  if (name === 'reservationQueueStatus') return roundQueueFixture(v, g, call)
  return roundReleaseFixture(v, g, call, trace)
}

function roundAgeFixture(v) {
  return [{ admittedSequence: v.mode === 'missing' ? undefined : 2,
    startedAtMs: v.mode === 'unknown' ? undefined : 3 }, v.mode === 'ok']
}

function roundStateFixture(v, g, call) {
    Object.assign(g, { stateFile: call('stateFile', (root) => root + '/reservations.json'), readFileSync: call('readFileSync', () => {
      if (['missing', 'denied'].includes(v.mode)) throw Object.assign(new Error(v.mode), { code: v.mode === 'missing' ? 'ENOENT' : 'EACCES' })
      return JSON.stringify({ version: v.mode === 'unknown' ? 2 : 1, holders: [] })
    }) })
    return ['/root']
}

function roundQueueFixture(v, g, call) {
    Object.assign(g, { readSuiteMachine: call('machine', () => ({ unknown: v.mode === 'unknown' ? 'missing' : undefined })),
      readSuiteResourceRuns: call('history', () => []), jobClassHistory: call('class', () => []), reservationForJob: call('reservation', () => ({})) })
    return ['/root', v.mode === 'missing' ? [] : [{ number: 1, record: { reservationProtocol: v.mode === 'denied' ? 0 : 1, light: v.mode === 'light' } }, { number: 2, record: {} }]]
}

function roundReleaseFixture(v, g, call, trace) {
  const holder = { leaseId: 'lease', reservation: {}, stop: v.mode === 'stop' ? { cause: 'signal' } : v.mode === 'abandoned' ? { abandoned: true } : undefined }
  const state = observed({ holders: v.mode === 'missing' ? [] : [holder] }, trace, 'state')
  Object.assign(g, { readReservationState: call('state', () => state), stoppedReleaseFields: call('stopped', () => ({})),
    releaseOverlaps: call('overlaps', () => []), retryStoppedLease: call('retry'), terminalRecorded: call('terminal', () => v.mode === 'recorded'),
    recordSuiteLockService: call('service'), suiteJournalEvent: call('journal'), removeReleasedHolder: call('remove'), publish: call('publish'), closeFence: call('close') })
  return [{ root: '/root', holder: { leaseId: 'lease' }, journal: {} }, { exit: 0 }]
}

function resourceTreeFixture(v, g, call, effects, trace) {
  const before = observed({ pid: 1, identity: 'root', cpuMs: 10, childCpuMs: 0 }, trace, 'previous-row')
  const rows = v.mode === 'missing' ? [] : [observed({ ...before, cpuMs: v.mode === 'regressed' ? 1 : 20 }, trace, 'current-row')]
  effects.retainedWrites = []
  const retained = { [Symbol.iterator]: () => [[before.identity, before]][Symbol.iterator](),
    clear: () => effects.retainedWrites.push('clear'), set: (key, value) => effects.retainedWrites.push([key, value]) }
  Object.assign(g, { linuxRows: call('linuxRows', async () => {
    if (v.mode === 'denied') throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return { rows: v.mode === 'reused' ? [{ ...before, identity: 'replacement' }] : rows }
  }), parentFirstFamily: call('parentFirstFamily', (family) => family), selectFamily: call('selectFamily', (family) => family),
  linuxFamilyRow: call('linuxFamilyRow', async (_procfs, _ticks, row) => v.mode === 'unknown' ? { unknown: 'unreadable' } : v.mode === 'exit' ? null : row),
  retainedCpuTotal: call('retainedCpuTotal', () => 20), unknown: call('unknown', (reason) => ({ unknown: reason })) })
  return [{}, 100, 1, retained, new Map(), undefined]
}

function putBackFixture(v, g, call, trace) {
  let attempts = 0
  const rename = call('rename', () => {
    if (v.mode === 'null-error') throw null
    if (v.mode === 'denied') throw observed(Object.assign(new Error('missing'), { code: 'ENOENT' }), trace, 'rename-error')
    if (v.mode !== 'ok' && attempts++ === 0) throw observed(Object.assign(new Error('busy'), { code: 'EEXIST' }), trace, 'rename-error')
  })
  Object.assign(g, { renameSync: rename, readHolderIn: call('readHolderIn', () => v.mode === 'holder' ? { pid: 2 } : null),
    rmSync: call('rmSync'), rmdirSync: call('rmdirSync', () => { throw new Error('still present') }),
    PUT_BACK_MAX_MS: 5000, PUT_BACK_STEP_MS: 5, Atomics: { wait: call('wait') } })
  return ['/saved', '/lock', { ...(v.injected ? { rename } : {}), ...(v.mode === 'expired' ? { maxMs: 0 } : {}) }]
}

function executionFixture(name, v, g, call, effects, trace) {
  if (name === 'pollReservationLease') return pollFixture(v, g, call, effects)
  if (name === 'main') return watchdogFixture(v, g, call)
  if (name === 'queueAndRun') return cliFixture(v, g, call, effects)
  if (name === 'forward') return forwardFixture(v, g, call, effects, trace)
  return statusFixture(v, g, call)
}

function forwardFixture(v, g, call, effects, trace) {
  effects.timing = { reservation: v.reservation, requeue: true, stopUnconfirmed: false, signalOutcome: null }
  effects.forwarded = null
  g.timing = observed(effects.timing, trace, 'timing')
  Object.defineProperty(g, 'forwardedSignal', { get: () => effects.forwarded,
    set: (signal) => { trace.push(`forwarded:${signal}`); effects.forwarded = signal }, configurable: true })
  Object.assign(g, { child: { kill: call('child.kill') }, marker: v.marker, group: v.group,
    signalCoveredCommand: call('signalCoveredCommand') })
  return [v.signal]
}

function lockFixture(v, g, call) {
  const fail = (code) => { throw Object.assign(new Error(code), { code }) }
  Object.assign(g, { mkdirSync: call('mkdir', () => { if (v.mode === 'exists') fail('EEXIST'); if (v.mode === 'denied') fail('EACCES') }),
    reclaimInFlight: call('reclaim', () => v.mode === 'reclaim'), abandonEmptyLockDir: call('abandon'), rmSync: call('remove'),
    writeFileSync: call('write', () => { if (v.mode.startsWith('publish-')) fail({ 'publish-gone': 'ENOENT', 'publish-exists': 'EEXIST', 'publish-denied': 'EACCES' }[v.mode]) }) })
  return ['/root/lock.d', { leaseId: 'fixture' }, call('before')]
}

function waiterFixture(v, g, call) {
  Object.assign(g, { journalWaiterRecord: call('journal', (record) => record), suiteLockNow: call('now', () => 1000),
    normalizeSuiteLockProject: call('project', (project) => project), currentPidNamespace: call('namespace', () => 'ns'),
    processStartTime: call('birth', () => 1), replacementQueueFields: call('replacement', () => ({})) })
  return [{ argv: ['fixture'], project: 'p', light: v.light, reservation: true }, { grants: 2, generation: 'g' }, v.priority, {}]
}

function coverageFixture(v, g, call) {
  Object.assign(g, { suiteLeaseToken: call('token', () => v.mode === 'none' ? null : { token: 'static:x', staticToken: v.mode === 'broker-static', id: 'x' }),
    readSuiteLock: call('lock', ({ root: directory }) => ({ holder: { leaseId: (v.mode === 'main' && directory === '/root') || (v.mode === 'static' && directory === '/root/static') ? 'x' : 'other' } })),
    reservationLeaseHeld: call('reservation', () => v.mode === 'reservation'), staticLeaseRoot: call('static', () => '/root/static') })
  return [{ WT_SUITE_LEASE: 'marker' }, v.mode.startsWith('broker') ? 'broker:fixture' : '/root', v.staticRequest]
}

function machineFixture(v, call) {
  return { platform: v.platform, read: call('read', () => v.mode === 'missing' ? '' : 'MemAvailable: 4194304 kB\n'),
    free: call('free', () => 4 * 1024 ** 3), total: call('total', () => 8 * 1024 ** 3),
    cpus: call('cpus', () => v.mode === 'invalid' ? 0 : 8), load: call('load', () => { if (v.mode === 'throw') throw new Error('denied'); return [2] }) }
}

function pollFixture(v, g, call, effects) {
  const state = { watchdog: { heartbeat: 200_000_000 }, holders: [], bypasses: {} }
  const candidate = { number: 1, effectiveLevel: 1, reason: {}, reservation: {} }
  const queue = [{ number: 2, reservation: {} }, candidate]
  const machine = { availableMiB: v.mode === 'floor' ? 0 : 8192, floorMiB: 1024, unknown: v.mode === 'unknown' }
  if (v.mode === 'stale') state.watchdog.heartbeat = 0
  Object.assign(g, { reservationSection: call('section', (_root, critical) => v.mode === 'busy' ? 'busy' : critical()),
    prepareState: call('state', () => v.mode === 'no-state' ? null : state), readReservationState: call('reread', () => state), reservedQueue: call('queue', () => queue),
    admissionPlan: call('plan', () => ({ admit: v.mode === 'not-head' ? [] : [1], blocked: [2] })),
    resolveReservationCommand: call('replacement', () => v.mode !== 'replacement-waits'),
    grantReservation: call('grant', (_root, _state, _candidate, holder) => { effects.state = state; return holder }) })
  // The new cold-start fence transition is tested with real legacy clients.
  // Differential cases here assume that this admission-time claim succeeds.
  g.claimCompatibilityFences = () => true
  return [{ root: '/root', lockDir: '/root/lock.d', ticket: 1, record: { argv: ['fixture'], replaceToken: 'token' } }, {}, { readMachine: call('machine', () => machine) }]
}

function watchdogFixture(v, g, call) {
  const state = { generation: 'g', watchdog: { pid: 23, heartbeat: 200_000_000 }, holders: [1], createdAt: 200_000_000 }
  if (v.mode === 'foreign') state.watchdog.pid = 42
  if (v.mode === 'idle') { state.holders = []; state.used = true }
  const readings = v.mode === 'gone' ? [] : [state]
  Object.assign(g, { readReservationState: call('state', () => readings.shift()),
    isWsl: () => false, startWindowsMemoryReader: () => assert.fail('plain Linux fixture must never start Windows reader'),
    readSuiteMachine: call('machine', () => v.mode === 'unknown' ? { unknown: 'denied' } : {}),
    watchReservationMemory: call('watch', () => v.mode === 'busy' ? 'busy' : true) })
  return ['/root', 'g']
}

function statusFixture(v, g, call) {
  for (const helper of ['safeHolder', 'safeValue', 'displayText']) g[helper] = call(helper, (value) => value)
  Object.assign(g, { appendHoldWarnings: call('warnings'), orderLines: call('order', () => []), queueLine: call('queueLine', () => 'q'),
    parkedStatusRows: call('parked', () => []), parkedLine: call('parkedLine'), holderHeadline: call('headline', () => 'held'),
    resourceClassLines: call('resources', () => ['resources']) })
  return [{ held: v.held, holder: {}, queue: [], reservations: v.reservations, resourceClasses: {}, parked: [] }, 'holder', { resources: v.resources }]
}

function cliFixture(v, g, call, effects) {
  const lease = { holder: {}, offloaded: v.mode === 'offloaded' ? { archive: 'fixture', exit: 0 } : undefined }
  const waiting = { signal: {}, close: call('close') }
  Object.assign(g, { lightScopeGuard: call('scope', () => ({ refused: v.mode === 'refused', end: call('end') })),
    watchSuiteWaitSignals: call('waiting', () => waiting), acquireParkCliLease: call('park', () => null), acquireSuiteLock: call('acquire'),
    acquireCliLease: call('acquireCli', async () => { if (v.mode === 'throw') throw new Error('denied'); return v.mode === 'number' ? 75 : lease }),
    runLeasedCommand: call('run', async (_command, _lease, options) => { options.timing.requeue = v.mode === 'requeue'; options.timing.heldMs = 7; return 0 }),
    suiteSignalExit: call('signal', () => null) })
  effects.options = { light: false, staticRun: false, park: null, waitS: 1, staleS: 2, attempt: {} }
  return [['fixture'], effects.options]
}
