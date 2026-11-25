import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

const scratch = mkdtempSync(path.join(os.tmpdir(), 'suite-admission-'))
const source = process.env.WT_ADMISSION_SOURCE ?? path.resolve(import.meta.dirname, '../../plugin/bin/lib')
cpSync(source, path.join(scratch, 'lib'), { recursive: true })
after(() => rmSync(scratch, { recursive: true, force: true }))
const api = await import(pathToFileURL(path.join(scratch, 'lib/suite-lock-admission.mjs'))).catch(() => ({}))
const host = await import(pathToFileURL(path.join(scratch, 'lib/host/suite-lock-machine.mjs'))).catch(() => ({}))
const catalogue = await import(pathToFileURL(path.join(scratch, 'lib/suite-lock-resources.mjs')))
const capacity = { cores: 4, memMiB: 4096, load: 0, loadLimit: 4 }
const measured = (cores = 1, memMiB = 500) => ({ release: { exit: 0, overlaps: [], resources: {
  peakCores: cores, peakMemMiB: memMiB, wallMs: 1000, unknownReasons: [],
} } })
const ticket = (number, cores = 1, extra = {}) => ({ number, record: { leaseId: `l${number}` },
  reservation: { mode: 'reservation', cores, memMiB: 500 }, ...extra })

test('two reservations fit concurrently and a third waits', () => {
  const queue = [ticket(1, 2), ticket(2, 2), ticket(3, 1)]
  assert.deepEqual(api.admissionPlan?.(queue, [], capacity, {}).admit, [1, 2], 'admit exactly the fitting prefix')
})

test('admission has no count ceiling for a large fitting family', () => {
  const count = 1024 // Larger than every admission-policy count constant, including the history window.
  const queue = Array.from({ length: count }, (_, i) => ticket(i + 1, 1 / count))
  const budget = { ...capacity, memMiB: count * 500 }
  assert.deepEqual(api.admissionPlan(queue, [], budget, {}).admit, queue.map(({ number }) => number),
    'every fitting reservation must be admitted, regardless of job count')
})

test('unknown heavy stays whole-machine exclusive; incomplete history falls back', () => {
  const unknown = api.reservationForJob?.([], 'heavy', capacity)
  assert.equal(unknown?.mode, 'exclusive', 'unmeasured heavy must be exclusive')
  assert.equal(unknown?.cores, 4)
  const runs = [measured(), measured(), measured(1.00000001, 512.00000001)]
  const value = api.reservationForJob(runs, 'heavy', capacity)
  assert.equal(value.cores, 1.00000001 * 1.25, 'reserve full precision with 25% margin')
  assert.equal(value.memMiB, 512.00000001 * 1.25)
  assert.equal(api.reservationForJob([...runs.slice(0, 2), { release: { resources: null } }], 'heavy', capacity).mode, 'exclusive')
  assert.equal(api.reservationForJob([], 'light', capacity).cores, 4)
})

test('new successful incomplete observations revoke mature reservations within the release window', () => {
  const partial = { release: { exit: 0, resources: null } }
  const runs = [measured(1, 100), measured(2, 300), measured(0.5, 200), partial]
  const value = api.reservationForJob(runs, 'heavy', capacity)
  assert.equal(value.mode, 'exclusive', 'a newer successful incomplete observation revokes measured status')
  assert.equal(value.basis, 'declared')
  const window = [measured(100, 10000), ...Array.from({ length: 10 }, () => [partial, measured(1, 100)]).flat(), partial]
  assert.equal(api.reservationForJob(window, 'heavy', capacity).basis, 'declared', 'the window counts resource release rows, including incomplete successes')
})

test('malformed resource reasons are not complete observations', () => {
  const malformed = measured(999, 99999)
  malformed.release.resources.unknownReasons = { length: 0 }
  const value = api.reservationForJob([measured(), measured(), measured(), malformed], 'heavy', capacity)
  assert.equal(value.basis, 'declared', 'a malformed successful sample revokes measured status')
})

test('timing evidence forces exclusion in both directions without name heuristics', () => {
  const runs = [measured(), measured(), measured()]
  runs[1].release.exit = 1
  runs[1].release.overlaps = [{ leaseId: 'peer', durationMs: 1 }]
  const sensitive = api.reservationForJob?.(runs, 'heavy', capacity)
  assert.equal(sensitive?.mode, 'exclusive', 'red concurrent plus green alone is exclusive')
  assert.deepEqual(api.admissionPlan([ticket(1, 1, { reservation: sensitive }), ticket(2)], [], capacity, {}).admit, [1])
  assert.deepEqual(api.admissionPlan([ticket(2)], [{ reservation: sensitive }], capacity, {}).admit, [])
  runs[0].release.overlaps = undefined
  runs[2].release.overlaps = undefined
  assert.equal(api.reservationForJob(runs, 'heavy', capacity).basis, 'declared', 'missing overlap history is not proof of an isolated pass; two successes cannot train')
})

