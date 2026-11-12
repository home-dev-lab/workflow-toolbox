import childProcess, { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { tmpdir, uptime } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
import { suiteBrokerAddress, suiteBrokerFixture } from './helpers/suite-broker-fixture.js'

const plugin = process.env.WT_RANK_TEST_PLUGIN ?? resolve(import.meta.dirname, '../../../../plugin')
const load = (name: string) => import(pathToFileURL(join(plugin, 'bin/lib', name + '.mjs')).href)
const order = await load('suite-lock-order')
const lock = await load('suite-lock')
const priority = await load('suite-lock-priority')
const state = await load('host/suite-lock-rank-state').catch(() => ({}))
const queue = await load('host/suite-lock-queue')
const park = await load('suite-lock-park')
const status = await load('suite-lock-status')
const pidNamespace = (await load('host/pid-namespace')).currentPidNamespace()
const legacyOrder = await load('suite-lock-legacy-order').catch(() => order)
const toolkit = process.env.WT_RANK_TEST_TOOLKIT ?? resolve(import.meta.dirname, '../../..')
const roots: string[] = []
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'suite-rank-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const now = Date.parse('2026-01-01T12:00:00Z')
const counter = { generation: 'light', grants: 0 }
const context = (extra = {}) => ({ lightCounter: counter, now, turns: {}, history: {}, precedence: {}, ...extra })
const ticket = (number: number, fields = {}) => ({ number, record: { level: 2, levelOrderVersion: 4,
  project: 'alpha', size: 'L', startedAt: new Date(now).toISOString(), lightGrantsAtQueue: 0,
  lightGrantsGeneration: 'light', ...fields } })
const rank = (entry: ReturnType<typeof ticket>, extra = {}) => order.rankSuiteLockTicket(entry, context(extra))
const numbers = (tickets: ReturnType<typeof ticket>[], extra = {}) => order.orderSuiteLockTickets(tickets, counter, now, undefined, context(extra)).tickets.map((t: { number: number }) => t.number)
const envFor = (root: string, extra = {}) => sealedPluginCliEnv(root, { WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', WT_SUITE_LOCK_PROJECT: '', WT_SUITE_LOCK_SIZE: '', ...extra })
const cli = (root: string, args: string[], extra = {}) => spawnSync(process.execPath, [join(plugin, 'bin/wt-suite-lock.mjs'), ...args], { env: envFor(root, extra), encoding: 'utf8', timeout: 15_000 })
const readState = (root: string, projects = ['alpha', 'beta']) => state.readSuiteLockRankState(root, projects.map((project, i) => ticket(i, { project })))
const statePath = (root: string, kind: string, project: string) => join(root, kind, createHash('sha256').update(project).digest('hex').slice(0, 16) + '.json')
const events = (root: string) => readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))

describe('started work and defensive rank state', () => {
  registerStartedTurns()
  registerCorruptRankState()
  registerMalformedRankState()
  registerBootElapsed()
})

async function serve(root: string, project: string, options = {}, outcome = {}) {
  const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project, ...options })
  lock.releaseSuiteLock(lease, { served: true, heldMs: 12, ...outcome })
}

function registerStartedTurns() {
  it('executed exit 75 consumes A1 turn so B1 precedes queued A2', async () => {
    const root = temp(); await serve(root, 'alpha'); await serve(root, 'beta')
    expect(cli(root, ['run', '--project', 'alpha', '--priority', 'P2', '--', process.execPath, '-e', 'process.exit(75)']).status).toBe(75)
    const entries = [ticket(2), ticket(3, { project: 'beta' })]
    expect(numbers(entries, readState(root)), 'B1 must follow executed A1 before A2').toEqual([3, 2])
    expect(readState(root).turns).toEqual({ alpha: 3, beta: 2 })
  })
  it('equal rank lights A1 A2 B1 alternate as A1 B1 A2', async () => {
    const root = temp(); const entries = [ticket(1, { light: true }), ticket(2, { light: true }), ticket(3, { light: true, project: 'beta' })]
    const grants: number[] = []
    while (entries.length) {
      const number = numbers(entries, readState(root))[0]; const index = entries.findIndex((entry) => entry.number === number)
      const [entry] = entries.splice(index, 1); grants.push(number)
      await serve(root, entry!.record.project, { light: true, size: 'S' })
    }
    expect(grants, 'light project turns alternate').toEqual([1, 3, 2])
    expect(readState(root)).toMatchObject({ turns: { alpha: 3, beta: 2 }, history: {} })
    expect(numbers([ticket(1, { light: true }), ticket(2, { light: true, project: 'beta' })], { turns: { alpha: 10, beta: 3 } })).toEqual([2, 1])
  })
  it('completed A release stamps a turn so B1 precedes A1 without changing S history', async () => {
    const root = temp(); await serve(root, 'alpha', { size: 'S' }, { heldMs: 660_000 }); await serve(root, 'beta')
    const before = readState(root).history
    await serve(root, 'alpha', { priority: 'release', size: 'S' })
    expect(numbers([ticket(1), ticket(2, { project: 'beta' })], readState(root)), 'B1 follows A release').toEqual([2, 1])
    expect(readState(root)).toMatchObject({ turns: { alpha: 3, beta: 2 }, history: before })
  })
  it('a served short S exit 75 restores bonus and a long S exit 75 consumes a turn', async () => {
    const root = temp(); await serve(root, 'alpha', { size: 'S' }, { exit: 75, heldMs: 660_000 })
    expect(readState(root)).toMatchObject({ turns: { alpha: 1 }, history: { alpha: { overran: true } } })
    await serve(root, 'alpha', { size: 'S' }, { exit: 75 })
    expect(readState(root)).toMatchObject({ turns: { alpha: 2 }, history: { alpha: { overran: false, heldMs: 12 } } })
  })
}

function putState(root: string, kind: string, project: string, content: unknown) {
  mkdirSync(join(root, kind), { recursive: true })
  writeFileSync(statePath(root, kind, project), typeof content === 'string' ? content : JSON.stringify(content))
}

function registerCorruptRankState() {
  it.each(['truncated', 'unreadable'])('corrupt size history withholds bonus without blocking admission: %s', async (mode) => {
    const root = temp(); putState(root, 'size-history', 'alpha', '{')
    if (mode === 'unreadable') { rmSync(statePath(root, 'size-history', 'alpha')); mkdirSync(statePath(root, 'size-history', 'alpha')) }
    expect(numbers([ticket(1, { size: 'S' }), ticket(2, { project: 'beta', level: 1 })], readState(root)), 'corruption must not restore S bonus').toEqual([2, 1])
    await serve(root, 'alpha')
    expect(readState(root).turns.alpha).toBe(1)
  })
  it.each(['valid', 'missing', 'corrupt'])('truncated project turn ranks most recent with %s sequence', (sequence) => {
    const root = temp(); putState(root, 'project-turns', 'alpha', '{')
    putState(root, 'project-turns', 'beta', { project: 'beta', turn: 3 })
    putState(root, 'project-turns', 'unrelated', { project: 'unrelated', turn: 9 })
    if (sequence !== 'missing') writeFileSync(join(root, 'turn-seq'), sequence === 'valid' ? '{"sequence":12}' : '{')
    expect(readState(root).turns).toEqual({ alpha: sequence === 'valid' ? 12 : 9, beta: 3 })
    expect(numbers([ticket(1), ticket(2, { project: 'beta' })], readState(root))).toEqual([2, 1])
  })
  it('unreadable rank state warns once per process and admission continues', () => {
    const root = temp(); putState(root, 'size-history', 'alpha', '{'); putState(root, 'project-turns', 'alpha', '{')
    const program = `import {readSuiteLockRankState as read} from ${JSON.stringify(pathToFileURL(join(plugin, 'bin/lib/host/suite-lock-rank-state.mjs')).href)};for(let i=0;i<3;i++)read(${JSON.stringify(root)},[{record:{project:'alpha'}}])`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stderr.match(/rank state unavailable/g), 'one diagnostic per process').toHaveLength(1)
    expect(result.stderr).toContain('continuing admission')
  })
}

