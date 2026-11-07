import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { runInNewContext } from 'node:vm'

const ts = createRequire(import.meta.url)('typescript')
const reference = readFileSync(new URL('./suite-lock-acquire-before-split.txt', import.meta.url), 'utf8')
const names = new Set(['acquireSuiteLock', 'suiteBroker', 'prepareSuiteWait', 'observeSuiteHandover', 'renewSuiteHandover', 'observeSuitePlace', 'remainingSuiteWait', 'noticeSuiteWait'])
const cases = [
  {}, { inherited: true }, { broker: ' endpoint ' }, { broker: 'endpoint', root: true }, { light: true },
  { steps: ['again', 'grant'] }, { steps: ['head', 'grant'] }, { steps: ['empty', 'grant'] },
  { steps: ['release', 'grant'] }, { steps: ['wait', 'handover', 'release', 'grant'] },
  { steps: ['wait', 'wait', 'head', 'grant'], advanced: true, noticeMs: 0 },
  { steps: ['wait', 'wait', 'grant'], callbacks: false }, { waitS: 0, steps: ['wait'] },
  { steps: ['wait', 'wait'], timeout: true }, { steps: ['again'], waitS: 0 },
  { abortAt: 1 }, { abortAt: 2 }, { errorAt: 'ticket' }, { errorAt: 'poll' },
  { errorAt: 'mkdir' }, { errorAt: 'priority' }, { errorAt: 'finish' },
  { callbackThrows: 'onHandover', steps: ['wait'] }, { callbackThrows: 'onWait', steps: ['wait'] },
  { callbackThrows: 'onRenew', steps: ['wait'], advanced: true },
  { getterThrows: 'signal:2' }, { getterThrows: 'waitS:1' }, { getterThrows: 'staleS:1' },
  { getterThrows: 'pollMs:1' }, { getterThrows: 'noticeMs:1' },
  { getterThrows: 'onWait:1', steps: ['wait'] }, { missingEnv: true },
  { park: true, resumed: true }, { park: true, resumed: true, abortAt: 2 },
  { park: true, resumed: true, steps: ['wait', 'head', 'grant'] },
  { broker: 'endpoint', errorAt: 'broker' }, { defaultWait: true }, { defaultStale: true },
  { defaultOptions: true }, { steps: ['again-no-place', 'grant'] },
]

function currentFunctions(cli) {
  const source = readFileSync(path.join(path.dirname(cli), 'lib/suite-lock.mjs'), 'utf8')
  const parsed = ts.createSourceFile('suite-lock.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  return parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map((node) => node.getText(parsed)).join('\n')
}

function tracker() {
  const trace = [], injected = new WeakSet()
  const state = { ids: new WeakMap(), inputs: new Map(), snapshots: [], next: 0 }
  const tag = (value) => taggedValue(value, state)
  return { trace, tag, named: (value, name) => { state.ids.set(value, name); if (typeof value === 'object') state.inputs.set(name, value); return value },
    end: () => ({ inputs: [...state.inputs].map(([name, value]) => [name, describeOwnData(value, tag)]), snapshots: state.snapshots }),
    call: (name, ...args) => trace.push([name, ...args.map(tag)]),
    error: (name) => { const error = new Error(name); injected.add(error); return error }, isInjected: (error) => injected.has(error) }
}

function taggedValue(value, state) {
  if (value === null || !['object', 'function'].includes(typeof value)) return value
  if (!state.ids.has(value)) {
    const id = `object-${++state.next}`
    state.ids.set(value, id)
    if (typeof value === 'object') state.snapshots.push([id, describeOwnData(value, (item) => taggedValue(item, state))])
  }
  return state.ids.get(value)
}

function describeOwnData(value, tag, error = false) {
  return Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([key]) => !error || key !== 'stack').map(([key, descriptor]) =>
    [key, descriptor.enumerable, descriptor.configurable, ...('value' in descriptor
      ? ['data', descriptor.writable, tag(descriptor.value)] : ['accessor', tag(descriptor.get), tag(descriptor.set)])])
}

function observedOptions(config, t, env) {
  const counts = new Map()
  const values = { env: config.missingEnv ? undefined : env, root: config.root ? '/queue' : undefined,
    waitS: config.defaultWait ? undefined : config.waitS ?? 1, staleS: config.defaultStale ? undefined : 1, pollMs: 8, noticeMs: config.noticeMs ?? 1,
    ...(config.park ? { park: t.named({ capability: true }, 'park') } : {}) }
  let proxy
  for (const name of ['onHandover', 'onProgress', 'onRenew', 'onWait']) {
    if (config.callbacks === false) continue
    values[name] = function (...args) { t.call(`callback:${name}`, this === proxy, ...args); if (config.callbackThrows === name) throw t.error(`callback:${name}`) }
  }
  proxy = new Proxy(values, { get(target, key) {
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    t.call('get:options', key)
    if (config.getterThrows === `${String(key)}:${count}`) throw t.error(`getter:${String(key)}`)
    return target[key]
  } })
  return t.named(proxy, 'options')
}

function queueSteps(config, t, lease) {
  return (config.steps ?? ['grant']).map((kind, i) => {
    if (kind === 'grant') return observedRecord(t, { lease }, `step-${i}`)
    const place = observedRecord(t, { ahead: kind === 'head' ? 0 : 2, aheadExcludingRelease: kind === 'head' ? 0 : 2, total: 4 }, `place-${i}`)
    const holder = kind === 'empty' ? null : observedRecord(t, { leaseId: kind === 'handover' ? 'h2' : 'h1', priority: kind === 'release' ? 'release' : 'P1' }, `holder-${i}`)
    const current = observedRecord(t, { held: kind !== 'empty', holder }, `current-${i}`)
    return observedRecord(t, queueStepFields(kind, place, current), `step-${i}`)
  })
}

