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
  'host/suite-lock-machine.mjs': ['readSuiteMachine'],
  'host/suite-lock-reservations.mjs': ['pollReservationLease'],
  'host/suite-lock-watchdog.mjs': ['main'],
  // Explicit default-off admission changes queueAndRun's contract in round 5;
  // its switch, identity and environment are covered by the identity process locks.
  '../wt-suite-lock.mjs': ['forward'],
}
const helpers = ['holderAgeExpired', 'unpublishedLockDisappeared', 'sameLegacyInstance', 'queueClassFields',
  'coveredBrokerToken', 'windowsExecutableInDirectories', 'hasWindowsPath', 'reservationStatusLines',
  'optionalResourceStatus', 'machineValues', 'validMachineValues', 'machineAdmissionBlocked', 'recordFitBypasses', 'watchdogOwns',
  'cliReservationRequested', 'staticAncestorLease', 'replaceableCliRun', 'shouldRetryReservation', 'watchdogIdle',
  'recordCommandSignal', 'recordForwardedCommand']

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
  return Object.fromEntries(Object.keys(targets).map((file) => [file,
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
    let count = 0
    for (const [file, names] of Object.entries(targets)) {
      for (const name of names) {
        for (const variant of variants(name)) {
          const beforeHelpers = name === 'forward' ? { recordCommandSignal: reference[file].recordCommandSignal } : {}
          const before = await execute(reference[file][name], name, beforeHelpers, variant)
          let body = current[file][name]
          if (process.env.WT_ADMISSION_COMPARE_MUTATE === '1' && name === 'sameInstance') body = mutationCopy()
          if (process.env.WT_ADMISSION_COMPARE_MUTATE_FORWARD === '1' && name === 'forward') body = mutationCopy('forward')
          const after = await execute(body, name, current[file], variant)
          assert.deepEqual(after, before, `${name} variant ${JSON.stringify(variant)} must preserve its execution trace`)
          count++
        }
      }
    }
    console.log(`DIFFERENTIAL_CASES=${count} FUNCTIONS=12`)
  })
}

function mutationCopy(name = 'sameInstance') {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'admission-comparison-'))
  try {
    const file = path.join(scratch, 'copy.mjs')
    writeFileSync(file, name === 'forward' ? 'const forward = () => {}' : 'const sameInstance = () => false')
    return readFileSync(file, 'utf8')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

function variants(name) {
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
  const helperCode = helpers.filter((helper) => extra[helper]).map((helper) => extra[helper]).join('\n')
  const run = vm.runInNewContext(`${helperCode}\n${body}\n${name}`, environment.globals)
  let result
  let error
  try { result = await run(...environment.args.map((arg, index) => observed(arg, trace, `arg${index}`))) }
  catch (failure) { error = { name: failure.name, message: failure.message, code: failure.code } }
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
  const args = functionFixture(name, variant, globals, call, effects, trace)
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
  const queue = [{ number: 2 }, candidate]
  const machine = { availableMiB: v.mode === 'floor' ? 0 : 8192, floorMiB: 1024, unknown: v.mode === 'unknown' }
  if (v.mode === 'stale') state.watchdog.heartbeat = 0
  Object.assign(g, { reservationSection: call('section', (_root, critical) => v.mode === 'busy' ? 'busy' : critical()),
    prepareState: call('state', () => v.mode === 'no-state' ? null : state), reservedQueue: call('queue', () => queue),
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