function registerMalformedRankState() {
  it.each([{ toString: null }, 42, null, [], 'not-ISO', '2026-01-02', '2026-99-01T00:00:00Z', '2026-02-30T00:00:00Z'].map((until) => [until]))('malformed precedence until %j never throws or grants precedence', async (until) => {
    const root = temp(); putState(root, 'precedence', 'alpha', { project: 'alpha', until })
    const entries = [ticket(1), ticket(2, { project: 'beta', level: 1 })]
    expect(() => numbers(entries, readState(root))).not.toThrow()
    expect(numbers(entries, readState(root))).toEqual([2, 1])
    expect(numbers(entries, { precedence: { alpha: { until } } })).toEqual([2, 1])
    expect(() => state.listSuiteLockPrecedence(root)).not.toThrow()
    await serve(root, 'alpha')
  })
  it.each([
    ['project-turns', { project: 'alpha', turn: {} }], ['project-turns', { project: {}, turn: 1 }],
    ['size-history', { project: 'alpha', size: 'S', heldMs: '12', overran: false }],
    ['size-history', { project: 'alpha', size: 'S', heldMs: 12, overran: 'false' }],
    ['size-history', { project: null, size: 'S', heldMs: 12, overran: false }],
  ] as const)('invalid %s field types rank conservatively: %j', (kind, content) => {
    const root = temp(); putState(root, kind, 'alpha', content); writeFileSync(join(root, 'turn-seq'), '{"sequence":12}')
    const snapshot = readState(root)
    if (kind === 'project-turns') expect(snapshot.turns.alpha).toBe(12)
    else expect(rank(ticket(1, { size: 'S' }), snapshot).reason.sizeBonus).toBe(false)
  })
}

function registerBootElapsed() {
  it('grant persists boot relative start and boot identity at the host boundary', async () => {
    const root = temp(); const before = uptime() * 1000
    const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha' })
    try {
      const holder = JSON.parse(readFileSync(join(root, 'lock.d/holder.json'), 'utf8'))
      expect(Number.isFinite(holder.startedUptimeMs)).toBe(true)
      expect(holder.startedUptimeMs).toBeGreaterThanOrEqual(before)
      expect(holder.startedUptimeMs).toBeLessThanOrEqual(uptime() * 1000)
      if (process.platform === 'linux') expect(holder.bootId).toBe(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim())
    } finally { lock.releaseSuiteLock(lease) }
  })
  it.each(['waiter', 'force'])('same boot reclaim retains an S overrun after a backward wall clock step: %s', async (route) => {
    const root = temp(); const timing = { uptimeMs: 700_000, bootId: 'fixture-boot' }
    abandonedHolder(root, { startedAt: new Date(Date.now() + 2940_000).toISOString(), startedUptimeMs: timing.uptimeMs - 660_000, bootId: timing.bootId })
    const options = { root, bootClock: () => timing }
    if (route === 'force') expect(lock.operatorReleaseSuiteLock({ ...options, force: true }).released).toBe(true)
    else { const lease = await lock.acquireSuiteLock({ ...options, env: envFor(root), project: 'beta' }); lock.releaseSuiteLock(lease) }
    expect(readState(root)).toMatchObject({ turns: {}, history: { alpha: { overran: true } } })
    expect(readState(root).history.alpha.heldMs).toBeGreaterThanOrEqual(660_000)
  })
  it.each([
    ['same boot', 'boot', 700_000, 40_000, 2940_000, true, 660_000],
    ['different boot', 'old', 700_000, 40_000, -12, false, undefined],
    ['different boot wall overrun', 'old', 700_000, 699_999, -660_000, true, 660_000],
    ['backward wall fallback', 'old', 700_000, 40_000, 2940_000, true, undefined],
    ['unknown wall fallback', 'old', 700_000, 40_000, NaN, true, undefined],
    ['negative uptime fallback', 'boot', 700_000, 800_000, -660_000, true, 660_000],
  ] as const)('abandoned duration uses %s conservatively', (_name, bootId, uptimeMs, startedUptimeMs, wallOffset, overran, expectedMs) => {
    const root = temp(); const holder = { ...ticket(1, { size: 'S' }).record, bootId, startedUptimeMs, startedAt: Number.isFinite(wallOffset) ? new Date(now + wallOffset).toISOString() : null }
    state.recordAbandonedSuiteLock(root, holder, { now: () => now, bootClock: () => ({ bootId: 'boot', uptimeMs }) })
    expect(readState(root).turns).toEqual({})
    expect(readState(root).history.alpha?.overran === true).toBe(overran)
    if (expectedMs !== undefined) expect(readState(root).history.alpha.heldMs).toBe(expectedMs)
  })
}

describe('round three adversarial regressions', () => {
  registerAbandonedHistory()
  registerMonotonicAndRecovery()
  registerSafePrune()
  registerRawBroker()
  registerSnapshotSafety()
})

function abandonedHolder(root: string, fields = {}) {
  mkdirSync(join(root, 'lock.d'), { recursive: true })
  const holder = { ...ticket(1).record, pid: 2147483647, pidNamespace, leaseId: 'abandoned-instance', startedAt: new Date(Date.now() - 660_000).toISOString(), size: 'S', ...fields }
  writeFileSync(join(root, 'lock.d/holder.json'), JSON.stringify(holder))
  return holder
}

function registerAbandonedHistory() {
  it.each(['waiter', 'stale operator', 'force'])('an abandoned S overrun is recorded without a turn by %s reclaim', async (route) => {
    const root = temp(); abandonedHolder(root)
    if (route === 'waiter') {
      const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'beta' })
      lock.releaseSuiteLock(lease)
    } else if (route === 'force') expect(cli(root, ['release', '--force']).status).toBe(0)
    else expect(lock.operatorReleaseSuiteLock({ root }).released).toBe(true)
    expect(readState(root)).toMatchObject({ turns: {}, history: { alpha: { size: 'S', overran: true } } })
    expect(readState(root).history.alpha.heldMs).toBeGreaterThanOrEqual(660_000)
  })
  it.each([{ light: true }, { size: 'M' }, { priority: 'release' }, { startedAt: new Date(Date.now() - 1000).toISOString() }])('reclaim excludes ineligible history %j', (fields) => {
    const root = temp(); abandonedHolder(root, fields)
    expect(lock.operatorReleaseSuiteLock({ root, force: true }).released).toBe(true)
    expect(readState(root)).toEqual({ turns: {}, history: {}, precedence: {} })
  })
  it('reclaim confirms the judged instance before recording history and advisory failure never blocks removal', () => {
    const root = temp(); abandonedHolder(root)
    expect(lock.operatorReleaseSuiteLock({ root, beforeReclaimRemoval: () => abandonedHolder(root, { leaseId: 'replacement', startedAt: new Date().toISOString(), pid: process.pid }) }).released).toBe(false)
    expect(readState(root).history).toEqual({})
    abandonedHolder(root); writeFileSync(join(root, 'size-history'), 'unwritable directory')
    expect(lock.operatorReleaseSuiteLock({ root }).released).toBe(true)
    expect(existsSync(join(root, 'lock.d'))).toBe(false)
  })
  it('static-domain abandoned S never writes history', () => {
    const root = temp(); const staticRoot = join(root, 'static-lane'); abandonedHolder(staticRoot)
    expect(lock.operatorReleaseSuiteLock({ root: staticRoot, staticDomain: true }).released).toBe(true)
    expect(readState(staticRoot)).toEqual({ turns: {}, history: {}, precedence: {} })
  })
}

function registerMonotonicAndRecovery() {
  it('library leases measure monotonic duration and old leases fall back to wall time', async () => {
    const root = temp(); const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', size: 'S' })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600_000)
    try { lock.releaseSuiteLock(lease, { served: true }); expect(readState(root).history.alpha.overran).toBe(false); expect(readState(root).history.alpha.heldMs).toBeLessThan(10_000) }
    finally { clock.mockRestore() }
    const old = { holder: { startedAt: new Date(now - 1234).toISOString() } }
    expect(state.suiteLockReleaseOutcome(old, {}, now).heldMs).toBe(1234)
  })
  it('a valid turn sequence skips unreadable entries while missing sequence recovery stays strict', async () => {
    const root = temp(); mkdirSync(join(root, 'project-turns')); writeFileSync(statePath(root, 'project-turns', 'bad'), 'invalid JSON')
    writeFileSync(join(root, 'turn-seq'), JSON.stringify({ sequence: 93 }))
    const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha' }); lock.releaseSuiteLock(lease, { served: true })
    expect(readState(root).turns).toEqual({ alpha: 94 })
    rmSync(join(root, 'turn-seq'))
    const next = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'beta' }); lock.releaseSuiteLock(next, { served: true })
    expect(readState(root).turns).toEqual({ alpha: 94 })
  })
  it('every pre-v4 ticket keeps the exact legacy order', () => {
    expect(order.SUITE_LOCK_ORDER_VERSION).toBe(4)
    for (const version of [undefined, 1, 2, 3]) {
      const entries = [ticket(1, { levelOrderVersion: version }), ticket(2, { project: 'beta', size: 'S' })]
      const actual = order.orderSuiteLockTickets(entries, counter, now)
      const expected = legacyOrder.orderSuiteLockTickets(entries, counter, now)
      expect(actual.levelOrder).toBe(expected.levelOrder)
      expect(actual.tickets.map(({ number, key }: { number: number; key: number[] }) => [number, key])).toEqual(expected.tickets.map(({ number, key }: { number: number; key: number[] }) => [number, key]))
    }
  })
}