function queueStepFields(kind, place, current) {
  if (kind === 'again-no-place') return { again: true, current }
  return { place, current, ...(kind === 'again' ? { again: true } : {}) }
}

function observedRecord(t, value, name) {
  return t.named(new Proxy(value, { get(target, key) { t.call(`get:${name}`, key); return target[key] } }), name)
}

function baseDependencies(config, t, env, lease) {
  let guards = 0, retries = 0, clock = 0
  return {
    process: { env }, path: path.posix, DEFAULT_SUITE_LOCK_STALE_S: 10, HEAD_OF_QUEUE_POLL_MS: 100, TICKET_HEARTBEAT_MAX_MS: 30_000,
    Date: { now() { t.call('clock'); return config.timeout ? clock++ * 2000 : clock++ } },
    acquisitionPriority(options, environment) { t.call('priority', options, environment); if (config.errorAt === 'priority') throw t.error('priority'); return 'P2' },
    throwIfAborted(signal) { t.call('abort', signal); if (++guards === config.abortAt) throw Object.assign(t.error('aborted'), { code: 'ABORT_ERR' }) },
    suiteLeaseDomain(options) { t.call('domain', ...Object.entries(options).flat()); return '/queue' },
    coveredSuiteLease(environment, domain) { t.call('covered', environment, domain); return config.inherited ? 'ancestor' : null },
    acquireBrokerSuiteLock(broker, options) { t.call('broker', broker, options); if (config.errorAt === 'broker') throw t.error('broker'); return lease },
    positiveSeconds(value, name) { t.call('seconds', value, name); return value },
    suiteLockWaitSeconds(environment) { t.call('wait-seconds', environment); return 1 },
    retryTransient(operation, pause) {
      const id = ++retries
      t.call('retry', id, pause)
      queueMicrotask(() => { t.call('microtask', id, 1); queueMicrotask(() => t.call('microtask', id, 2)) })
      return operation()
    },
    waiterBudget(...args) { t.call('budget', ...args); return args[0] },
    sleep(...args) { t.call('sleep', ...args); return Promise.resolve() },
    formatSuiteLockHolder(holder) { t.call('format', holder); return 'holder' },
    progressPlace(place) { t.call('progress-place', place); return place },
    describeWait(...args) { t.call('describe', ...args); return 'placement' },
    suiteQueueAdvanced(...args) { t.call('advanced', ...args); return Boolean(config.advanced) },
  }
}

function queueDependencies(config, t, options, steps, lease) {
  const record = t.named({ record: true }, 'record')
  const counter = t.named({ grants: 0 }, 'counter')
  const fields = t.named({}, 'p0-fields')
  const judge = t.named(() => false, 'judge')
  let poll = 0
  return {
    mkdirSync(...args) { t.call('mkdir', ...args); if (config.errorAt === 'mkdir') throw t.error('mkdir') },
    ensureLightCounter(root) { t.call('counter', root); return counter },
    p0QueueFields(...args) { t.call('p0', ...args); return fields },
    waiterRecord(...args) { t.call('record', ...args); return record },
    parkOwnerJudge(value) { t.call('judge', value); return judge },
    takeParkTicket(...args) { t.call('ticket', ...args); if (config.errorAt === 'ticket') throw t.error('ticket'); return 7 },
    parkQueueMetadata(value) { t.call('metadata', value); return config.resumed ? { resumed: t.named({}, 'resumed') } : {} },
    pollQueue(state, value) { t.call('poll', state, value); if (config.errorAt === 'poll') throw t.error('poll'); return steps[poll++] ?? { lease } },
    readSuiteLock(value) { t.call('read-lock', value.root); return steps[poll - 1].current },
    grantParkState(state, value) { t.call('grant', state, value); state.granted = true; return value },
    finishParkQueue(state, context, remove) {
      t.call('finish', state, context, state.root, state.lockDir, state.queueDir, state.ticket, state.record, state.resumed, state.granted)
      remove()
      if (config.errorAt === 'finish') throw t.error('finish')
    },
    removeTicket(...args) { t.call('remove', ...args) },
    options,
  }
}

async function observe(source, config) {
  const t = tracker()
  const env = t.named(new Proxy({ WT_SUITE_LOCK_BROKER: config.broker }, { get(target, key) { t.call('get:env', key); return target[key] } }), 'env')
  const options = observedOptions(config, t, env)
  const lease = t.named({ holder: { leaseId: 'grant' } }, 'lease')
  const steps = queueSteps(config, t, lease)
  const deps = { ...baseDependencies(config, t, env, lease), ...queueDependencies(config, t, options, steps, lease) }
  const acquire = runInNewContext(`${source}\nacquireSuiteLock`, deps)
  let value, error
  try {
    const result = await (config.defaultOptions ? acquire() : acquire(options))
    value = t.tag(result)
  } catch (caught) { error = { name: caught.name, properties: describeOwnData(caught, t.tag, true), injected: t.isInjected(caught) } }
  await Promise.resolve()
  await Promise.resolve()
  return { value, error, trace: t.trace, ...t.end() }
}

export async function assertSuiteAcquireParity(cli) {
  const current = currentFunctions(cli)
  for (const [index, config] of cases.entries()) {
    const expected = await observe(reference, config)
    const actual = await observe(current, config)
    assert.deepEqual(actual, expected, `suite acquisition extraction must preserve outputs errors effects reads receivers and microtasks: case ${index + 1}`)
  }
  return cases.length
}
