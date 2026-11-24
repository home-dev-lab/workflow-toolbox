import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const lockUrl = process.env.SUITE_RESOURCE_LOCK_MODULE ?? new URL('../../plugin/bin/lib/suite-lock.mjs', import.meta.url).href
const resourceUrl = new URL('../../plugin/bin/lib/suite-lock-resources.mjs', import.meta.url).href
const hostUrl = process.env.SUITE_RESOURCE_HOST_MODULE ?? new URL('../../plugin/bin/lib/host/suite-lock-resources.mjs', import.meta.url).href
const journalUrl = new URL('../../plugin/bin/lib/suite-lock-journal.mjs', import.meta.url).href
const scratch = () => mkdtempSync(join(tmpdir(), 'wt-resources-'))
const resources = (peakCores = 0.5, peakMemMiB = 128) => ({ peakCores, peakMemMiB, wallMs: 2000.125, unknownReasons: [] })
const history = (count, cores, mem) => Array.from({ length: count }, () => resources(cores, mem))
const row = (pid, ppid, cpuMs, memMiB) => ({ pid, ppid, identity: `${pid}:birth`, cpuMs, memMiB })
async function hostModule() {
  const module = await import(hostUrl).catch((error) => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error })
  assert.equal(typeof module.createSuiteResourceSampler, 'function', 'suite resource sampler must be exported')
  return module
}

async function fakeSampler(readTree) {
  const { createSuiteResourceSampler } = await hostModule()
  let time = 0
  let scheduled = 0
  let cancelled = 0
  const sampler = createSuiteResourceSampler({ pid: 1, readTree, now: () => time,
    schedule: () => { scheduled++; return { unref() {} } }, cancel: () => { cancelled++ } })
  await sampler.ready
  return { sampler, time: (value) => { time = value }, counts: () => ({ scheduled, cancelled }) }
}

async function knownPeakJournal() {
  let index = 0
  const trees = [
    [row(1, 0, 100, 10), row(2, 1, 20, 20)],
    [row(1, 0, 600, 10), row(2, 1, 220, 20), row(3, 2, 300, 30)],
    [row(1, 0, 2600, 10), row(2, 1, 320, 20), row(3, 2, 1400, 30)],
  ]
  const fake = await fakeSampler(async () => ({ processes: trees[index++] }))
  const root = scratch()
  try {
    const { acquireSuiteLock, releaseSuiteLock } = await import(lockUrl)
    const lease = await acquireSuiteLock({ root, argv: ['pnpm', 'test'], resourceSampler: () => fake.sampler })
    fake.time(1000); await fake.sampler.sample()
    fake.time(2000); await fake.sampler.sample()
    fake.time(2000.125)
    const cancelled = fake.counts().cancelled
    releaseSuiteLock(lease, { exit: 7 })
    const events = readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(events.at(-1).resources, resources(3.2, 60), 'journal release must contain the full-precision descendant peak')
    assert.equal(events.at(-1).exit, 7)
    assert.equal(events.at(-1).cmd, 'test')
    assert.equal(fake.counts().cancelled, cancelled + 1, 'release must cancel the sampling timer')
  } finally { fake.sampler.stop(); rmSync(root, { recursive: true, force: true }) }
}

async function missingSource() {
  const fake = await fakeSampler(async () => { throw new Error('missing') })
  fake.time(1000); await fake.sampler.sample()
  const result = fake.sampler.stop()
  assert.equal(result.peakCores, 'unknown', 'missing CPU evidence must be unknown, never zero')
  assert.equal(result.peakMemMiB, 'unknown', 'missing RSS evidence must be unknown, never zero')
  assert.ok(result.unknownReasons.includes('source-unavailable'))
}

async function classifierEdges() {
  const { classifySuiteJob, SUITE_RESOURCE_MIN_RUNS: n, SUITE_LIGHT_MAX_CORES: cores, SUITE_LIGHT_MAX_MEM_MIB: mem } = await import(resourceUrl)
  assert.equal(n, 3)
  assert.deepEqual(classifySuiteJob([], 'light'), { class: 'light', cores: 'unknown', memMiB: 'unknown', basis: 'declared' })
  assert.equal(classifySuiteJob(history(n - 1, 10, 900), 'light').basis, 'declared')
  assert.equal(classifySuiteJob(history(n - 1, 10, 900), 'light').class, 'light')
  for (const [cpu, rss, expected] of [[cores - 1e-8, mem, 'light'], [cores, mem, 'light'], [cores + 1e-8, mem, 'heavy'], [cores, mem - 1e-8, 'light'], [cores, mem + 1e-8, 'heavy']]) {
    assert.deepEqual(classifySuiteJob(history(n, cpu, rss), 'heavy'), { class: expected, cores: cpu, memMiB: rss, basis: 'measured' })
  }
  assert.equal(classifySuiteJob([...history(n - 1, 0.1, 1), resources('unknown', 10)], 'heavy').basis, 'declared')
  assert.equal(classifySuiteJob([...history(n, 0.1, 1), resources(4, 2)], 'light').class, 'heavy')
}