async function prune(root: string) { const files = await load('host/suite-lock-rank-files'); files.pruneSuiteLockRankState(root) }
function registerSafePrune() {
  it('thirty day maintenance preserves an outstanding S overrun penalty', async () => {
    const root = temp(); mkdirSync(join(root, 'size-history')); const file = statePath(root, 'size-history', 'alpha')
    writeFileSync(file, JSON.stringify({ project: 'alpha', size: 'S', heldMs: 660_000, overran: true }))
    const old = new Date(Date.now() - 31 * 86400_000); utimesSync(file, old, old)
    await prune(root)
    expect(readState(root).history.alpha?.overran, 'overrun penalty has no thirty day expiry').toBe(true)
  })
  it('prune never deletes unreadable or invalid precedence', async () => {
    const root = temp(); mkdirSync(join(root, 'precedence'))
    for (const content of ['invalid JSON', JSON.stringify({ project: 'alpha', until: null }), JSON.stringify({ project: 'alpha', until: 'invalid' })]) {
      const file = statePath(root, 'precedence', 'alpha'); writeFileSync(file, content); await prune(root)
      expect(existsSync(file), 'unreadable precedence must survive pruning').toBe(true)
      expect(readFileSync(file, 'utf8')).toBe(content)
    }
  })
  it.each([false, true])('prune preserves concurrent precedence renewal moved=%s', async (afterMove) => {
    const root = temp(); state.setSuiteLockPrecedence(root, { project: 'alpha', until: new Date(Date.now() - 1).toISOString() })
    const file = statePath(root, 'precedence', 'alpha'); const renewed = { project: 'alpha', until: new Date(Date.now() + 60_000).toISOString() }
    const original = fs.renameSync; let injected = false
    fs.renameSync = ((from, to) => {
      if (String(from) === file && !injected) { injected = true; if (!afterMove) writeFileSync(file, JSON.stringify(renewed)); original(from, to); if (afterMove) state.setSuiteLockPrecedence(root, renewed); return }
      return original(from, to)
    }) as typeof fs.renameSync; syncBuiltinESMExports()
    try { await prune(root); expect(injected, 'expired precedence is isolated before removal').toBe(true); expect(existsSync(file), 'concurrent renewal must survive pruning').toBe(true); expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(renewed) }
    finally { fs.renameSync = original; syncBuiltinESMExports() }
  })
}

async function rawBroker(root: string, message: object, grant?: () => void) {
  const address = suiteBrokerAddress(root); const { createSuiteLockBroker } = await load('host/lane-suite-lock-broker')
  const broker = createSuiteLockBroker({ root, env: envFor(root, { WT_SUITE_LOCK_PROJECT: 'alpha', WT_SUITE_LOCK_SIZE: 'S' }) })
  const fixture = suiteBrokerFixture(broker); await fixture.listen(address)
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(address); let text = ''; let sent = false
      socket.once('connect', () => socket.write(JSON.stringify({ argv: ['node', 'covered-job'], waitS: 1 }) + '\n'))
      socket.on('data', (chunk) => { text += chunk; if (!sent && /(?:^|\n)granted /.test(text)) { sent = true; grant?.(); socket.end(JSON.stringify(message) + '\n') } })
      socket.once('error', reject); socket.once('close', () => sent ? resolve() : reject(new Error(text)))
    })
  } finally { broker.releaseAll(); await fixture.close() }
}

function registerRawBroker() {
  it.each([{ exit: 0 }, { exit: 17 }, { exit: 0, served: false }, { exit: 75 }])('broker terminal outcome defaults to served with explicit opt outs %j', async (message) => {
    const root = temp(); await rawBroker(root, message)
    expect(readState(root).turns).toEqual('served' in message && message.served === false ? {} : { alpha: 1 })
  })
  it('broker ignores forged heldMs in raw terminal JSON after ten host monotonic minutes', async () => {
    const root = temp(); let clock: ReturnType<typeof vi.spyOn> | undefined
    try {
      await rawBroker(root, { exit: 0, served: true, heldMs: 1 }, () => { clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 600_001) })
      expect(readState(root).history.alpha, 'sandbox timing must never clear a real host overrun').toMatchObject({ overran: true })
      expect(readState(root).history.alpha.heldMs).toBeGreaterThanOrEqual(600_001)
    } finally { clock?.mockRestore() }
  })
  it.each([{ WT_SUITE_LOCK_PROJECT: 'bad\nproject' }, { WT_SUITE_LOCK_SIZE: 'invalid' }])('broker refuses invalid host metadata before listening %j', (env) => {
    const root = temp(); const address = suiteBrokerAddress(root)
    const result = spawnSync(process.execPath, [join(plugin, 'bin/lib/host/lane-suite-lock-broker.mjs'), '--socket', address, '--parent', String(process.pid), '--root', root], { env: envFor(root, env), encoding: 'utf8', timeout: 5000 })
    expect(result.status, result.stderr).toBe(2)
    expect(result.stderr).toContain('refused to start')
    expect(existsSync(address)).toBe(false)
  })
}

function registerSnapshotSafety() {
  it('a light holder yield check excludes its own light grant', async () => {
    const root = temp(); const c = queue.ensureLightCounter(root)
    writeFileSync(join(root, 'light-grants'), JSON.stringify({ ...c, grants: 7 }))
    const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', priority: 'P2', light: true, park: undefined })
    const record = { ...ticket(2, { light: true }).record, pid: process.pid }
    const parked = { ...ticket(1).record, project: 'beta', lightGrantsGeneration: c.generation }
    expect(park.shouldYieldParkLease({ ...lease, queueDir: join(root, 'queue.d'), ticket: 2, record }, { yieldToParked: true }, () => [{ number: 1, park: { record: parked } }]), 'own grant cannot exhaust the parked exclusive').toBe(false)
    lock.releaseSuiteLock(lease)
  })
  it('yield and journal snapshots discard stale tickets using the acquisition predicate', async () => {
    const root = temp(); const c = queue.ensureLightCounter(root)
    queue.takeTicket(join(root, 'queue.d'), { ...ticket(1, { levelOrderVersion: 2 }).record, pid: 2147483647, pidNamespace })
    const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', size: 'S' })
    expect(events(root)[0]).toMatchObject({ levelOrder: 'rank-v4', sizeBonus: true })
    queue.takeTicket(join(root, 'queue.d'), { ...ticket(2, { levelOrderVersion: 2 }).record, pid: 2147483647, pidNamespace })
    const record = { ...ticket(2, { light: true }).record, pid: process.pid }
    const parked = { ...ticket(1).record, lightGrantsGeneration: c.generation, lightGrantsAtQueue: c.grants }
    expect(park.shouldYieldParkLease({ ...lease, queueDir: join(root, 'queue.d'), ticket: 4, record }, { yieldToParked: true }, () => [{ number: 1, park: { record: parked } }])).toBe(false)
    lock.releaseSuiteLock(lease)
  })
  it('a rank snapshot failure preserves request grant and release journal events', async () => {
    const journal = await load('suite-lock-journal'); const root = temp(); const original = fs.readdirSync
    fs.readdirSync = (() => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) }) as typeof fs.readdirSync; syncBuiltinESMExports()
    try {
      const context = journal.suiteJournalRequest(root, 1, { ...ticket(1).record, pid: process.pid, leaseId: 'journal-fixture' }, 'P2', {}, false)
      expect(context, 'rank diagnostics cannot suppress a lease lifecycle').toBeDefined()
      journal.suiteJournalEvent(context, 'grant'); journal.suiteJournalEvent(context, 'release', { served: false })
      expect(events(root).map((entry) => entry.event)).toEqual(['request', 'grant', 'release'])
    } finally { fs.readdirSync = original; syncBuiltinESMExports() }
  })
}

describe('round two release and ranking contracts', () => {
  registerCompletionContracts()
  registerCompletionCallers()
  registerExhaustedOrder()
  registerDerivedProjects()
  registerStateMaintenance()
  registerPrecedenceValidation()
  registerBrokerCompletion()
})