test('CPU overload admits nothing and requests no stop', () => {
  assert.deepEqual(api.admissionPlan?.([ticket(1)], [], { ...capacity, load: 4.00001 }, {}).admit, [], 'overload closes admission')
  assert.equal(api.watchdogDecision?.([{ id: 1 }], { ...capacity, load: 4.00001, availableMiB: 1024, floorMiB: 512 }), null, 'CPU is never a stop trigger')
})

test('memory stop chooses lowest priority then youngest once and protects release', () => {
  const holders = [{ leaseId: 'release', priority: 'release', startedAtMs: 9 },
    { leaseId: 'older', level: 2, startedAtMs: 1 }, { leaseId: 'youngest', level: 2, startedAtMs: 2 },
    { leaseId: 'urgent', level: 0, startedAtMs: 10 }]
  const memory = { availableMiB: 511, floorMiB: 512 }
  assert.equal(api.watchdogDecision?.(holders, memory)?.leaseId, 'youngest', 'youngest lowest-priority holder must stop')
  holders[2].stop = { cause: 'memory-pressure' }
  assert.equal(api.watchdogDecision(holders, memory), null, 'one outstanding stop prevents double stop')
  assert.equal(api.watchdogDecision([holders[0]], memory).leaseId, 'release')
  assert.equal(api.watchdogDecision([holders[0], holders[3]], memory).leaseId, 'urgent')
})

test('memory pressure still selects a victim when every holder has release priority', () => {
  const holders = [{ leaseId: 'older-release', priority: 'release', admittedSequence: 1 },
    { leaseId: 'younger-release', priority: 'release', admittedSequence: 2 }]
  assert.equal(api.watchdogDecision(holders, { availableMiB: 0, floorMiB: 512 })?.leaseId,
    'younger-release', 'all-release holders must not disable the memory safety net')
})

test('watchdog respects the admitted precedence tier and effective size priority', () => {
  const holders = [{ leaseId: 'precedence', level: 2, watchdogPriority: [1, 2], startedAtMs: 3 },
    { leaseId: 'ordinary', level: 0, watchdogPriority: [2, 0], startedAtMs: 1 }]
  assert.equal(api.watchdogDecision?.(holders, { availableMiB: 0, floorMiB: 512 })?.leaseId,
    'ordinary', 'lowest admitted priority includes project precedence')
})

test('youngest means admission order even when a client wall clock regresses', () => {
  const holders = [{ leaseId: 'older', level: 2, startedAtMs: 1000, admittedSequence: 1 },
    { leaseId: 'newer', level: 2, startedAtMs: 500, admittedSequence: 2 }]
  assert.equal(api.watchdogDecision(holders, { availableMiB: 0, floorMiB: 512 }).leaseId,
    'newer', 'memory victim age must follow serialized admission, not a wall-clock ordering')
})

test('fit bypass is bounded then capacity drains for blocked head', () => {
  const queue = [ticket(1, 4), ticket(2), ticket(3)]
  const held = [{ reservation: { mode: 'reservation', cores: 3, memMiB: 500 } }]
  const first = api.admissionPlan?.(queue, held, capacity, {})
  assert.deepEqual(first?.admit, [2], 'a fitting lower-ranked job may pass a non-fitting head')
  const bound = api.ADMISSION_BYPASS_LIMIT
  assert.equal(bound, 8)
  assert.deepEqual(api.admissionPlan(queue, held, capacity, { 1: bound }).admit, [], 'bounded passes drain capacity')
})

test('legacy tickets drain capacity and cannot share reservation holders', () => {
  const queue = [{ number: 1, record: { leaseId: 'legacy' }, reservation: { mode: 'exclusive', cores: 4, memMiB: 4096 } }, ticket(2)]
  assert.deepEqual(api.admissionPlan?.(queue, [], capacity, {}).admit, [1], 'legacy head is exclusive')
  assert.deepEqual(api.admissionPlan(queue, [{ reservation: ticket(3).reservation }], capacity, {}).admit, [2])
})

test('overlap durations close at release, preserving already ended peers', () => {
  const holder = { overlaps: [{ leaseId: 'a', startMs: 100, endMs: 150 }, { leaseId: 'b', startMs: 120 }] }
  assert.deepEqual(api.releaseOverlaps?.(holder, 200), [{ leaseId: 'a', durationMs: 50 }, { leaseId: 'b', durationMs: 80 }], 'release records exact overlap durations')
})