async function oldRowsAndStatus() {
  const { readSuiteLockJournal } = await import(journalUrl)
  const { readSuiteLockStatus } = await import(lockUrl)
  const { suiteLockStatusJson, formatSuiteLockStatus } = await import(new URL('../../plugin/bin/lib/suite-lock-status.mjs', import.meta.url))
  const root = scratch()
  try {
    const events = Array.from({ length: 4 }, (_, i) => ['request', 'grant', 'release'].map((event) => ({
      leaseId: `run-${i}`, event, kind: 'exclusive', cmd: 'test', ts: '2026-01-01T00:00:00Z',
      ...(i && event === 'release' ? { resources: resources(0.75, 200), futureField: true, exit: 0 } : {}),
    }))).flat()
    writeFileSync(join(root, 'journal.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
    const before = readFileSync(join(root, 'journal.jsonl'), 'utf8')
    const journal = readSuiteLockJournal(root)
    assert.equal(journal.invalidLines, 0)
    assert.equal(journal.tickets.length, 4)
    assert.equal(journal.tickets[0].release.resources, undefined)
    const status = readSuiteLockStatus({ root, env: {} })
    assert.ok(status.resourceClasses, 'status must expose measured job classes')
    assert.deepEqual(status.resourceClasses.test, { class: 'light', cores: 0.75, memMiB: 200, basis: 'measured' })
    assert.deepEqual(suiteLockStatusJson(status).resourceClasses, status.resourceClasses)
    assert.match(formatSuiteLockStatus(status, ''), /resources test: light.*measured/)
    assert.equal(readFileSync(join(root, 'journal.jsonl'), 'utf8'), before, 'status is read-only')
  } finally { rmSync(root, { recursive: true, force: true }) }
}

export async function admissionScenario(url = lockUrl) {
  const { acquireSuiteLock, releaseSuiteLock } = await import(url)
  const root = scratch()
  const events = []
  try {
    // Measured classes deliberately contradict the declarations used for admission.
    const history = ['test', 'lint'].flatMap((cmd) => Array.from({ length: 3 }, (_, i) => ({
      leaseId: `${cmd}-${i}`, cmd, kind: cmd === 'test' ? 'exclusive' : 'light', event: 'release',
      ts: '2026-01-01T00:00:00Z', resources: resources(cmd === 'test' ? 0.1 : 4, 128), exit: 0,
    })))
    writeFileSync(join(root, 'journal.jsonl'), history.map((event) => JSON.stringify(event)).join('\n') + '\n')
    const initial = await acquireSuiteLock({ root, env: {}, argv: ['initial'] })
    const queue = (name, light) => acquireSuiteLock({ root, env: {}, argv: ['pnpm', light ? 'lint' : 'test'], light, project: name, size: 'L', pollMs: 5 }).then((lease) => {
      events.push(name); releaseSuiteLock(lease, { exit: 0, served: true })
    })
    const heavy = queue('heavy', false)
    const light = queue('light', true)
    releaseSuiteLock(initial, { exit: 0, served: true })
    await Promise.all([heavy, light])
    return events
  } finally { rmSync(root, { recursive: true, force: true }) }
}

async function admissionUnchanged() {
  assert.deepEqual(await admissionScenario(), ['light', 'heavy'], 'fixed admission scenario must match the original implementation')
}

function runChild(source, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('sampler kept event loop alive after job exit')) }, timeout)
    child.once('error', reject)
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${output}`)) })
  })
}

async function timerStops() {
  await runChild(`import { createSuiteResourceSampler } from ${JSON.stringify(hostUrl)};
    const sampler = createSuiteResourceSampler({readTree: async()=>({processes:[${JSON.stringify(row(1, 0, 0, 1))}]}), intervalMs:10});
    await sampler.ready; sampler.stop();`)
  const fake = await fakeSampler(async () => ({ processes: [row(1, 0, 0, 1)] }))
  const count = fake.counts().scheduled
  fake.sampler.stop(); await fake.sampler.sample()
  assert.equal(fake.counts().scheduled, count, 'stopped sampler must not schedule again')
  assert.equal(fake.counts().cancelled, 1)
}

async function stopInFlight() {
  const { createSuiteResourceSampler } = await hostModule()
  let complete
  let signal
  let schedules = 0
  const sampler = createSuiteResourceSampler({ readTree: (pid, options) => { signal = options.signal; return new Promise((resolve) => { complete = resolve }) },
    schedule: () => { schedules++; return { unref() {} } } })
  const result = sampler.stop()
  assert.equal(result.peakCores, 'unknown')
  assert.equal(signal.aborted, true)
  complete({ processes: [row(1, 0, 0, 10)] })
  await sampler.ready
  assert.equal(schedules, 0, 'late sample must not restart a stopped sampler')
}

async function platformSources() {
  const { createSuiteResourceReader, SUITE_RESOURCE_SAMPLE_MS } = await import(hostUrl)
  assert.equal(SUITE_RESOURCE_SAMPLE_MS, 1000)
  const windows = await createSuiteResourceReader({ platform: 'win32' })(1)
  assert.equal(windows.unknown, 'unsupported-platform')
  const missing = await createSuiteResourceReader({ platform: 'linux', list: async () => { throw new Error('no proc') }, run: async () => '100' })(1)
  assert.equal(missing.unknown, 'source-unavailable')
  const rows = '1 0 4096 00:01.25 Tue Nov 24 10:00:00 2026\n2 1 2048 00:00.50 Tue Nov 24 10:00:01 2026\n3 2 1024 00:00.25 Tue Nov 24 10:00:02 2026\n9 0 999999 00:99.00 Tue Nov 24 10:00:03 2026\n'
  let psArgs
  const mac = await createSuiteResourceReader({ platform: 'darwin', run: async (command, args) => { psArgs = args; return rows } })(1)
  assert.deepEqual(mac.processes.map((p) => p.pid), [1, 2, 3])
  assert.equal(mac.processes[0].cpuMs, 1250)
  assert.equal(mac.processes[0].memMiB, 4)
  assert.equal(mac.processes[0].identity, '1:Tue Nov 24 10:00:00 2026')
  assert.ok(psArgs.includes('-S'), 'macOS CPU must include reaped children')
}

async function brokerTelemetry() {
  const { observeBrokerJournalSocket, acquireBrokerJournalLease, releaseBrokerJournalLease } = await import(new URL('../../plugin/bin/lib/host/suite-lock-broker-journal.mjs', import.meta.url))
  const { finishBrokerLease } = await import(new URL('../../plugin/bin/lib/suite-lock-journal-lifecycle.mjs', import.meta.url))
  const root = scratch()
  try {
    const socket = new EventEmitter()
    let terminal
    socket.write = () => true
    socket.end = (line) => { terminal = line; for (const character of line) socket.emit('data', character) }
    const handlers = observeBrokerJournalSocket(socket, { onWait: () => {} })
    const lease = await acquireBrokerJournalLease({ root, env: {}, argv: ['sandbox', 'label', 'pnpm', 'test'], ...handlers })
    socket.write('granted id\n')
    finishBrokerLease({ socket }, { exit: 9, served: true, resources: resources(2.125, 64.5) })
    const frames = terminal.trim().split('\n').map(JSON.parse)
    assert.deepEqual(frames.find((frame) => frame.resources)?.resources, resources(2.125, 64.5), 'broker client must forward measured resources')
    releaseBrokerJournalLease(lease)
    const { readSuiteLockJournal } = await import(journalUrl)
    const release = readSuiteLockJournal(root).tickets[0].release
    assert.deepEqual(release.resources, resources(2.125, 64.5), 'broker host must journal client resources')
    assert.equal(release.exit, 9)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

async function linuxTreeSource() {
  const { createSuiteResourceReader } = await import(hostUrl)
  const stat = (pid, ppid, cpu, birth, childUser = 0, childSystem = 0) => {
    const fields = Array(22).fill('0')
    fields[0] = 'S'; fields[1] = String(ppid); fields[11] = String(cpu); fields[19] = String(birth)
    fields[13] = String(childUser); fields[14] = String(childSystem)
    return `${pid} (name with ) and\nnewline) ${fields.join(' ')}`
  }
  const files = { '/proc/1/stat': stat(1, 0, 100, 1, 40, 10), '/proc/2/stat': stat(2, 1, 50, 2), '/proc/3/stat': stat(3, 2, 25, 3), '/proc/9/stat': stat(9, 0, 999, 9) }
  const read = async (file) => file.endsWith('/status') ? 'VmRSS:\t2048 kB\n' : files[file]
  const reader = createSuiteResourceReader({ platform: 'linux', list: async () => ['1', '2', '3', '9', 'self'], read, run: async () => '100\n' })
  const result = await reader(1)
  assert.deepEqual(result.processes.map((p) => [p.pid, p.cpuMs, p.memMiB]), [[1, 1500, 2], [2, 500, 2], [3, 250, 2]], 'Linux CPU source must include reaped child user and system ticks')
  const missingRss = createSuiteResourceReader({ platform: 'linux', list: async () => ['1'], read: async (file) => file.endsWith('/status') ? '' : files[file], run: async () => '100' })
  assert.equal((await missingRss(1)).unknown, 'source-unavailable')
}

async function counterRegression() {
  let cpu = 100
  const fake = await fakeSampler(async () => ({ processes: [row(1, 0, cpu, 2)] }))
  fake.time(1000); cpu = 50; await fake.sampler.sample()
  const result = fake.sampler.stop()
  assert.equal(result.peakCores, 'unknown', 'a regressed CPU counter must be unknown, never clamped to idle')
  assert.ok(result.unknownReasons.includes('cpu-counter-regressed'))
}

async function shortJob() {
  const fake = await fakeSampler(async () => ({ processes: [row(1, 0, 100, 2)] }))
  const result = fake.sampler.stop()
  assert.equal(result.peakCores, 'unknown')
  assert.equal(result.peakMemMiB, 2)
  assert.ok(result.unknownReasons.includes('insufficient-samples'))
}

async function offloadedSampler() {
  const { acquireJournalLease } = await import(new URL('../../plugin/bin/lib/suite-lock-journal-lifecycle.mjs', import.meta.url))
  let started = 0
  const offloaded = { broker: 'broker', offloaded: { exit: 0 } }
  const lease = await acquireJournalLease(async () => offloaded, { env: {}, resourceSampler: () => { started++; return {} } }, 'broker:test', () => null, () => {})
  assert.equal(started, 0, 'an already-finished remote job must not start a local sampler')
  assert.equal(lease, offloaded)
}

async function unreadableJournalStatus() {
  const { readSuiteLockStatus } = await import(lockUrl)
  const root = scratch()
  try {
    mkdirSync(join(root, 'journal.jsonl'))
    assert.equal(readSuiteLockStatus({ root, env: {} }).held, false, 'advisory history must not prevent status from returning')
  } finally { rmSync(root, { recursive: true, force: true }) }
}

async function legacyBrokerTerminal() {
  const { finishBrokerLease } = await import(new URL('../../plugin/bin/lib/suite-lock-journal-lifecycle.mjs', import.meta.url))
  let wire
  finishBrokerLease({ socket: { end: (line) => { wire = line } } }, { exit: 7, served: true, resources: resources(3.123456789123456, 456.1234567891234) })
  // The old host buffers at most 128 characters and only interprets its first line.
  let text = ''
  let result
  for (const character of wire) {
    if (text.length > 128) continue
    text += character
    if (!text.includes('\n')) continue
    try {
      const message = JSON.parse(text.slice(0, text.indexOf('\n')))
      if (Number.isInteger(message.exit)) result = { exit: message.exit, served: message.served }
    } catch { /* incomplete frame */ }
  }
  assert.deepEqual(result, { exit: 7, served: true }, 'legacy broker must retain exit and service outcome with fragmented resource telemetry')
}

async function reapedChildCpu() {
  let index = 0
  const snapshots = [
    [row(1, 0, 0, 2), row(2, 1, 100, 2)],
    [row(1, 0, 1000, 2)], // The reaped child's entire lifetime moved to the parent.
    [row(1, 0, 1500, 2), row(3, 1, 100, 2)],
  ]
  const fake = await fakeSampler(async () => ({ processes: snapshots[index++] }))
  fake.time(1000); await fake.sampler.sample()
  fake.time(2000); await fake.sampler.sample()
  assert.equal(fake.sampler.stop().peakCores, 0.9, 'reaped child CPU must transfer without being counted twice')
}

export const resourceCases = [
  ['fake process tree peak reaches the release journal', knownPeakJournal],
  ['missing source is named unknown', missingSource],
  ['classifier threshold edges and insufficient history', classifierEdges],
  ['old rows and new fields read; status is advisory', oldRowsAndStatus],
  ['fixed admission order equals the original', admissionUnchanged],
  ['sampler stops and lets the event loop exit', timerStops],
  ['stop cancels in-flight sampling without waiting', stopInFlight],
  ['platform sources include grandchildren and name unavailable data', platformSources],
  ['broker terminal message carries client-side peaks', brokerTelemetry],
  ['Linux stat and RSS reader selects the complete descendant tree', linuxTreeSource],
  ['regressed CPU counters are unknown rather than idle', counterRegression],
  ['short jobs keep unknown CPU instead of guessing', shortJob],
  ['finished offloads start no local sampler', offloadedSampler],
  ['unreadable advisory history preserves status availability', unreadableJournalStatus],
  ['legacy broker retains exit and service outcome under fragmentation', legacyBrokerTerminal],
  ['reaped child CPU transfers without double counting', reapedChildCpu],
]

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [name, test] of resourceCases) {
    try { await test(); console.log(`PASS ${name} EXIT=0`) }
    catch (error) { console.error(`FAIL ${name} EXIT=1\n${error.stack}`); process.exitCode = 1 }
  }
}