function registerCompletionContracts() {
  registerSignalCompletion()
  it('library release defaults to not served and preserves a previous S overrun', async () => {
    const root = temp()
    const first = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', size: 'S' })
    lock.releaseSuiteLock(first, { served: true, exit: 1, heldMs: 600_001 })
    const next = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', size: 'S' })
    lock.releaseSuiteLock(next)
    expect(readState(root)).toMatchObject({ turns: { alpha: 1 }, history: { alpha: { heldMs: 600_001, overran: true } } })
    expect(events(root).at(-1)).toMatchObject({ served: false })
  })
  it.each([0, 17, 75])('CLI park request exit %i stamps neither turn nor short S history', (exit) => {
    const root = temp(); const directory = join(root, 'private')
    mkdirSync(directory, { mode: 0o700 }); writeFileSync(join(directory, 'key'), 'a-private-park-key-with-at-least-thirty-two-bytes', { mode: 0o600 })
    const result = cli(root, ['run', '--size', 'S', '--project', 'alpha', '--park-dir', directory, '--park-s', '60', '--park-owner-pid', String(process.pid), '--', process.execPath, '-e', `require('node:fs').writeFileSync(process.env.WT_SUITE_LOCK_PARK_REQUEST,'busy');process.exit(${exit})`])
    expect(result.status).toBe(exit)
    expect(readState(root)).toEqual({ turns: {}, history: {}, precedence: {} })
    expect(events(root).at(-1)).toMatchObject({ served: false, exit })
  })
  registerCliStarted()
  it('CLI history records command runtime rather than grant-to-release elapsed time', () => {
    const root = temp()
    const script = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const write=fs.writeSync;const mono=performance.now.bind(performance);const wall=Date.now;let gap=false;fs.writeSync=function(...args){const result=Reflect.apply(write,this,args);if(String(args[1]).includes('"event":"grant"')){Object.defineProperty(performance,'now',{configurable:true,value:()=>mono()+3600000});Date.now=()=>wall()+3600000;gap=true}return result};syncBuiltinESMExports();const {runSuiteLockCli}=await import(${JSON.stringify(pathToFileURL(join(plugin, 'bin/wt-suite-lock.mjs')).href)});process.exitCode=await runSuiteLockCli(['run','--size','S','--project','alpha','--',process.execPath,'-e','setTimeout(()=>{},120)']);process.stdout.write('gap='+Number(gap))`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: envFor(root), encoding: 'utf8' })
    expect(result.status).toBe(0); expect(result.stdout).toBe('gap=1')
    const history = readState(root).history.alpha
    expect(history.heldMs).toBeGreaterThanOrEqual(120)
    expect(history.heldMs).toBeLessThan(10_000)
    expect(history.overran).toBe(false)
    expect(readState(root).turns.alpha).toBe(1)
  })
}

function registerCliStarted() {
  it('CLI exit 75 after running stamps a project turn and short S history', () => {
    const root = temp(); const result = cli(root, ['run', '--size', 'S', '--project', 'alpha', '--', process.execPath, '-e', 'process.exit(75)'])
    expect(result.status).toBe(75)
    expect(readState(root)).toMatchObject({ turns: { alpha: 1 }, history: { alpha: { overran: false } } })
    expect(events(root).at(-1)).toMatchObject({ served: true, exit: 75 })
  })
  it('CLI spawn failure does not consume a project turn', () => {
    const root = temp(); const result = cli(root, ['run', '--size', 'S', '--project', 'alpha', '--', join(root, 'nonexistent-command')])
    expect(result.status).not.toBe(0)
    expect(readState(root)).toEqual({ turns: {}, history: {}, precedence: {} })
    expect(events(root).at(-1)).toMatchObject({ served: false })
  })
}

function registerSignalCompletion() {
  it('a started command ended by signal consumes its turn and the changelog states it', () => {
    const root = temp(); const result = cli(root, ['run', '--project', 'alpha', '--', process.execPath, '-e', 'process.kill(process.pid,"SIGTERM")'])
    expect(result.status).toBe(143)
    expect(readState(root).turns).toEqual({ alpha: 1 })
    expect(readFileSync(join(plugin, 'CHANGELOG.md'), 'utf8')).toContain('Commands that started and ended, by exit or signal, consume project')
  })
}

function registerCompletionCallers() {
  registerCertificationSpawnFailure()
  it.each([0, 75])('release-certify refusal consumes no turn and executed exit %i does', async (exit) => {
    const root = temp(); const certifyRoot = join(root, 'toolkit'); mkdirSync(certifyRoot)
    const program = `import {certify} from ${JSON.stringify(pathToFileURL(join(toolkit, 'scripts/release-certify.mjs')).href)};process.exitCode=await certify({root:${JSON.stringify(certifyRoot)},lockRoot:${JSON.stringify(root)},gates:['typecheck'],probe:()=>({load:5,capacity:2,source:'fixture'}),override:process.argv[1]==='run',executeGate:async()=>${exit}})`
    const run = (mode: string) => spawnSync(process.execPath, ['--input-type=module', '-e', program, mode], { env: envFor(root, { WT_SUITE_LOCK_PROJECT: 'alpha', WT_SUITE_LOCK_SIZE: 'S' }), encoding: 'utf8' })
    expect(run('refuse').status).toBe(75)
    expect(readState(root)).toEqual({ turns: {}, history: {}, precedence: {} })
    expect(events(root).at(-1)).toMatchObject({ served: false, exit: 75 })
    expect(run('run').status).toBe(exit)
    expect(readState(root).turns).toEqual({ alpha: 1 })
    expect(events(root).at(-1)).toMatchObject({ served: true, exit })
  })
  it.each([0, 75])('vitest global setup marks completed exit %i explicitly served', (exit) => {
    const root = temp()
    const program = `import setup from ${JSON.stringify(pathToFileURL(join(toolkit, 'test-support/suite-lease.global-setup.mjs')).href)};await setup({config:{watch:false}});process.exitCode=${exit}`
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', program], { env: envFor(root, { WT_SUITE_LOCK_PROJECT: 'alpha', WT_SUITE_LOCK_SIZE: 'S' }), encoding: 'utf8' }).status).toBe(exit)
    expect(readState(root).turns).toEqual({ alpha: 1 })
    expect(events(root).at(-1)).toMatchObject({ served: true, exit })
  })
}

function registerCertificationSpawnFailure() {
  it.skipIf(process.platform === 'win32')('certification gate spawn failure consumes no project turn', () => {
    const root = temp(); const certifyRoot = join(root, 'toolkit'); mkdirSync(certifyRoot)
    const program = `import {certify} from ${JSON.stringify(pathToFileURL(join(toolkit, 'scripts/release-certify.mjs')).href)};process.exitCode=await certify({root:${JSON.stringify(certifyRoot)},lockRoot:${JSON.stringify(root)},gates:['typecheck'],probe:()=>({load:null,capacity:2,source:'unavailable'})})`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { env: envFor(root, { PATH: root, WT_SUITE_LOCK_PROJECT: 'alpha', WT_SUITE_LOCK_SIZE: 'S' }), encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('ENOENT')
    expect(readState(root)).toEqual({ turns: {}, history: {}, precedence: {} })
    expect(events(root).at(-1)).toMatchObject({ served: false })
  })
}

function registerExhaustedOrder() {
  registerMergeFamily()
  registerMergeCounterexamples()
  it('light S earns no bonus and cannot pass an exhausted P2 exclusive', () => {
    expect(numbers([ticket(1), ticket(2, { light: true, size: 'S' })], { lightCounter: { ...counter, grants: 8 } })).toEqual([1, 2])
    expect(rank(ticket(2, { light: true, size: 'S' })).reason).toMatchObject({ sizeBonus: false, rankLevel: 2 })
  })
  it('missing projects use unnamed consistently for ranking precedence and service state', async () => {
    expect(rank(ticket(1, { project: undefined }), { turns: { unnamed: 9 }, precedence: { unnamed: { until: new Date(now + 1).toISOString() } } }).reason).toMatchObject({ project: 'unnamed', projectTurn: 9, tier: 1 })
    const root = temp(); const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha' })
    delete lease.holder.project
    writeFileSync(join(root, 'lock.d/holder.json'), JSON.stringify(lease.holder))
    lock.releaseSuiteLock(lease, { served: true, exit: 0, heldMs: 12 })
    expect(readState(root, ['unnamed']).turns).toEqual({ unnamed: 1 })
  })
  registerLegacyDiagnostics()
}

function registerMergeFamily() {
  it('block merge preserves light bounds project turns and FIFO across snapshot families', () => {
    for (const turns of [{ alpha: 10, beta: 3 }, { alpha: 3, beta: 10 }, { alpha: 0, beta: 0 }]) {
      for (let mask = 0; mask < 8; mask++) {
        const exclusive = [1, 3, 5].map((number, index) => ticket(number, { project: index === 1 ? 'beta' : 'alpha', lightGrantsAtQueue: mask & (1 << index) ? 3 : 0 }))
        const entries = [...exclusive, ticket(2, { light: true }), ticket(4, { light: true })]
        const extra = { lightCounter: { ...counter, grants: 8 }, turns }
        const result = numbers(entries, extra)
        expect(numbers([...entries].reverse(), extra)).toEqual(result)
        expect(result.filter((n: number) => n % 2 === 0)).toEqual([2, 4])
        const expectedExclusive = [...exclusive].sort((a, b) => turns[a.record.project as keyof typeof turns] - turns[b.record.project as keyof typeof turns] || a.number - b.number).map((entry) => entry.number)
        expect(result.filter((n: number) => n % 2 === 1)).toEqual(expectedExclusive)
        for (const entry of exclusive.filter((entry) => entry.record.lightGrantsAtQueue === 0)) {
          for (const light of [2, 4].filter((n) => n > entry.number)) expect(result.indexOf(entry.number)).toBeLessThan(result.indexOf(light))
        }
      }
    }
  })
}

function registerMergeCounterexamples() {
  it('exhausted exclusives alternate projects without a ninth light pass', () => {
    const entries = [ticket(2), ticket(4), ticket(6), ticket(8, { project: 'beta' })]
    const extra = { lightCounter: { ...counter, grants: 8 }, turns: { alpha: 10, beta: 3 } }
    for (const lightNumber of [1, 3, 5, 7, 9]) {
      const expected = lightNumber === 1 ? [1, 8, 2, 4, 6] : [8, 2, ...[4, 6].filter((n) => n < lightNumber), lightNumber, ...[4, 6].filter((n) => n >= lightNumber)]
      expect(numbers([...entries, ticket(lightNumber, { light: true })].reverse(), extra), `light #${lightNumber} cannot pass an earlier exhausted exclusive`).toEqual(expected)
    }
  })
  it('fresh and exhausted exclusives share project turns and within-project FIFO', () => {
    const extra = { lightCounter: { ...counter, grants: 8 }, turns: { alpha: 10, beta: 3 } }
    const entries = [ticket(1), ticket(2), ticket(3, { project: 'beta', lightGrantsAtQueue: 3 })]
    expect(numbers(entries, extra), 'fresh beta precedes exhausted alpha').toEqual([3, 1, 2])
    expect(numbers([ticket(1), ticket(2, { lightGrantsAtQueue: 3 }), ticket(3, { light: true })], extra)).toEqual([1, 3, 2])
    expect(numbers([ticket(1), ticket(2, { light: true }), ticket(3, { light: true })])).toEqual([2, 3, 1])
  })
}

