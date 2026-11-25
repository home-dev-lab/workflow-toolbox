import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
  await sampler.sample()
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
    assert.doesNotMatch(formatSuiteLockStatus(status, ''), /resources /, 'default text status must not add resource lines')
    assert.match(formatSuiteLockStatus(status, '', { resources: true }), /resources test: light.*measured/)
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
  const reference = process.env.SUITE_RESOURCE_REFERENCE_LOCK_MODULE ?? lockUrl
  const expected = await admissionScenario(reference)
  assert.deepEqual(await admissionScenario(), expected, 'fixed admission scenario must match the original implementation')
  assert.deepEqual(expected, ['light', 'heavy'], 'reference admission must preserve bounded light bypass')
}

function runChild(source, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stderr.on('data', (chunk) => { output += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('sampler kept event loop alive after job exit')) }, timeout)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`child exit ${code}: ${output}`))
    })
  })
}

async function timerStops() {
  await runChild(`import { createSuiteResourceSampler } from ${JSON.stringify(hostUrl)};
    const sampler = createSuiteResourceSampler({readTree: async()=>({processes:[${JSON.stringify(row(1, 0, 0, 1))}]}), intervalMs:10});
    await sampler.ready; sampler.stop();`)
  const fake = await fakeSampler(async () => ({ processes: [row(1, 0, 0, 1)] }))
  const count = fake.counts().scheduled
  const cancelled = fake.counts().cancelled
  fake.sampler.stop(); await fake.sampler.sample()
  assert.equal(fake.counts().scheduled, count, 'stopped sampler must not schedule again')
  assert.equal(fake.counts().cancelled, cancelled + 1)
}