test('platform measurements fail explicitly rather than using plausible Windows zero load', () => {
  assert.equal(host.reservationHostSupported('linux'), true)
  assert.equal(host.reservationHostSupported('darwin'), true)
  assert.equal(host.reservationHostSupported('win32'), false)
  const input = { read: () => 'MemAvailable: 4194304 kB\n', free: () => 4 * 1024 ** 3,
    total: () => 8 * 1024 ** 3, cpus: () => 8, load: () => [2.0000001] }
  assert.equal(host.readSuiteMachine?.({ ...input, platform: 'win32' })?.unknown, 'unsupported-platform-memory-and-load')
  for (const platform of ['linux', 'darwin']) {
    const result = host.readSuiteMachine({ ...input, platform })
    assert.equal(result.cores, 12)
    assert.equal(result.availableMiB, 4096)
    assert.equal(result.memMiB, 3072)
    assert.equal(result.load, 2.0000001)
    assert.equal(host.readSuiteMachine({ ...input, platform, load: () => { throw new Error('denied') } }).unknown, 'machine-source-unavailable')
  }
  assert.equal(host.readSuiteMachine({ ...input, platform: 'linux', read: () => '' }).unknown, 'machine-source-unavailable')
})

test('Darwin available memory includes reclaimable pages at native page size without rounding', () => {
  const originalFree = os.freemem
  const originalRun = childProcess.execFileSync
  let output = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 1.\nPages inactive: 2.\nPages speculative: 3.\n'
  try {
    os.freemem = () => 4096
    childProcess.execFileSync = () => output
    syncBuiltinESMExports()
    const options = { platform: 'darwin', total: () => 8 * 1024 ** 3, cpus: () => 8, load: () => [0] }
    assert.equal(host.readSuiteMachine(options).availableMiB, 24576 / 1024 ** 2,
      'Darwin admission must include free, inactive and speculative pages')
    output = output.replace('4096 bytes', '16384 bytes')
    assert.equal(host.readSuiteMachine(options).availableMiB, 98304 / 1024 ** 2)
    output = output.replace('Pages speculative: 3.\n', '')
    assert.equal(host.readSuiteMachine(options).unknown, 'machine-source-unavailable', 'partial vm_stat is unknown, not free-only memory')
    childProcess.execFileSync = () => { throw new Error('denied') }
    syncBuiltinESMExports()
    assert.equal(host.readSuiteMachine(options).unknown, 'machine-source-unavailable')
  } finally {
    os.freemem = originalFree
    childProcess.execFileSync = originalRun
    syncBuiltinESMExports()
  }
})

test('interactive terminals retain compatibility instead of losing controlling-terminal ownership', () => {
  const input = process.stdin
  const output = process.stdout
  const error = process.stderr
  const beforeInput = Object.getOwnPropertyDescriptor(input, 'isTTY')
  const beforeOutput = Object.getOwnPropertyDescriptor(output, 'isTTY')
  const beforeError = Object.getOwnPropertyDescriptor(error, 'isTTY')
  try {
    Object.defineProperty(input, 'isTTY', { value: true, configurable: true })
    Object.defineProperty(output, 'isTTY', { value: false, configurable: true })
    Object.defineProperty(error, 'isTTY', { value: false, configurable: true })
    assert.equal(host.reservationHostSupported('linux', true), false, 'TTY jobs must retain the legacy terminal-compatible route')
    Object.defineProperty(input, 'isTTY', { value: false, configurable: true })
    Object.defineProperty(output, 'isTTY', { value: true, configurable: true })
    assert.equal(host.reservationHostSupported('darwin', true), false)
    Object.defineProperty(output, 'isTTY', { value: false, configurable: true })
    Object.defineProperty(error, 'isTTY', { value: true, configurable: true })
    assert.equal(host.reservationHostSupported('linux', true), false)
    Object.defineProperty(error, 'isTTY', { value: false, configurable: true })
    assert.equal(host.reservationHostSupported('linux', true), true)
    assert.equal(host.reservationHostSupported('win32', true), false)
  } finally {
    if (beforeInput) Object.defineProperty(input, 'isTTY', beforeInput)
    else delete input.isTTY
    if (beforeOutput) Object.defineProperty(output, 'isTTY', beforeOutput)
    else delete output.isTTY
    if (beforeError) Object.defineProperty(error, 'isTTY', beforeError)
    else delete error.isTTY
  }
})

test('full CPU usage history plus margin remains schedulable on a one-core host', () => {
  const budget = host.readSuiteMachine({ platform: 'linux', read: () => 'MemAvailable: 4194304 kB\n',
    total: () => 8 * 1024 ** 3, cpus: () => 1, load: () => [0] })
  const reservation = api.reservationForJob([measured(), measured(), measured()], 'heavy', budget)
  assert.deepEqual(api.admissionPlan([{ ...ticket(1), reservation }], [], budget, {}).admit, [1],
    'a completed full-CPU job must not become permanently unschedulable from its safety margin')
})

test('catalogue groups accepted replacements by the released command identity', () => {
  const runs = [measured(), measured(), measured()].map((run) => ({ cmd: 'other', release: { ...run.release, cmd: 'test' } }))
  const classes = catalogue.suiteResourceClasses(runs)
  assert.equal(classes.test?.cores, 1, 'catalogue and reservation admission must use the actual released command')
  assert.equal(classes.other, undefined)
})