function registerLegacyDiagnostics() {
  it('mixed snapshots expose legacy order without current bonus or tier in every diagnostic', async () => {
    const root = temp(); const env = envFor(root)
    const held = await lock.acquireSuiteLock({ root, env })
    const c = queue.ensureLightCounter(root)
    const old = { ...ticket(1).record, pid: process.pid, levelOrderVersion: 2, lightGrantsGeneration: c.generation }
    queue.takeTicket(join(root, 'queue.d'), old)
    const lines: string[] = []
    try { await lock.acquireSuiteLock({ root, env, project: 'alpha', size: 'S', waitS: 0, onWait: (line: string) => lines.push(line) }) } catch { /* expected timeout */ }
    finally { lock.releaseSuiteLock(held) }
    const request = events(root).filter((event) => event.event === 'request').at(-1)
    expect(request).toMatchObject({ levelOrder: 'bounded-p0', sizeBonus: false })
    expect(request).not.toHaveProperty('tier')
    expect(lines.join('\n')).toContain('legacy order')
    expect(lines.join('\n')).not.toContain('tier ')
    const snapshot = status.suiteLockStatusSnapshot({ held: false }, [ticket(1, { levelOrderVersion: 2, size: 'S' })], counter, now, {}, undefined, context())
    expect(snapshot.queue[0].reason).not.toHaveProperty('tier')
    expect(status.formatSuiteLockStatus(snapshot, '')).toContain('legacy order')
    const stale = status.suiteLockStatusSnapshot({ held: false }, [ticket(1), { ...ticket(2, { startedAt: new Date(now - 3 * 3600_000).toISOString() }), stale: true }], counter, now, {}, undefined, context())
    expect(stale.queue[1].effectiveLevel).toBe(2)
  })
}

function registerDerivedProjects() {
  it('derived project names sanitize controls trim cap and fall back at filesystem root', () => {
    expect(() => priority.suiteLockRankOptions({ cwd: '/', home: temp() }, {})).not.toThrow()
    expect(priority.suiteLockRankOptions({ cwd: '/', home: temp() }, {}).project).toBe('unnamed')
    const original = childProcess.execFileSync
    try {
      for (const [name, expected] of [[' alpha\u200d\u0001 ', 'alpha'], ['x'.repeat(140), 'x'.repeat(120)], ['\u200d', 'unnamed']] as const) {
        const home = temp(); const cwd = temp()
        childProcess.execFileSync = (() => join(cwd, name, '.git')) as unknown as typeof childProcess.execFileSync; syncBuiltinESMExports()
        expect(priority.suiteLockRankOptions({ cwd, home }, {}).project).toBe(expected)
      }
    } finally { childProcess.execFileSync = original; syncBuiltinESMExports() }
  })
  it.each([false, true])('inherited acquisition does not evaluate project defaults or declarations static=%s', async (staticRun) => {
    const lifecycle = await load('suite-lock-journal-lifecycle')
    const inherited = { inherited: true }
    const options = { static: staticRun, env: {}, get cwd() { throw new Error('project evaluated before inherited lease') } }
    await expect(lifecycle.acquireJournalLease(() => { throw new Error('must inherit') }, options, 'domain', () => 'lease', () => inherited)).resolves.toBe(inherited)
  })
  registerInheritedCli()
  it('explicit invalid project fails with exit 64 before creating a queue', () => {
    const root = temp(); const result = cli(root, ['run', '--project', 'bad\nproject', '--', process.execPath, '-e', ''])
    expect(result.status).toBe(64)
    expect(existsSync(join(root, 'queue.d'))).toBe(false)
  })
  it('Windows child environments remove size declarations case insensitively', () => {
    expect(park.spawnParkEnvironment(null, undefined, { Wt_Suite_Lock_Size: 'S', WT_SUITE_LOCK_PROJECT: 'alpha' }, 'win32')).toEqual({ env: { WT_SUITE_LOCK_PROJECT: 'alpha' } })
  })
  it('git project discovery has a two-second timeout and hidden Windows console', async () => {
    const project = await load('host/suite-lock-project'); const cwd = temp(); const original = childProcess.execFileSync
    const calls: unknown[][] = []
    childProcess.execFileSync = ((...args: unknown[]) => { calls.push(args); throw new Error('git timed out') }) as typeof childProcess.execFileSync
    syncBuiltinESMExports()
    try { expect(project.defaultSuiteLockProject(cwd, temp())).toBe(basename(cwd)); expect(calls).toHaveLength(1); expect(calls[0]?.[2]).toMatchObject({ timeout: 2000, windowsHide: true }) }
    finally { childProcess.execFileSync = original; syncBuiltinESMExports() }
  })
}