async function stopInFlight() {
  const { createSuiteResourceSampler } = await hostModule()
  let complete
  let signal
  let schedules = 0
  const sampler = createSuiteResourceSampler({ readTree: (pid, options) => { signal = options.signal; return new Promise((resolve) => { complete = resolve }) },
    schedule: () => { schedules++; return { unref() {} } } })
  const sampling = sampler.sample()
  const result = sampler.stop()
  assert.equal(result.peakCores, 'unknown')
  assert.equal(signal.aborted, true)
  complete({ processes: [row(1, 0, 0, 10)] })
  await sampling
  assert.equal(schedules, 1, 'late sample must not restart a stopped sampler')
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

function developHostOutcome(chunks) {
  // Develop's host reads only the first line and stops buffering after 128 characters.
  let text = ''
  let result
  for (const chunk of chunks) {
    if (text.length > 128) continue
    text += String(chunk)
    if (!text.includes('\n')) continue
    try {
      const message = JSON.parse(text.slice(0, text.indexOf('\n')))
      if (Number.isInteger(message.exit)) result = { exit: message.exit, served: message.served }
    } catch { /* The old host ignores invalid or incomplete JSON. */ }
  }
  return result
}

async function legacyBrokerSignalFrames() {
  const { finishBrokerLease } = await import(new URL('../../plugin/bin/lib/suite-lock-journal-lifecycle.mjs', import.meta.url))
  let wire
  const telemetry = resources(3.123456789123456, 456.1234567891234)
  finishBrokerLease({ socket: { end: (line) => { wire = line } } }, { exit: 129, served: false, resources: telemetry })
  for (let size = 1; size <= wire.length; size++) {
    const chunks = Array.from({ length: Math.ceil(wire.length / size) }, (_, index) => wire.slice(index * size, (index + 1) * size))
    assert.deepEqual(developHostOutcome(chunks), { exit: 129, served: false }, 'develop host must retain the signal outcome at every fragmentation size')
  }
  const frames = wire.trim().split('\n').map(JSON.parse)
  assert.equal(frames.length, 2, 'terminal and telemetry stay separate for old hosts with bounded buffering')
  assert.deepEqual(frames[0], { exit: 129, served: false })
  assert.deepEqual(frames[1], { resources: telemetry }, 'advisory telemetry retains full precision')
}

async function statusResourcesFlag() {
  const root = scratch()
  const cli = fileURLToPath(new URL('../../plugin/bin/wt-suite-lock.mjs', import.meta.url))
  const env = { ...process.env, WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', WT_SUITE_LOCK_STATIC_LANE: '0' }
  const run = (...flags) => spawnSync(process.execPath, [cli, 'status', ...flags], { env, encoding: 'utf8', timeout: 5000 })
  try {
    const event = { leaseId: 'flag-fixture', event: 'release', cmd: 'test', kind: 'exclusive', ts: '2026-01-01T00:00:00Z' }
    writeFileSync(join(root, 'journal.jsonl'), JSON.stringify(event) + '\n')
    const plain = run()
    assert.equal(plain.status, 0, plain.stderr)
    assert.equal(plain.stdout, 'suite lock free\n', 'default status CLI must keep its original bytes')
    const detailed = run('--resources')
    assert.equal(detailed.status, 0, 'status --resources must be accepted')
    assert.equal(detailed.stdout, plain.stdout + 'resources test: heavy, unknown cores, unknown MiB (declared)\n')
    const json = run('--json')
    assert.equal(json.status, 0, json.stderr)
    assert.deepEqual(JSON.parse(json.stdout).resourceClasses.test, { class: 'heavy', cores: 'unknown', memMiB: 'unknown', basis: 'declared' })
  } finally { rmSync(root, { recursive: true, force: true }) }
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

function procStat(pid, ppid, cpu, birth = pid, childCpu = 0) {
  const fields = Array(22).fill('0')
  fields[0] = 'S'; fields[1] = String(ppid); fields[11] = String(cpu)
  fields[13] = String(childCpu); fields[19] = String(birth)
  return `${pid} (fixture) ${fields.join(' ')}`
}

async function samplerStopFailure() {
  const { acquireSuiteLock, releaseSuiteLock, readSuiteLock } = await import(lockUrl)
  const root = scratch()
  const resourceSampler = () => ({ stop() { throw new Error('injected stop failure') } })
  try {
    const lease = await acquireSuiteLock({ root, env: {}, argv: ['pnpm', 'test'], resourceSampler })
    assert.doesNotThrow(() => releaseSuiteLock(lease, { exit: 7 }), 'sampler stop failure must not block lease release')
    assert.equal(readSuiteLock({ root }).held, false, 'sampler failure must remove the held lease')
    const events = readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(events.at(-1).event, 'release')
    assert.equal(events.at(-1).exit, 7)
    assert.equal(events.at(-1).resources.peakCores, null)
    assert.equal(events.at(-1).resources.peakMemMiB, null)
    assert.deepEqual(events.at(-1).resources.unknownReasons, ['sampler-stop-failed'])
    const { validSuiteResources } = await import(resourceUrl)
    assert.equal(validSuiteResources(events.at(-1).resources), true, 'sampler error must preserve a valid unknown resource row')
    let wire
    let released = false
    releaseSuiteLock({ broker: 'fixture', resourceStarted: performance.now(), resourceSampler: resourceSampler(), markReleased: () => { released = true },
      socket: { end: (line) => { wire = line } } }, { exit: 9 })
    assert.equal(released, true, 'broker lease must be marked released despite a sampler error')
    const frames = wire.trim().split('\n').map(JSON.parse)
    assert.equal(frames[0].exit, 9)
    assert.deepEqual(frames[1].resources.unknownReasons, ['sampler-stop-failed'])
  } finally { rmSync(root, { recursive: true, force: true }) }
}

async function incoherentCensus() {
  const { createSuiteResourceReader } = await hostModule()
  let census = 0
  const calls = []
  const read = async (file) => {
    calls.push(file)
    if (file.endsWith('/status')) return 'VmRSS: 2048 kB\n'
    if (file === '/proc/1/stat') return procStat(1, 0, 0, 1, census ? 100 : 0)
    if (census) throw Object.assign(new Error('child reaped after parent read'), { code: 'ENOENT' })
    return procStat(2, 1, 100)
  }
  const reader = createSuiteResourceReader({ platform: 'linux', list: async () => ['1', '2'], read, run: async () => '100' })
  const fake = await fakeSampler(reader)
  census++; calls.length = 0
  fake.time(1000); await fake.sampler.sample()
  assert.ok(calls.indexOf('/proc/1/stat') < calls.indexOf('/proc/2/stat'), 'fixture must read the parent before the child disappears')
  const result = fake.sampler.stop()
  assert.equal(result.peakCores, 0, 'already observed CPU transferred during the census must not be counted twice')
  assert.deepEqual(result.unknownReasons, [], 'normal child reaping during a census must remain measurable')
}

async function reusedPidRss() {
  const { createSuiteResourceReader } = await hostModule()
  let statusRead = false
  const read = async (file) => {
    if (file.endsWith('/status')) { statusRead = true; return 'VmRSS: 999999 kB\n' }
    return procStat(1, 0, 100, statusRead ? 2 : 1)
  }
  const reader = createSuiteResourceReader({ platform: 'linux', list: async () => ['1'], read, run: async () => '100' })
  const result = await reader(1)
  assert.equal(result.unknown, 'pid-reused', 'RSS read across PID reuse must be dropped with named unknown pid-reused')
  assert.equal(result.processes, undefined, 'reused PID memory must never contribute to the sample')
}

function countingCommands(platform) {
  const commands = []
  const execFile = (command, args, options, callback) => {
    commands.push(command)
    callback(null, platform === 'linux' ? '100\n' : '1 0 1024 00:00.00 Tue Nov 24 10:00:00 2026\n')
  }
  const run = (command, args, options) => new Promise((resolve, reject) => {
    execFile(command, args, options, (error, output) => error ? reject(error) : resolve(output))
  })
  return { commands, run }
}

async function acquisitionDoesNotSpawn() {
  const { createSuiteResourceReader, createSuiteResourceSampler } = await hostModule()
  const { acquireSuiteLock, releaseSuiteLock } = await import(lockUrl)
  for (const platform of ['linux', 'darwin']) {
    const root = scratch()
    const { commands, run } = countingCommands(platform)
    let tick
    const readerOptions = { platform, run, list: async () => ['1'],
      read: async (file) => file.endsWith('/status') ? 'VmRSS: 1024 kB\n' : procStat(1, 0, 0) }
    const resourceSampler = () => createSuiteResourceSampler({ pid: 1, readTree: createSuiteResourceReader(readerOptions),
      schedule: (callback) => { tick = callback; return { unref() {} } }, cancel: () => {} })
    let lease
    try {
      lease = await acquireSuiteLock({ root, env: {}, argv: ['pnpm', 'test'], resourceSampler })
      const events = readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(events.at(-1).event, 'grant')
      assert.equal(commands.length, 0, 'acquisition must spawn zero resource commands before the grant is recorded')
      await tick()
      assert.equal(commands.length, 1, 'the first timer tick must resolve its platform source lazily')
      await createSuiteResourceReader(readerOptions)(1)
      assert.equal(commands.length, platform === 'linux' ? 1 : 2, 'clock ticks must be cached across readers in one process')
    } finally { if (lease) releaseSuiteLock(lease); rmSync(root, { recursive: true, force: true }) }
  }
}

async function heldLeaseTimerExits() {
  const root = scratch()
  try {
    await runChild(`import assert from 'node:assert/strict';
      import { acquireSuiteLock } from ${JSON.stringify(lockUrl)};
      import { createSuiteResourceSampler } from ${JSON.stringify(hostUrl)};
      let initial;
      await acquireSuiteLock({root:${JSON.stringify(root)},env:{},argv:['held-fixture'],
        resourceSampler:()=>createSuiteResourceSampler({schedule:callback=>(initial=setTimeout(callback,10000)),
          readTree:async()=>({processes:[${JSON.stringify(row(1, 0, 0, 1))}]})})});
      assert.equal(initial.hasRef(),false,'initial census timer must be unrefed while a lease is held');`)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

async function retainedIdentityLoss() {
  const { createSuiteResourceReader } = await hostModule()
  for (const mode of ['reused', 'absent', 'regressed', 'empty-transfer']) {
    let census = 0
    const read = async (file) => {
      if (file.endsWith('/status')) return 'VmRSS: 2048 kB\n'
      // The parent has consumed 1000 ms BEFORE reaping the former 1000 ms child.
      if (file === '/proc/1/stat') return procStat(1, 0, census ? 100 : 0)
      if (!census) return procStat(2, 1, mode === 'empty-transfer' ? 0 : 100)
      return mode === 'regressed' ? procStat(2, 1, 50) : procStat(2, 9, 0, 99)
    }
    const reader = createSuiteResourceReader({ platform: 'linux', read, run: async () => '100',
      list: async () => census && ['absent', 'empty-transfer'].includes(mode) ? ['1'] : ['1', '2'] })
    const fake = await fakeSampler(reader)
    census++; fake.time(1000); await fake.sampler.sample()
    const result = fake.sampler.stop()
    if (['reused', 'regressed'].includes(mode)) {
      assert.equal(result.peakCores, 'unknown', `${mode}: invalid identity or counter must remain unknown`)
      assert.ok(result.unknownReasons.includes(mode === 'reused' ? 'pid-reused' : 'census-incoherent'))
    } else {
      assert.equal(result.peakCores, 1, `${mode}: disappearance must preserve observed CPU and the parent's own increment`)
      assert.deepEqual(result.unknownReasons, [], `${mode}: no child-counter transfer is required for an exited process`)
    }
  }
}

async function malformedResourceSchema() {
  const { finishSuiteResourceSample } = await import(new URL('../../plugin/bin/lib/suite-lock-journal-lifecycle.mjs', import.meta.url))
  const normalize = (value) => finishSuiteResourceSample({ resourceStarted: performance.now(), resourceSampler: { stop: () => value } }, {}).resources
  for (const value of [null, { ...resources(), unknownReasons: 'abc' }, { ...resources(), peakCores: Infinity },
    { ...resources(), peakMemMiB: -1 }, { ...resources(), unknownReasons: [42] }, { get peakCores() { throw new Error('getter failure') } }]) {
    assertNormalizedResources(normalize(value), false)
  }
  const hooked = Object.assign(Object.create({ toJSON() { throw new Error('prototype hook must not run') } }), resources())
  assert.deepEqual(normalize(hooked), resources(), 'normalization must strip a sampler prototype and its serialization hooks')
  const missing = normalize(resources('unknown', 'unknown'))
  assert.equal(missing.peakCores, null, 'unknown sampler CPU must normalize to null')
  assert.equal(missing.peakMemMiB, null, 'unknown sampler memory must normalize to null')
  const { classifySuiteJob } = await import(resourceUrl)
  assert.equal(classifySuiteJob([missing, missing, missing], 'heavy').basis, 'declared', 'null peaks must never become measured zeroes')
}

async function observedReap() {
  const { createSuiteResourceReader } = await hostModule()
  let census = 0
  const reader = createSuiteResourceReader({ platform: 'linux', run: async () => '100',
    list: async () => census ? ['1'] : ['1', '2'],
    read: async (file) => file.endsWith('/status') ? 'VmRSS: 2048 kB\n'
      : file === '/proc/1/stat' ? procStat(1, 0, census ? 50 : 0, 1, census ? 100 : 0) : procStat(2, 1, 100) })
  const fake = await fakeSampler(reader)
  census++; fake.time(1000); await fake.sampler.sample()
  assert.equal(fake.sampler.stop().peakCores, 0.5, 'observed child-counter transfer must keep a coherent interval measurable')
}

async function vanishedSubtreeCpu() {
  const { createSuiteResourceReader } = await hostModule()
  for (const reaped of [false, true]) {
    let census = 0
    const reader = createSuiteResourceReader({ platform: 'linux', run: async () => '100',
      list: async () => census ? ['1'] : ['1', '2', '3'],
      read: async (file) => file.endsWith('/status') ? 'VmRSS: 2048 kB\n'
        : file === '/proc/1/stat' ? procStat(1, 0, 100 + census * 10, 1, reaped && census ? 70 : 0)
          : file === '/proc/2/stat' ? procStat(2, 1, 50) : procStat(3, 2, 20) })
    const fake = await fakeSampler(reader)
    census++; fake.time(1000); await fake.sampler.sample()
    census++; fake.time(2000); await fake.sampler.sample()
    const result = fake.sampler.stop()
    assert.deepEqual(result.unknownReasons, [], 'a vanished multilevel subtree must retain all already observed CPU')
    assert.equal(result.peakCores, 0.1, 'reaped or unreconciled subtree CPU must not be lost or counted twice')
  }
}

async function deferredReapCpu() {
  const { createSuiteResourceReader } = await hostModule()
  let census = 0
  const reader = createSuiteResourceReader({ platform: 'linux', run: async () => '100',
    list: async () => census ? ['1'] : ['1', '2'],
    read: async (file) => file.endsWith('/status') ? 'VmRSS: 2048 kB\n'
      : file === '/proc/1/stat' ? procStat(1, 0, census * 10, 1, census > 1 ? 100 : 0) : procStat(2, 1, 100) })
  const fake = await fakeSampler(reader)
  for (census = 1; census <= 3; census++) { fake.time(census * 1000); await fake.sampler.sample() }
  const result = fake.sampler.stop()
  assert.deepEqual(result.unknownReasons, [], 'a deferred reap must reconcile previously retained CPU')
  assert.equal(result.peakCores, 0.1, 'CPU carried across a census race must not be counted again on the later reap')
}

async function reapingDuringCensus() {
  const { createSuiteResourceReader } = await hostModule()
  let reads = 0
  const reader = createSuiteResourceReader({ platform: 'linux', run: async () => '100', list: async () => ['1'],
    read: async (file) => file.endsWith('/status') ? 'VmRSS: 2048 kB\n' : procStat(1, 0, 100, 1, reads++ * 10) })
  const result = await reader(1)
  assert.equal(result.unknown, undefined, 'a growing child counter during a census is normal reaping, not incoherence')
}

async function linuxHighWaterMemory() {
  const { createSuiteResourceReader } = await hostModule()
  for (const status of ['VmRSS: 2048 kB\nVmHWM: 8192 kB\n', 'VmRSS: 8192 kB\nVmHWM: 2048 kB\n']) {
    const reader = createSuiteResourceReader({ platform: 'linux', run: async () => '100', list: async () => ['1'],
      read: async (file) => file.endsWith('/status') ? status : procStat(1, 0, 100) })
    assert.equal((await reader(1)).processes[0].memMiB, 8, 'Linux memory must cover both current RSS and the resident high-water mark')
  }
}

async function malformedHighWaterMemory() {
  const { createSuiteResourceReader } = await hostModule()
  for (const status of ['VmRSS: 2048 kB\nVmHWM: invalid kB\n', 'VmRSS: 2048 kB\nVmHWM: -1 kB\n']) {
    const reader = createSuiteResourceReader({ platform: 'linux', run: async () => '100', list: async () => ['1'],
      read: async (file) => file.endsWith('/status') ? status : procStat(1, 0, 100) })
    assert.equal((await reader(1)).unknown, 'source-unavailable', 'a present malformed high-water source must remain named unknown')
  }
}

async function exitDuringStatusRead() {
  const { createSuiteResourceReader } = await hostModule()
  let census = 0
  const reader = createSuiteResourceReader({ platform: 'linux', run: async () => '100', list: async () => ['1', '2'],
    read: async (file) => {
      if (census && file === '/proc/2/status') throw Object.assign(new Error('exited'), { code: 'ENOENT' })
      if (file.endsWith('/status')) return 'VmRSS: 2048 kB\n'
      return file === '/proc/1/stat' ? procStat(1, 0, census * 10) : procStat(2, 1, 100)
    } })
  const fake = await fakeSampler(reader)
  census++; fake.time(1000); await fake.sampler.sample()
  const result = fake.sampler.stop()
  assert.deepEqual(result.unknownReasons, [], 'a confirmed exit during status reading must retain already observed CPU')
  assert.equal(result.peakCores, 0.1)
}

async function zombieAndUnavailableStatus() {
  const { createSuiteResourceReader } = await hostModule()
  for (const status of ['State:\tZ (zombie)\n', '', new Error('denied')]) {
    const reader = createSuiteResourceReader({ platform: 'linux', run: async () => '100', list: async () => ['1'],
      read: async (file) => {
        if (!file.endsWith('/status')) return procStat(1, 0, 100).replace(') S ', ') Z ')
        if (status instanceof Error) throw Object.assign(status, { code: 'EACCES' })
        return status
      } })
    const result = await reader(1)
    if (status === 'State:\tZ (zombie)\n') assert.equal(result.processes[0].memMiB, 0, 'an explicitly observed zombie has no resident memory')
    else assert.equal(result.unknown, 'source-unavailable', 'missing or denied status must not masquerade as a zero-memory zombie')
  }
}

async function ignoredChildCpuStaysCarried() {
  if (!Number.isInteger(constants.signals.SIGCHLD)) { console.log('SKIP ignored-child fixture requires a SIGCHLD constant'); return }
  const { createSuiteResourceReader } = await hostModule()
  let census = 0
  const ignored = (1n << BigInt(constants.signals.SIGCHLD - 1)).toString(16)
  const reader = createSuiteResourceReader({ platform: 'linux', run: async () => '100',
    list: async () => census ? ['1'] : ['1', '2'],
    read: async (file) => file.endsWith('/status') ? `VmRSS: 2048 kB\nSigIgn: ${census < 2 ? ignored : '0'}\n`
      : file === '/proc/1/stat' ? procStat(1, 0, census * 10, 1, census > 1 ? 100 : 0) : procStat(2, 1, 100) })
  const fake = await fakeSampler(reader)
  census++; fake.time(1000); await fake.sampler.sample()
  census++; fake.time(2000); await fake.sampler.sample()
  const result = fake.sampler.stop()
  assert.deepEqual(result.unknownReasons, [])
  assert.equal(result.peakCores, 1.1, 'CPU of an auto-reaped child must stay carried when unrelated child CPU is later reaped')
}

async function parentBeforeChildCounters() {
  const { createSuiteResourceReader } = await hostModule()
  let childReads = 0
  let reaped = false
  const snapshots = []
  const reader = createSuiteResourceReader({ platform: 'linux', run: async () => '100', list: async () => ['2', '1'],
    read: async (file) => {
      if (file.endsWith('/status')) return 'VmRSS: 2048 kB\n'
      if (file === '/proc/1/stat') return procStat(1, 0, 0, 1, reaped ? 100 : 0)
      if (reaped) throw Object.assign(new Error('reaped'), { code: 'ENOENT' })
      if (++childReads === 2) reaped = true
      return procStat(2, 1, 100)
    } })
  const fake = await fakeSampler(async (...args) => { const snapshot = await reader(...args); snapshots.push(snapshot); return snapshot })
  assert.equal(snapshots[0].totalCpuMs, 1000, 'the first census must not include both a child and its reaped CPU transfer')
  fake.time(1000); await fake.sampler.sample()
  const result = fake.sampler.stop()
  assert.deepEqual(result.unknownReasons, [], 'parent-before-child final reads must avoid counting both sides of a reap transfer')
  assert.equal(result.peakCores, 0, 'a reap of already sampled CPU must not add another interval of work')
}

async function darwinRetainedIdentityLoss() {
  const { createSuiteResourceReader } = await hostModule()
  for (const mode of ['reused', 'absent', 'regressed']) {
    let census = 0
    const run = async () => {
      const parent = `1 0 1024 00:0${census}.00 Tue Nov 24 10:00:00 2026\n`
      if (census && mode === 'absent') return parent
      const child = census && mode === 'reused' ? '2 9 1024 00:00.00 Tue Nov 24 10:00:02 2026\n'
        : `2 1 1024 00:0${census && mode === 'regressed' ? 0 : 1}.00 Tue Nov 24 10:00:01 2026\n`
      return parent + child
    }
    const fake = await fakeSampler(createSuiteResourceReader({ platform: 'darwin', run }))
    census++; fake.time(1000); await fake.sampler.sample()
    const result = fake.sampler.stop()
    assert.equal(result.peakCores, 'unknown', `${mode}: macOS retained identity loss must not yield plausible CPU`)
    assert.ok(result.unknownReasons.includes('census-incoherent'), `${mode}: macOS retained identity loss must name census-incoherent`)
  }
}

async function clockLookupRecovers() {
  const { createSuiteResourceReader } = await hostModule()
  for (const failure of [new Error('transient clock failure'), 'garbage', '0', '-1', '1.5']) {
    let calls = 0
    const run = async () => { calls++; if (calls > 1) return '100'; if (failure instanceof Error) throw failure; return failure }
    const options = { platform: 'linux', run, list: async () => ['1'],
      read: async (file) => file.endsWith('/status') ? 'VmRSS: 1024 kB\n' : procStat(1, 0, 100) }
    assert.equal((await createSuiteResourceReader(options)(1)).unknown, 'clock-ticks-unavailable')
    const recovered = await createSuiteResourceReader(options)(1)
    assert.equal(calls, 2, 'a failed clock lookup must be retried by the next reader')
    assert.equal(recovered.processes[0].cpuMs, 1000, 'the recovered clock source must produce a measurement')
  }
}

async function firstCensusIsImmediate() {
  const { createSuiteResourceSampler } = await hostModule()
  const scheduled = []
  let reads = 0
  const sampler = createSuiteResourceSampler({ readTree: async () => { reads++; return { processes: [row(1, 0, 0, 1)] } },
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return { unref() {} } }, cancel: () => {} })
  try {
    assert.equal(reads, 0, 'the initial census must never run synchronously inside acquisition')
    assert.equal(scheduled[0].delay, 0, 'a short job must get its first census before the first one-second tick')
    await scheduled[0].callback()
    assert.equal(reads, 1)
    assert.equal(scheduled[1].delay, 1000, 'the later census cadence must remain one second')
  } finally { sampler.stop() }
  await runChild(`import assert from 'node:assert/strict';
    import {createSuiteResourceSampler} from ${JSON.stringify(hostUrl)};
    let sampler;
    await new Promise(resolve=>{
      const deadline=setTimeout(()=>assert.fail('short job must be observed before the first one-second tick'),900);
      sampler=createSuiteResourceSampler({readTree:async()=>{
        clearTimeout(deadline);resolve();return {processes:[${JSON.stringify(row(1, 0, 0, 1))}]};
      }});
    });sampler.stop();`)
}

async function malformedSamplerRelease() {
  const { acquireSuiteLock, releaseSuiteLock, readSuiteLock } = await import(lockUrl)
  for (const valid of [true, false]) {
    const circular = valid ? resources() : {}
    circular.self = circular
    const resourceSampler = () => ({ stop: () => circular })
    const root = scratch()
    try {
      const lease = await acquireSuiteLock({ root, env: {}, resourceSampler })
      assert.doesNotThrow(() => releaseSuiteLock(lease), 'circular sampler output must not block file lease release')
      assert.equal(readSuiteLock({ root }).held, false, 'malformed sampler output must remove the held lease')
      const events = readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(events.at(-1).event, 'release', 'circular sampler output must not erase the terminal journal row')
      assertNormalizedResources(events.at(-1).resources, valid)
      let wire
      let released = false
      assert.doesNotThrow(() => releaseSuiteLock({ broker: 'fixture', resourceStarted: performance.now(), resourceSampler: resourceSampler(),
        markReleased: () => { released = true }, socket: { end: (line) => { wire = line } } }), 'circular sampler output must not block broker release')
      assert.equal(released, true, 'circular sampler output must release the broker lease')
      assert.equal(typeof wire, 'string', 'circular sampler output must end the broker socket')
      assertNormalizedResources(JSON.parse(wire.trim().split('\n')[1]).resources, valid)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
}

function assertNormalizedResources(value, valid) {
  assert.equal(Object.getPrototypeOf(value), Object.prototype)
  assert.deepEqual(Object.keys(value).sort(), ['peakCores', 'peakMemMiB', 'unknownReasons', 'wallMs'])
  assert.ok([value.peakCores, value.peakMemMiB, value.wallMs].every((number) => number === null || Number.isFinite(number)), 'normalized telemetry must contain finite numbers or null')
  assert.ok(value.unknownReasons.every((reason) => typeof reason === 'string'))
  if (valid) assert.deepEqual(value, resources())
  else assert.deepEqual(value.unknownReasons, ['resources-unserializable'])
}

async function telemetrySerializationFailure() {
  const { finishBrokerLease } = await import(new URL('../../plugin/bin/lib/suite-lock-journal-lifecycle.mjs', import.meta.url))
  const { observeBrokerJournalSocket, acquireBrokerJournalLease, releaseBrokerJournalLease } = await import(new URL('../../plugin/bin/lib/host/suite-lock-broker-journal.mjs', import.meta.url))
  const root = scratch()
  try {
    const socket = new EventEmitter()
    let ended = false
    socket.write = () => true
    socket.end = (wire) => { ended = true; socket.emit('data', wire) }
    const handlers = observeBrokerJournalSocket(socket, { onWait: () => {} })
    const lease = await acquireBrokerJournalLease({ root, env: {}, argv: ['sandbox', 'label', 'test'], ...handlers })
    socket.write('granted fixture\n')
    const circular = {}; circular.self = circular
    assert.doesNotThrow(() => finishBrokerLease({ socket }, { exit: 7, served: true, resources: circular }), 'telemetry serialization failure must still end the socket')
    assert.equal(ended, true, 'telemetry serialization failure must not suppress socket.end')
    assert.equal(releaseBrokerJournalLease(lease), true, 'telemetry serialization failure must release the host lease')
    const events = readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(events.at(-1).exit, 7)
    assert.deepEqual(events.at(-1).resources.unknownReasons, ['resources-unserializable'], 'the host release row must name telemetry serialization failure')
  } finally { rmSync(root, { recursive: true, force: true }) }
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
  ['develop broker parser retains the signal outcome at every fragmentation size', legacyBrokerSignalFrames],
  ['status CLI resource text requires an explicit flag', statusResourcesFlag],
  ['reaped child CPU transfers without double counting', reapedChildCpu],
  ['sampler stop errors cannot block file or broker release', samplerStopFailure],
  ['non-atomic child reap preserves already observed CPU', incoherentCensus],
  ['PID reuse between stat and RSS drops the sample', reusedPidRss],
  ['acquisition defers platform commands and caches clock ticks', acquisitionDoesNotSpawn],
  ['held lease sampler timer never keeps the child alive', heldLeaseTimerExits],
  ['retained disappearance stays measurable; PID reuse and regression stay unknown', retainedIdentityLoss],
  ['observed reap into parent counters stays measurable', observedReap],
  ['failed clock lookups recover across readers', clockLookupRecovers],
  ['first census runs asynchronously before the one-second tick', firstCensusIsImmediate],
  ['circular sampler output cannot block terminal release', malformedSamplerRelease],
  ['telemetry serialization failure preserves terminal release and its reason', telemetrySerializationFailure],
  ['malformed sampler schemas become named unknown and hooks are stripped', malformedResourceSchema],
  ['macOS retained identity loss is named incoherent', darwinRetainedIdentityLoss],
  ['vanished multilevel subtree retains observed CPU', vanishedSubtreeCpu],
  ['deferred reap reconciles retained CPU without double counting', deferredReapCpu],
  ['child CPU growth during a census remains measurable', reapingDuringCensus],
  ['Linux memory includes process high-water marks and current RSS', linuxHighWaterMemory],
  ['malformed high-water memory is named unavailable', malformedHighWaterMemory],
  ['exit during the status read preserves observed CPU', exitDuringStatusRead],
  ['explicit zombies have no RSS; unavailable status remains unknown', zombieAndUnavailableStatus],
  ['SIGCHLD-ignored CPU remains carried across unrelated later reaps', ignoredChildCpuStaysCarried],
  ['parent-before-child reads prevent mixed-time CPU double counting', parentBeforeChildCounters],
]

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [name, test] of resourceCases) {
    try { await test(); console.log(`PASS ${name} EXIT=0`) }
    catch (error) { console.error(`FAIL ${name} EXIT=1\n${error.stack}`); process.exitCode = 1 }
  }
}