function registerInheritedCli() {
  it('inherited CLI size declarations do not resolve a default project during flag parsing', () => {
    const root = temp()
    const program = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {acquireSuiteLock,releaseSuiteLock,suiteLeaseMarker} from ${JSON.stringify(pathToFileURL(join(plugin, 'bin/lib/suite-lock.mjs')).href)};import {runSuiteLockCli} from ${JSON.stringify(pathToFileURL(join(plugin, 'bin/wt-suite-lock.mjs')).href)};const lease=await acquireSuiteLock({project:'alpha',size:'L'});let gitCalls=0;cp.execFileSync=()=>{gitCalls++;throw Error('unexpected project discovery')};syncBuiltinESMExports();process.env.WT_SUITE_LEASE=suiteLeaseMarker(lease);try{const exit=await runSuiteLockCli(['run','--size','S','--',process.execPath,'-e','']);process.stdout.write(JSON.stringify({exit,gitCalls}))}finally{releaseSuiteLock(lease)}`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { cwd: root, env: envFor(root), encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ exit: 0, gitCalls: 0 })
  })
}

function registerStateMaintenance() {
  registerCounterReadFailure()
  it.each([{ served: false }, { served: true, lost: true }, { served: true, yielded: true }])('long S history survives an unserved ending %j', async (outcome) => {
    const root = temp(); const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', size: 'S' })
    lock.releaseSuiteLock(lease, { ...outcome, heldMs: 600_001 })
    expect(readState(root)).toMatchObject({ turns: {}, history: { alpha: { project: 'alpha', size: 'S', heldMs: 600_001, overran: true } } })
  })
  it('snapshot reads only current project hashes without listing state directories', () => {
    const root = temp()
    for (const project of ['alpha', 'beta']) state.setSuiteLockPrecedence(root, { project, until: new Date(now + 1).toISOString() })
    const original = fs.readdirSync
    fs.readdirSync = (() => { throw new Error('snapshot listed a directory') }) as typeof fs.readdirSync; syncBuiltinESMExports()
    try { expect(state.readSuiteLockRankState(root, [ticket(1)]).precedence).toEqual({ alpha: { project: 'alpha', until: new Date(now + 1).toISOString() } }) }
    finally { fs.readdirSync = original; syncBuiltinESMExports() }
  })
  it('release prunes stale turns and history and expired precedence but keeps recent state', async () => {
    const root = temp(); const stale = new Date(Date.now() - 31 * 86400_000)
    for (const kind of ['project-turns', 'size-history']) {
      mkdirSync(join(root, kind)); writeFileSync(statePath(root, kind, 'old'), JSON.stringify({ project: 'old', turn: 7, size: 'S', heldMs: 12, overran: false })); utimesSync(statePath(root, kind, 'old'), stale, stale)
      writeFileSync(statePath(root, kind, 'recent'), JSON.stringify({ project: 'recent', turn: 9, size: 'S', heldMs: 20, overran: false }))
    }
    state.setSuiteLockPrecedence(root, { project: 'old', until: new Date(Date.now() - 1).toISOString() })
    state.setSuiteLockPrecedence(root, { project: 'recent', until: new Date(Date.now() + 60_000).toISOString() })
    const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha' }); lock.releaseSuiteLock(lease, { served: true })
    for (const kind of ['project-turns', 'size-history', 'precedence']) {
      expect(existsSync(statePath(root, kind, 'old'))).toBe(false)
      expect(existsSync(statePath(root, kind, 'recent'))).toBe(true)
    }
    expect(readState(root).turns.alpha).toBe(10)
  })
  it.each(['missing', 'corrupt'])('turn sequence recovers above all stamped turns with a %s counter', async (counterState) => {
    const root = temp(); mkdirSync(join(root, 'project-turns'))
    writeFileSync(statePath(root, 'project-turns', 'unrelated'), JSON.stringify({ project: 'unrelated', turn: 93 }))
    if (counterState === 'corrupt') writeFileSync(join(root, 'turn-seq'), 'corrupt')
    const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha' })
    lock.releaseSuiteLock(lease, { served: true, exit: 0, heldMs: 3 })
    expect(readState(root).turns.alpha).toBe(94)
    expect(JSON.parse(readFileSync(join(root, 'turn-seq'), 'utf8'))).toEqual({ sequence: 94 })
  })
}

function registerCounterReadFailure() {
  it('an unreadable turn directory cannot restart a missing counter below existing stamps', async () => {
    const root = temp(); mkdirSync(join(root, 'project-turns'))
    writeFileSync(statePath(root, 'project-turns', 'unrelated'), JSON.stringify({ project: 'unrelated', turn: 93 }))
    const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', size: 'S' })
    const original = fs.readdirSync
    fs.readdirSync = ((file, ...args) => { if (String(file) === join(root, 'project-turns')) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return Reflect.apply(original, fs, [file, ...args]) }) as typeof fs.readdirSync
    syncBuiltinESMExports()
    try { expect(() => lock.releaseSuiteLock(lease, { served: true, heldMs: 12 })).not.toThrow() }
    finally { fs.readdirSync = original; syncBuiltinESMExports() }
    expect(existsSync(join(root, 'turn-seq')), 'unreadable high-water marks must skip the turn write').toBe(false)
    expect(readState(root)).toMatchObject({ turns: {}, history: { alpha: { heldMs: 12, overran: false } } })
  })
}

function registerPrecedenceValidation() {
  it('precedence requires future timezone-qualified expiry within seven days and trims projects', () => {
    for (const until of [undefined, '2099-01-01T00:00:00Z', '2020-01-01T00:00:00Z', new Date(Date.now() + 60_000).toISOString().replace('Z', '')]) {
      const root = temp(); const args = ['precedence', 'set', '--project', 'alpha', '--source', 'operator']
      if (until) args.push('--until', until)
      expect(cli(root, args).status).not.toBe(0)
      expect(existsSync(join(root, 'precedence'))).toBe(false)
    }
    const root = temp()
    expect(cli(root, ['precedence', 'set', '--project', ' alpha ', '--until', new Date(Date.now() + 60_000).toISOString(), '--source', 'operator']).status).toBe(0)
    expect(JSON.parse(cli(root, ['precedence', 'list']).stdout)[0].project).toBe('alpha')
    state.setSuiteLockPrecedence(root, { project: 'expired', until: new Date(Date.now() - 1).toISOString() })
    expect(JSON.parse(cli(root, ['precedence', 'list']).stdout).map((entry: { project: string }) => entry.project)).toEqual(['alpha'])
  })
  it('precedence validation reports the first invalid argument before any write', () => {
    const root = temp()
    expect(cli(root, ['precedence', 'unknown']).stderr).toContain('use precedence')
    expect(cli(root, ['precedence', 'set', '--until', 'bad', '--project', '', '--source', '']).stderr.split('\n')[0]).toContain('--until')
    expect(cli(root, ['precedence', 'set', '--source', '', '--project', 'alpha', '--until', 'bad']).stderr.split('\n')[0]).toContain('--source')
    expect(existsSync(join(root, 'precedence'))).toBe(false)
  })
}

async function brokerRun(root: string, command: string[], maxHoldS = 5, granted?: () => void) {
  const address = suiteBrokerAddress(root); const { createSuiteLockBroker } = await load('host/lane-suite-lock-broker')
  const broker = createSuiteLockBroker({ root, maxHoldS, env: envFor(root, { WT_SUITE_LOCK_PROJECT: 'alpha', WT_SUITE_LOCK_SIZE: 'S' }) })
  const fixture = suiteBrokerFixture(broker); await fixture.listen(address)
  try {
    const result = new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [join(plugin, 'bin/wt-suite-lock.mjs'), 'run', '--', ...command], { env: envFor(root, { WT_SUITE_LOCK_BROKER: address }), stdio: 'ignore' })
      child.once('error', reject); child.once('close', resolve)
    })
    if (granted) { while (!existsSync(join(root, 'lock.d/holder.json'))) await new Promise((resolve) => setTimeout(resolve, 5)); granted() }
    return await result
  } finally { broker.releaseAll(); await fixture.close() }
}

function registerBrokerCompletion() {
  it('sandbox not-started stays unserved at the broker and completed nonzero exit stamps a turn', async () => {
    const root = temp()
    expect(await brokerRun(root, [join(root, 'nonexistent-command')])).not.toBe(0)
    expect(readState(root)).toEqual({ turns: {}, history: {}, precedence: {} })
    expect(events(root).at(-1)).toMatchObject({ served: false })
    expect(await brokerRun(root, [process.execPath, '-e', 'process.exit(17)'])).toBe(17)
    expect(readState(root)).toMatchObject({ turns: { alpha: 1 }, history: { alpha: { overran: false } } })
    const heldMs = events(root).at(-1).heldMs
    expect(heldMs).toBeGreaterThan(0); expect(heldMs).toBeLessThan(10_000)
    expect(readState(root).history.alpha).toMatchObject({ project: 'alpha', size: 'S', heldMs, overran: false })
    expect(events(root).at(-1)).toMatchObject({ served: true, exit: 17 })
  })
  it('broker measures S duration monotonically on the host despite a wall clock step', async () => {
    const root = temp(); let clock: ReturnType<typeof vi.spyOn> | undefined
    try {
      const exit = await brokerRun(root, [process.execPath, '-e', 'setTimeout(()=>process.exit(0),300)'], 5, () => {
        clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600_000)
      })
      expect(exit).toBe(0)
      expect(readState(root)).toMatchObject({ turns: { alpha: 1 }, history: { alpha: { size: 'S', overran: false } } })
      expect(readState(root).history.alpha.heldMs).toBeLessThan(10_000)
    } finally { clock?.mockRestore() }
  })
  it('broker hold-limit loss records a long S overrun without serving a turn', async () => {
    const root = temp(); let clock: ReturnType<typeof vi.spyOn> | undefined
    try {
      const exit = await brokerRun(root, [process.execPath, '-e', 'setInterval(()=>{},1000)'], 0.3, () => {
        clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 600_001)
      })
      expect(exit).toBe(75)
      expect(readState(root)).toMatchObject({ turns: {}, history: { alpha: { size: 'S', overran: true } } })
      expect(readState(root).history.alpha.heldMs).toBeGreaterThanOrEqual(600_001)
      expect(events(root).at(-1)).toMatchObject({ served: false, lost: true })
    } finally { clock?.mockRestore() }
  })
}

it('malformed order-version markers keep legacy ordering', () => {
  expect(order.orderSuiteLockTickets([ticket(1, { levelOrderVersion: '4' })], counter, now).levelOrder, 'malformed version marker retains exact legacy mode').toBe('legacy')
})

describe('one queue ranking policy', () => {
  registerRankPriority()
  registerRankProjects()
  registerRankDiagnostics()
})

function registerRankPriority() {
  it('row 1 removes level aging from v4', () => {
    expect(numbers([ticket(1, { startedAt: new Date(now - 3 * 3600_000).toISOString() }), ticket(2, { level: 1 })]), 'old P2 stays behind fresh P1').toEqual([2, 1])
  })
  it('row 2 bounds light bypass even across projects', () => {
    expect(numbers([ticket(1), ticket(2, { light: true, project: 'beta' })], { lightCounter: { ...counter, grants: 8 }, turns: { alpha: 9 } }), 'ninth light cannot pass exhausted exclusive').toEqual([1, 2])
  })
  it('row 3 gives only S one priority level', () => {
    expect(['S', 'M', 'L', undefined].map((size) => rank(ticket(1, { size })).key[1]), 'only S receives one level').toEqual([1, 2, 2, 2])
    expect(rank(ticket(1, { level: 0, size: 'S' })).key[1]).toBe(0)
  })
}

function registerRankProjects() {
  it('row 4 alternates equal rank by completed project turn', () => {
    const tickets = [ticket(1), ticket(2), ticket(3), ticket(4, { project: 'beta' })]
    expect(numbers(tickets, { turns: { alpha: 1 } }), 'other project gets next equal-rank turn').toEqual([4, 1, 2, 3])
    expect(numbers(tickets, { turns: { alpha: 1, beta: 2 } })).toEqual([1, 2, 3, 4])
  })
  it('row 5 keeps first come within a project regardless of request clock', () => {
    expect(numbers([ticket(9, { startedAt: 'invalid' }), ticket(2)]), 'same project keeps ticket-number order').toEqual([2, 9])
  })
  it('treats prototype-named projects as unserved and sanitizes rank display', () => {
    expect(rank(ticket(1, { project: 'constructor' })).key[3]).toBe(0)
    expect(rank(ticket(1, { project: 'alpha\nforged' })).reason.line).not.toContain('\n')
  })
  it('row 6 withholds S bonus at rank time until a short S completes', () => {
    const entry = ticket(1, { size: 'S', sizeBonus: true })
    expect(rank(entry, { history: { alpha: { overran: true } } }).key[1], 'overrun withholds queued S bonus').toBe(2)
    expect(rank(entry, { history: { alpha: { overran: false } } }).key[1]).toBe(1)
  })
}

function registerRankDiagnostics() {
  it('row 7 explains declared level, size bonus, project and turn in text and JSON', () => {
    const ordered = order.orderSuiteLockTickets([ticket(12, { size: 'S' })], counter, now, undefined, context({ turns: { alpha: 3 } }))
    const snapshot = status.suiteLockStatusSnapshot({ held: false }, [ticket(12, { size: 'S' })], counter, now, {}, undefined, context({ turns: { alpha: 3 } }))
    expect(ordered.tickets[0].reason?.line, 'rank reason includes declared priority and size').toMatch(/rank P1.*declared P2.*size S \+1.*project alpha.*turn 3.*ticket 12/)
    expect(status.formatSuiteLockStatus(snapshot, '')).toContain(ordered.tickets[0].reason.line)
    expect(status.suiteLockStatusJson(snapshot).queue[0].reason.line).toBe(ordered.tickets[0].reason.line)
  })
  it('row 8 orders release then active precedence above every priority', () => {
    const tickets = [ticket(1, { level: 0, size: 'S' }), ticket(2, { project: 'beta' }), ticket(3, { priority: 'release' })]
    expect(numbers(tickets, { precedence: { beta: { until: new Date(now + 1).toISOString() } } }), 'release then precedence then normal priority').toEqual([3, 2, 1])
    expect(numbers(tickets, { precedence: { beta: { until: new Date(now).toISOString() } } })).toEqual([3, 1, 2])
  })
  it('row 9 accepts size and project options ahead of env and strips nested size', () => {
    const root = temp()
    const result = cli(root, ['run', '--size', 'S', '--project', 'alpha', '--', process.execPath, '-e', 'process.stdout.write(JSON.stringify({size:process.env.WT_SUITE_LOCK_SIZE,project:process.env.WT_SUITE_LOCK_PROJECT}))'], { WT_SUITE_LOCK_SIZE: 'M', WT_SUITE_LOCK_PROJECT: 'beta' })
    expect(result.status, 'size CLI is accepted').toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ project: 'alpha' })
    const events = readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(events[0]).toMatchObject({ project: 'alpha', size: 'S', tier: 2 })
    expect(events.find((event) => event.event === 'grant')).toMatchObject({ project: 'alpha', rankLevel: 0 })
     expect(events.find((event) => event.event === 'release')).toMatchObject({ served: true })
     expect(events.find((event) => event.event === 'release').heldMs).toBeGreaterThan(0)
     expect(readState(root).turns.alpha).toBe(1)
    expect(cli(root, ['run', '--size', 'tiny', '--', process.execPath, '-e', '']).status).toBe(2)
  })
}

describe('rank state and rollover', () => {
  registerRollover()
  registerServiceHistory()
  registerServiceExclusions()
  registerParkAndRecovery()
  registerPrecedence()
  registerWaitAndBroker()
  registerSandboxCli()
  registerProjectDefault()
})

function registerRollover() {
  it('retains exactly the develop key on independent golden mixed-version snapshots', () => {
    const golden = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/suite-lock-order-golden.json'), 'utf8'))
    expect(golden.source).toEqual({ generator: 'toolkit/scripts/generate-suite-lock-order-golden.mjs', upstreamCommit: '77635d4d2' })
    for (const vector of golden.rollover) {
      for (const implementation of [legacyOrder, order]) {
        const result = implementation.orderSuiteLockTickets(vector.tickets, vector.counter, golden.now, vector.p0Counter)
        expect({ order: result.order, levelOrder: result.levelOrder, ranked: result.tickets.map((t: { number: number; key: number[]; effectiveLevel?: number }) => [t.number, t.key, t.effectiveLevel ?? null]) }).toEqual(vector.expected)
      }
    }
    expect(golden.rollover.length).toBe(864)
  })
  it('proves P0 floor inert without aging against independent develop golden vectors', () => {
    const golden = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/suite-lock-order-golden.json'), 'utf8'))
    for (const vector of golden.p0) {
      expect(rank(ticket(1, vector.record), { lightCounter: vector.counter }).key[1]).toBe(vector.expected)
    }
    expect(golden.p0.length).toBe(1620)
  })
}

function registerServiceHistory() {
  it('writes served exclusive turns and S duration before removing mutex', async () => {
    const root = temp(); const env = envFor(root)
    const lease = await lock.acquireSuiteLock({ root, env, project: 'alpha', size: 'S' })
    expect(readState(root).turns).toEqual({})
    const original = fs.renameSync; const publications: string[] = []
    fs.renameSync = ((from, to) => { if (String(to).includes('project-turns') || String(to).includes('size-history')) { expect(existsSync(lease.lockDir), 'rank publication must precede mutex removal').toBe(true); publications.push(String(to)) } return original(from, to) }) as typeof fs.renameSync
    syncBuiltinESMExports()
    try { lock.releaseSuiteLock(lease, { served: true, exit: 0, heldMs: 600_001 }) }
    finally { fs.renameSync = original; syncBuiltinESMExports() }
    expect(publications).toHaveLength(2)
    expect(readState(root)).toMatchObject({ turns: { alpha: 1 }, history: { alpha: { overran: true, heldMs: 600_001 } } })
    const next = await lock.acquireSuiteLock({ root, env, project: 'alpha', size: 'S' })
    lock.releaseSuiteLock(next, { served: true, exit: 0, heldMs: 20 })
    expect(readState(root)).toMatchObject({ turns: { alpha: 2 }, history: { alpha: { overran: false, heldMs: 20 } } })
  })
}

function registerServiceExclusions() {
  it.each([{ exit: 0, served: false }, { served: true, lost: true }, { exit: 0, served: true, yielded: true }])('does not stamp an unserved lease %j', async (outcome) => {
    const root = temp(); const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', size: 'S' })
    lock.releaseSuiteLock(lease, outcome)
    expect(readState(root).turns).toEqual({})
  })
  it.each([12, 700_000])('a served light stamps a turn but never changes S history heldMs=%i', async (heldMs) => {
    const root = temp(); await serve(root, 'alpha', { size: 'S', light: true }, { heldMs })
    expect(readState(root)).toEqual({ turns: { alpha: 1 }, history: {}, precedence: {} })
    await serve(root, 'alpha', { size: 'S' }, { heldMs: 660_000 }); const before = readState(root).history
    await serve(root, 'alpha', { size: 'S', light: true }, { heldMs })
    expect(readState(root)).toMatchObject({ turns: { alpha: 3 }, history: before })
  })
  it('static lane writes no rank state', async () => {
    const options = { static: true }
    const root = temp(); const lease = await lock.acquireSuiteLock({ root, env: envFor(root, { WT_SUITE_LOCK_STATIC_LANE: '1' }), project: 'alpha', size: 'S', ...options })
    if (options.static) expect(lease.staticDomain).toBe(true)
    lock.releaseSuiteLock(lease, { served: true, heldMs: 700_000 })
    expect(readdirSync(root).filter((name) => ['turn-seq', 'project-turns', 'size-history', 'precedence'].includes(name))).toEqual([])
    expect(existsSync(join(root, 'static-lane', 'project-turns'))).toBe(false)
    expect(existsSync(join(root, 'static-lane', 'size-history'))).toBe(false)
  })
  it.each([12, 600_001])('release priority stamps project turn but no S history heldMs=%i', async (heldMs) => {
    const root = temp(); const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', size: 'S', priority: 'release' })
    lock.releaseSuiteLock(lease, { served: true, heldMs })
    expect(readState(root)).toEqual({ turns: { alpha: 1 }, history: {}, precedence: {} })
  })
}

function registerParkAndRecovery() {
  it('park yield ranks the holder with its pre-admission project turn', async () => {
    const root = temp(); const queueDir = join(root, 'queue.d')
    const c = queue.ensureLightCounter(root)
    const record = { ...ticket(1).record, lightGrantsGeneration: c.generation }
    const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', size: 'L', priority: 'P2' })
    expect(park.shouldYieldParkLease({ ...lease, queueDir, ticket: 1, record }, { yieldToParked: true }, () => [{ number: 2, park: { record: { ...record, project: 'beta' } } }])).toBe(false)
    lock.releaseSuiteLock(lease, { served: false })
  })
  it('reads corrupt state fail-soft and retries transient read failures', () => {
    const root = temp(); mkdirSync(join(root, 'project-turns')); writeFileSync(join(root, 'turn-seq'), 'bad')
    expect(readState(root).turns).toEqual({})
    let calls = 0
    expect(queue.readCounterText('ignored', () => { if (++calls < 3) throw Object.assign(new Error(), { code: 'EBUSY' }); return 'ok' })).toBe('ok')
    expect(calls).toBe(3)
  })
  it('resolves explicit and ambient metadata and ignores sandbox inputs', () => {
    expect(priority.suiteLockRankOptions({ project: 'alpha', size: 'S' }, { WT_SUITE_LOCK_PROJECT: 'beta', WT_SUITE_LOCK_SIZE: 'M' })).toEqual({ project: 'alpha', size: 'S' })
    expect(priority.suiteLockRankOptions({}, { WT_SUITE_LOCK_PROJECT: 'beta', WT_SUITE_LOCK_SIZE: 'M' })).toEqual({ project: 'beta', size: 'M' })
    expect(priority.suiteLockRankOptions({ project: 'alpha', size: 'S' }, { WT_SUITE_LOCK_BROKER: 'host', WT_SUITE_LOCK_SIZE: 'M' })).toEqual({})
  })
}

function registerPrecedence() {
  it('concurrent precedence sets survive and clear is journaled', async () => {
    const root = temp()
    await Promise.all(['alpha', 'beta'].map((project) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [join(plugin, 'bin/wt-suite-lock.mjs'), 'precedence', 'set', '--project', project, '--until', new Date(Date.now() + 60_000).toISOString(), '--source', 'operator'], { env: envFor(root), stdio: 'ignore' })
      child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`precedence set exit ${code}`)))
    })))
    expect(JSON.parse(cli(root, ['precedence', 'list']).stdout).map((entry: { project: string }) => entry.project)).toEqual(['alpha', 'beta'])
    expect(cli(root, ['precedence', 'clear', '--project', 'alpha']).status).toBe(0)
    expect(readState(root).precedence).not.toHaveProperty('alpha')
    expect(JSON.parse(readFileSync(statePath(root, 'precedence', 'alpha'), 'utf8')).until).toBe(null)
    expect(readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).action).sort()).toEqual(['clear', 'set', 'set'])
    expect(cli(root, ['precedence', 'list'], { WT_SUITE_LOCK_BROKER: 'host' }).status).toBe(2)
  })
}

function registerWaitAndBroker() {
  it('waiting diagnostics include the live rank reason', async () => {
    const root = temp(); const env = envFor(root)
    const held = await lock.acquireSuiteLock({ root, env })
    const lines: string[] = []
    try { await expect(lock.acquireSuiteLock({ root, env, project: 'alpha', size: 'S', priority: 'P2', waitS: 0, onWait: (line: string) => lines.push(line) })).rejects.toThrow('timed out') }
    finally { lock.releaseSuiteLock(held) }
    expect(lines.join('\n')).toMatch(/rank P1.*declared P2.*size S \+1.*project alpha/)
  })
  it('broker uses host metadata and ignores sandbox options and env', async () => {
    const root = temp(); const address = suiteBrokerAddress(root)
    const { createSuiteLockBroker } = await load('host/lane-suite-lock-broker')
    const broker = createSuiteLockBroker({ root, env: envFor(root, { WT_SUITE_LOCK_PROJECT: 'host-project', WT_SUITE_LOCK_SIZE: 'M' }) })
    const fixture = suiteBrokerFixture(broker)
    await fixture.listen(address)
    try {
      const lease = await lock.acquireSuiteLock({ env: { WT_SUITE_LOCK_BROKER: address, WT_SUITE_LOCK_PROJECT: 'forged', WT_SUITE_LOCK_SIZE: 'S' }, project: 'forged', size: 'S', argv: ['node', '-e', ''] })
      expect(lock.readSuiteLock({ root }).holder).toMatchObject({ project: 'host-project', size: 'M' })
      lock.releaseSuiteLock(lease)
    } finally { broker.releaseAll(); await fixture.close() }
  })
}

function registerSandboxCli() {
  it('sandbox CLI ignores --size and --project with one diagnostic', async () => {
    const root = temp(); const address = suiteBrokerAddress(root)
    const { createSuiteLockBroker } = await load('host/lane-suite-lock-broker')
    const broker = createSuiteLockBroker({ root, env: envFor(root, { WT_SUITE_LOCK_PROJECT: 'host-project', WT_SUITE_LOCK_SIZE: 'M' }) })
    const fixture = suiteBrokerFixture(broker)
    await fixture.listen(address)
    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [join(plugin, 'bin/wt-suite-lock.mjs'), 'run', '--size', 'S', '--project', 'forged', '--', process.execPath, '-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(root, 'lock.d/holder.json'))}, 'utf8'))`], { env: envFor(root, { WT_SUITE_LOCK_BROKER: address, WT_SUITE_LOCK_SIZE: 'S', WT_SUITE_LOCK_PROJECT: 'forged' }) })
        let stdout = ''; let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk }); child.stderr.on('data', (chunk) => { stderr += chunk })
        child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr }))
      })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ project: 'host-project', size: 'M' })
      expect(result.stderr.match(/sandbox declarations are ignored/g)).toHaveLength(1)
    } finally { broker.releaseAll(); await fixture.close() }
  })
}

function registerProjectDefault() {
  it('default project uses outermost below-home configuration ancestor', () => {
    const home = temp(); const outer = join(home, 'outer'); const inner = join(outer, 'inner')
    mkdirSync(join(home, '.claude')); mkdirSync(join(outer, '.claude'), { recursive: true }); mkdirSync(join(inner, '.claude'), { recursive: true })
    expect(priority.suiteLockRankOptions({ cwd: inner, home }, {}).project).toBe('outer')
  })
}
