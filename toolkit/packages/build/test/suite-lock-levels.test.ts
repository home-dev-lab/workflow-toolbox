import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime JavaScript under plugin/
import * as lock from '../../../../plugin/bin/lib/suite-lock.mjs'
// @ts-expect-error runtime JavaScript under plugin/
import { createSuiteLockBroker } from '../../../../plugin/bin/lib/host/lane-suite-lock-broker.mjs'
// @ts-expect-error runtime JavaScript under plugin/
import { ensureLightCounter, ensureP0Counter, readAdmissionCounter, readLightCounter, readP0Counter, recordAdmissionGrant, recordP0Grant, removeTicket, takeTicket } from '../../../../plugin/bin/lib/host/suite-lock-queue.mjs'
// @ts-expect-error runtime JavaScript under plugin/
import { orderSuiteLockTickets, P0_BYPASS_MAX_GRANTS } from '../../../../plugin/bin/lib/suite-lock-order.mjs'
// @ts-expect-error runtime JavaScript under plugin/
import { suiteQueueAdvanced } from '../../../../plugin/bin/lib/suite-lock-progress.mjs'
// @ts-expect-error runtime JavaScript under plugin/
import { currentPidNamespace } from '../../../../plugin/bin/lib/host/pid-namespace.mjs'
// @ts-expect-error runtime JavaScript under plugin/
import * as statusApi from '../../../../plugin/bin/lib/suite-lock-status.mjs'
// @ts-expect-error runtime JavaScript under plugin/
import * as priorityApi from '../../../../plugin/bin/lib/suite-lock-priority.mjs'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
import { baseSuiteLock } from './helpers/base-version-client.js'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(ROOT, 'plugin/bin/wt-suite-lock.mjs')
const roots: string[] = []
const children: Array<ReturnType<typeof spawn>> = []
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'wt-lock-levels-')); roots.push(root); return root }
const envFor = (root: string, extra: NodeJS.ProcessEnv = {}) => sealedPluginCliEnv(root, {
  WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', ...extra,
})
const records = (root: string) => existsSync(join(root, 'queue.d')) ? readdirSync(join(root, 'queue.d')).filter((name) => name.endsWith('.json')).sort() : []
// A variable specifier keeps the plugin's untyped runtime JavaScript out of the type check without an expect-error.
const loadPluginModule = (relative: string) => import(pathToFileURL(join(ROOT, relative)).href)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 15_000
  while (!check()) { if (Date.now() > deadline) throw new Error('fixture deadline'); await pause(10) }
}
function cli(root: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env: envFor(root, extra), encoding: 'utf8', timeout: 15_000 })
}
async function service(root: string, specs: Array<{ name: string; priority?: string; light?: boolean; api?: typeof lock; now?: () => number }>) {
  const holder = await lock.acquireSuiteLock({ root, env: envFor(root) })
  const order: string[] = []; const levels: Array<number | undefined> = []; let inside = 0; let peak = 0
  const all: Promise<void>[] = []
  const abort = new AbortController()
  try {
    for (const spec of specs) {
      const api = spec.api ?? lock
      const promise = api.acquireSuiteLock({ root, env: envFor(root, { WT_SUITE_LOCK_PRIORITY: spec.priority }),
        ...(spec.priority === 'release' ? { priority: 'release' } : {}), light: spec.light, argv: [spec.name],
        waitS: 5, staleS: 5, pollMs: 10, signal: abort.signal, ...(spec.now ? { now: spec.now } : {}),
      }).then(async (lease: { holder: { leaseId: string; level?: number } }) => {
        inside += 1; peak = Math.max(peak, inside)
        expect(lock.readSuiteLock({ root }).holder.leaseId).toBe(lease.holder.leaseId)
        await new Promise<void>((resolve) => setImmediate(resolve)); order.push(spec.name); levels.push(lease.holder.level); inside -= 1; api.releaseSuiteLock(lease)
      })
      all.push(promise); void promise.catch(() => {})
      await waitFor(() => records(root).length === all.length)
    }
    lock.releaseSuiteLock(holder); await Promise.all(all)
    return { order, peak, levels }
  } finally { abort.abort(); lock.releaseSuiteLock(holder); await Promise.allSettled(all) }
}
function seed(root: string, fields: Record<string, unknown> = {}) {
  const counter = ensureLightCounter(root)
  return takeTicket(join(root, 'queue.d'), { pid: process.pid, pidNamespace: currentPidNamespace(), startTime: null,
    argv: ['queued'], startedAt: new Date().toISOString(), level: 1,
    lightGrantsAtQueue: counter.grants, lightGrantsGeneration: counter.generation, ...fields }) as number
}

describe('card levels and exact mixed-version ordering', () => {
  it('C1 serves a later P0 before two P2 tickets, then P2 FIFO', async () => {
    const result = await service(temp(), [{ name: 'P2a', priority: 'P2' }, { name: 'P2b', priority: 'P2' }, { name: 'P0', priority: 'P0' }])
    expect(result.order, 'P0 queued after two P2 must be served first').toEqual(['P0', 'P2a', 'P2b'])
  })
  it('C2 retains exclusive FIFO within a level and release ahead of P0', async () => {
    const result = await service(temp(), [{ name: 'P0a', priority: 'P0' }, { name: 'P0b', priority: 'P0' }, { name: 'R', priority: 'release' }])
    expect(result.order).toEqual(['R', 'P0a', 'P0b'])
    expect(result.levels, 'release and P0 holders always record numeric level zero').toEqual([0, 0, 0])
  })
  it.each([29, 31, 61])('C3 ages P2 with an injected clock after %i minutes', async (minutes) => {
    const root = temp(); const now = Date.parse('2026-01-01T12:00:00Z')
    seed(root, { level: 2, startedAt: new Date(now - minutes * 60_000).toISOString() })
    seed(root, { level: 0, startedAt: new Date(now).toISOString() })
    const snapshot = lock.readSuiteLockStatus({ root, env: envFor(root), now: () => now })
    expect(snapshot.queue.map((item: { number: number }) => item.number)).toEqual(minutes >= 60 ? [1, 2] : [2, 1])
    expect(snapshot.queue.find((item: { number: number }) => item.number === 1).effectiveLevel).toBe(minutes >= 60 ? 0 : minutes >= 30 ? 1 : 2)
  })
  it('C3b fully aged or invalid-time tickets cannot be passed by later P0 light arrivals', () => {
    const root = temp(); const now = Date.now()
    seed(root, { level: 2, startedAt: 'unparsable' }); seed(root, { level: 0, light: true })
    expect(lock.readSuiteLockStatus({ root, env: envFor(root), now: () => now }).queue.map((item: { number: number }) => item.number)).toEqual([1, 2])
  })
  it.each([0, 1, 2])('F1 a P%i exclusive becomes unpassable after one aging step', (level) => {
    const root = temp(); const now = Date.now()
    const counter = ensureLightCounter(root)
    const ordered = orderSuiteLockTickets([{ number: 1, record: { level, startedAt: new Date(now - 30 * 60_000).toISOString(), lightGrantsGeneration: counter.generation, lightGrantsAtQueue: 0 } }], counter, now)
    expect(ordered.tickets[0].key[1]).toBe(0)
    const earlier = seed(root, { level: 0, startedAt: new Date(now - 30 * 60_000).toISOString() })
    const later = seed(root, { level, startedAt: new Date(now - 30 * 60_000).toISOString() })
    seed(root, { level: 0, light: true })
    const queue = lock.readSuiteLockStatus({ root, env: envFor(root), now: () => now }).queue
    expect(queue[0].number, 'earlier aged P0 exclusive must precede later aged P1 exclusive').toBe(earlier)
    expect(queue.findIndex((entry: { number: number }) => entry.number === later)).toBeGreaterThan(0)
  })
  it('F1 serves P0 within bounded admissions under replenished aged P1 traffic', () => {
    const now = Date.now(); const counter = { generation: 'same', grants: 0 }
    const record = (level: number, startedAt: number) => ({ level, startedAt: new Date(startedAt).toISOString(), lightGrantsAtQueue: 0, lightGrantsGeneration: 'same' })
    let queue = Array.from({ length: 11 }, (_, index) => ({ number: index + 1, record: record(index === 0 ? 0 : 1, now) }))
    let clock = now + 40 * 60_000; let next = 12; let admitted = false
    for (let admission = 0; admission < 1000; admission += 1) {
      const head = orderSuiteLockTickets(queue, counter, clock).tickets[0]
      if (head.number === 1) { admitted = true; break }
      queue = queue.filter((ticket) => ticket.number !== head.number)
      queue.push({ number: next++, record: record(1, clock) }); clock += 5 * 60_000
    }
    expect(admitted, 'P0 must acquire within bounded admissions despite replenished aged P1 exclusives').toBe(true)
  })
  it('C4 actual develop exclusive and new light P0 both acquire, with develop light ordering', async ({ skip }) => {
    const base = await baseSuiteLock(temp(), 'preLevels')
    if (!base.client) { skip(base.unavailable); return }
    const old = base.client; const root = temp()
    const result = await service(root, [{ name: 'old-E', api: old }, { name: 'new-L', priority: 'P0', light: true }])
    expect(result.order).toEqual(['new-L', 'old-E'])
    expect(result.peak).toBe(1)
  })
  it('C4b an old ticket preserves exact develop order in a mixed queue', async ({ skip }) => {
    const base = await baseSuiteLock(temp(), 'preLevels')
    if (!base.client) { skip(base.unavailable); return }
    const old = base.client
    const result = await service(temp(), [{ name: 'P0', priority: 'P0' }, { name: 'old', api: old }, { name: 'P2-L', priority: 'P2', light: true }, { name: 'R', priority: 'release' }])
    expect(result.order).toEqual(['R', 'P2-L', 'P0', 'old'])
  })
  it('C5 mixed levels, light, release and actual older clients all acquire singly', async ({ skip }) => {
    const base = await baseSuiteLock(temp(), 'preRelease')
    if (!base.client) { skip(base.unavailable); return }
    const old = base.client
    const result = await service(temp(), [{ name: 'P2', priority: 'P2' }, { name: 'P1-L', priority: 'P1', light: true }, { name: 'P0', priority: 'P0' }, { name: 'R', priority: 'release' }, { name: 'old', api: old }])
    expect(result.peak).toBe(1)
    expect(result.order.slice().sort()).toEqual(['P0', 'P1-L', 'P2', 'R', 'old'].sort())
  })
})

// Tickets a bounded-P0 client writes: the order-version marker, plus the P0 counter at queue time for P1/P2.
function seedBounded(root: string, fields: Record<string, unknown> = {}) {
  const p0 = ensureP0Counter(root)
  const queueFields = fields.level === 0 ? {} : { p0GrantsAtQueue: p0.grants, p0GrantsGeneration: p0.generation }
  return seed(root, { levelOrderVersion: 2, ...queueFields, ...fields })
}
const minutesAgo = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString()
const statusNumbers = (root: string, now: number) => lock.readSuiteLockStatus({ root, env: envFor(root), now: () => now })
  .queue.map((item: { number: number }) => item.number)
// Three P1/P2 tickets queued 61, 120 and 180 minutes ago: past one hour every one of them ages to P0 by time alone.
function agedQueue(root: string, now: number) {
  return [seedBounded(root, { level: 1, startedAt: minutesAgo(now, 61) }), seedBounded(root, { level: 2, startedAt: minutesAgo(now, 120) }),
    seedBounded(root, { level: 1, startedAt: minutesAgo(now, 180) })]
}
function grantP0(root: string, count: number) { for (let index = 0; index < count; index += 1) recordP0Grant(root) }

describe('declared P0 order in a queue older than one hour (bounded P0 bypass): order and bound', () => {
  it('B1 a declared P0 queued after aged P1/P2 tickets is served first; aged tickets keep their order', () => {
    const root = temp(); const now = Date.parse('2026-01-01T12:00:00Z')
    const aged = agedQueue(root, now); const p0 = seedBounded(root, { level: 0, startedAt: minutesAgo(now, 0) })
    expect(statusNumbers(root, now), 'a fresh declared P0 must precede P1/P2 tickets aged past one hour').toEqual([p0, ...aged])
  })
  it('B1b a declared P0 queued before the aged tickets stays first (regression lock)', () => {
    const root = temp(); const now = Date.parse('2026-01-01T12:00:00Z')
    const p0 = seedBounded(root, { level: 0, startedAt: minutesAgo(now, 5) }); const aged = agedQueue(root, now)
    expect(statusNumbers(root, now)).toEqual([p0, ...aged])
  })
  it('B2 the bypass is bounded: 15 counted P0 admissions keep P0 first, the 16th lets aged tickets age to P0 in FIFO', () => {
    expect(P0_BYPASS_MAX_GRANTS, 'the stated bound').toBe(16)
    const now = Date.parse('2026-01-01T12:00:00Z')
    const within = temp(); const agedWithin = agedQueue(within, now); grantP0(within, 15)
    const p0Within = seedBounded(within, { level: 0, startedAt: minutesAgo(now, 0) })
    expect(statusNumbers(within, now), '15 P0 admissions since queue time: still inside the bound').toEqual([p0Within, ...agedWithin])
    const spent = temp(); const agedSpent = agedQueue(spent, now); grantP0(spent, 16)
    const p0Spent = seedBounded(spent, { level: 0, startedAt: minutesAgo(now, 0) })
    expect(statusNumbers(spent, now), '16 P0 admissions since queue time: aged tickets join P0 and go first by number').toEqual([...agedSpent, p0Spent])
  })
})

describe('declared P0 order in a queue older than one hour (bounded P0 bypass): with a pre-bounded client in the queue', () => {
  it('B3 one live ticket without the order marker puts the whole queue on the pre-bounded client order', async ({ skip }) => {
    const archive = temp(); const base = await baseSuiteLock(archive, 'preBoundedP0')
    if (!base.client) { skip(base.unavailable); return }
    const baseOrder = await import(pathToFileURL(join(archive, 'plugin/bin/lib/suite-lock-order.mjs')).href)
    const root = temp(); const now = Date.parse('2026-01-01T12:00:00Z')
    agedQueue(root, now); seed(root, { level: 1, startedAt: minutesAgo(now, 90) }); seedBounded(root, { level: 0, startedAt: minutesAgo(now, 0) })
    const tickets = lock.readSuiteLockStatus({ root, env: envFor(root), now: () => now }).queue.map((item: { number: number }) => item.number)
    const records = readdirSync(join(root, 'queue.d')).filter((name) => name.endsWith('.json')).sort()
      .map((name) => ({ number: Number(name.slice(0, 16)), record: JSON.parse(readFileSync(join(root, 'queue.d', name), 'utf8')) }))
    const counter = readLightCounter(root); const p0Counter = readP0Counter(root)
    const mixed = orderSuiteLockTickets(records, counter, now, p0Counter)
    const legacy = baseOrder.orderSuiteLockTickets(records, counter, now)
    expect(mixed.levelOrder, 'a ticket from a pre-bounded client selects the legacy order').toBe('legacy')
    expect(mixed.tickets.map((ticket: { number: number; key: number[] }) => [ticket.number, ...ticket.key]))
      .toEqual(legacy.tickets.map((ticket: { number: number; key: number[] }) => [ticket.number, ...ticket.key]))
    expect(tickets).toEqual(legacy.tickets.map((ticket: { number: number }) => ticket.number))
  })
  it('B4 actual pre-bounded client beside aged new-client tickets: every waiter acquires singly, in the legacy order', async ({ skip }) => {
    const base = await baseSuiteLock(temp(), 'preBoundedP0')
    if (!base.client) { skip(base.unavailable); return }
    const old = base.client
    // The first clock read is the ticket's queue time (waiterRecord); later reads are the real clock, so the ticket is 2 h old.
    const queuedTwoHoursAgo = () => { let first = true; return () => { const shift = first ? 120 * 60_000 : 0; first = false; return Date.now() - shift } }
    const result = await service(temp(), [{ name: 'A1', priority: 'P1', now: queuedTwoHoursAgo() }, { name: 'A2', priority: 'P2', now: queuedTwoHoursAgo() },
      { name: 'old', api: old }, { name: 'P0', priority: 'P0' }])
    expect(result.peak).toBe(1)
    expect(result.order, 'legacy key (bounded order would put P0 first): aged tickets by number, then the fresh P0, then the fresh older client').toEqual(['A1', 'A2', 'P0', 'old'])
  })
})

describe('declared P0 order in a queue older than one hour (bounded P0 bypass): counting P0 admissions', () => {
  it('B5 a real P0 acquisition passes aged tickets and counts one P0 grant; P1 and release admissions do not', async () => {
    const root = temp(); const now = Date.now()
    const aged = [seedBounded(root, { level: 1, startedAt: minutesAgo(now, 90) }), seedBounded(root, { level: 2, startedAt: minutesAgo(now, 150) })]
    const before = readP0Counter(root)
    const p0 = await lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P0', now: () => now, waitS: 1, staleS: 1, pollMs: 10 })
      .catch((error: { code: string }) => error.code)
    expect(typeof p0, 'a declared P0 must acquire while P1/P2 tickets aged past one hour wait').toBe('object')
    lock.releaseSuiteLock(p0)
    expect(readP0Counter(root), 'a declared P0 admission counts one P0 grant').toEqual({ generation: before.generation, grants: before.grants + 1 })
    for (const number of aged) removeTicket(join(root, 'queue.d'), number)
    for (const options of [{ priority: 'P1' }, { priority: 'release' }, { priority: 'P2', light: true }]) {
      lock.releaseSuiteLock(await lock.acquireSuiteLock({ root, env: envFor(root), ...options }))
    }
    expect(readP0Counter(root).grants, 'P1, P2 light and release admissions count no P0 grant').toBe(before.grants + 1)
    lock.releaseSuiteLock(await lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P0', light: true }))
    expect(readP0Counter(root).grants, 'a light declared P0 admission counts too').toBe(before.grants + 2)
  })
  it('B5b a P0 admission never creates the P0 counter', async () => {
    const root = temp()
    lock.releaseSuiteLock(await lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P0' }))
    expect(existsSync(join(root, 'p0-grants'))).toBe(false)
  })
})

describe('declared P0 order in a queue older than one hour (bounded P0 bypass): which tickets are passable', () => {
  it('B6 a ticket with another P0 generation, or no P0 fields, is not passable and ages as before', () => {
    const root = temp(); const now = Date.parse('2026-01-01T12:00:00Z')
    const passable = seedBounded(root, { level: 1, startedAt: minutesAgo(now, 90) })
    const otherGeneration = seedBounded(root, { level: 1, startedAt: minutesAgo(now, 90), p0GrantsGeneration: 'other' })
    const noFields = seed(root, { level: 1, startedAt: minutesAgo(now, 90), levelOrderVersion: 2 })
    const p0 = seedBounded(root, { level: 0, startedAt: minutesAgo(now, 0) })
    expect(statusNumbers(root, now), 'only the ticket with a matching P0 record is passed').toEqual([otherGeneration, noFields, p0, passable])
  })
  it.each([{ p0GrantsGeneration: 'other' }, { p0GrantsAtQueue: undefined }, { p0GrantsAtQueue: 1.5 }, { p0GrantsAtQueue: 4 }, { p0GrantsGeneration: null }])('B6b pure: an aged P1 recorded with %j is not passable', (fields) => {
    const now = Date.parse('2026-01-01T12:00:00Z'); const p0Counter = { generation: 'same', grants: 3 }; const counter = { generation: 'light', grants: 0 }
    const marker = { levelOrderVersion: 2, lightGrantsGeneration: 'light', lightGrantsAtQueue: 0 }
    const tickets = [{ number: 1, record: { ...marker, level: 1, startedAt: minutesAgo(now, 90), p0GrantsAtQueue: 0, p0GrantsGeneration: 'same', ...fields } },
      { number: 2, record: { ...marker, level: 0, startedAt: minutesAgo(now, 0) } }]
    const ordered = orderSuiteLockTickets(tickets, counter, now, p0Counter)
    expect(ordered.levelOrder).toBe('bounded-p0')
    expect(ordered.tickets.map((ticket: { number: number }) => ticket.number)).toEqual([1, 2])
    const control = orderSuiteLockTickets([{ ...tickets[0]!, record: { ...tickets[0]!.record, p0GrantsAtQueue: 0, p0GrantsGeneration: 'same' } }, tickets[1]!], counter, now, p0Counter)
    expect(control.tickets.map((ticket: { number: number }) => ticket.number), 'control: the same ticket with a matching record is passed').toEqual([2, 1])
  })
})

describe('declared P0 order in a queue older than one hour (bounded P0 bypass): unreadable start time and status', () => {
  it('B7 bounded twin of C3b: an unreadable start time with P0 budget is floored at P1, so a later P0 light passes it', () => {
    const root = temp(); const now = Date.now()
    const unreadable = seedBounded(root, { level: 2, startedAt: 'unparsable' }); const light = seedBounded(root, { level: 0, light: true })
    const snapshot = lock.readSuiteLockStatus({ root, env: envFor(root), now: () => now })
    expect(snapshot.queue.map((item: { number: number }) => item.number)).toEqual([light, unreadable])
    expect(snapshot.queue[1].effectiveLevel, 'floored at P1 while the P0 budget remains').toBe(1)
  })
  it('B8 status shows the level each ticket is ordered by and names the order', () => {
    const root = temp(); const now = Date.now()
    seedBounded(root, { level: 1, startedAt: minutesAgo(now, 90) })
    const budgeted = cli(root, ['status'])
    expect(budgeted.status).toBe(0); expect(budgeted.stdout).toContain('1. P1 exclusive'); expect(budgeted.stdout).not.toContain('declared')
    expect(budgeted.stdout).not.toContain('legacy level order')
    expect(JSON.parse(cli(root, ['status', '--json']).stdout)).toMatchObject({ order: 'levels', levelOrder: 'bounded-p0', queue: [{ level: 1, effectiveLevel: 1 }] })
    grantP0(root, 16); const counter = readFileSync(join(root, 'p0-grants'), 'utf8')
    expect(cli(root, ['status']).stdout, 'budget spent: the ticket ages to P0 as before').toContain('1. P0 (declared P1) exclusive')
    seed(root, { level: 2, startedAt: minutesAgo(now, 1) })
    const legacy = cli(root, ['status'])
    expect(legacy.stdout).toContain('legacy level order'); expect(legacy.stdout).toContain('predates bounded P0 order')
    expect(JSON.parse(cli(root, ['status', '--json']).stdout)).toMatchObject({ order: 'levels', levelOrder: 'legacy' })
    seed(root, { level: undefined })
    const compatible = cli(root, ['status'])
    expect(compatible.stdout).toContain('compatibility order'); expect(compatible.stdout, 'compatible mode names only its own order').not.toContain('legacy level order')
    expect(readFileSync(join(root, 'p0-grants'), 'utf8'), 'status never writes the P0 counter').toBe(counter)
  })
})

describe('declared P0 order in a queue older than one hour (bounded P0 bypass): when the P0 counter cannot be written', () => {
  it('B9 a P0 grant that cannot be written invalidates the P0 counter, so tickets recorded against it age as before', async () => {
    const root = temp(); const counter = ensureP0Counter(root); mkdirSync(join(root, `p0-grants.${process.pid}.tmp`))
    const notes: string[] = []; vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { notes.push(String(chunk)); return true })
    const held = await lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P0' })
    try {
      expect(held.holder.leaseId).toBeTruthy()
      expect(notes.filter((line) => line.includes('P0 admission not counted')), 'one stderr line names the uncounted admission and the reset').toHaveLength(1)
      expect(existsSync(join(root, 'p0-grants')), 'the counter is removed, never left behind unchanged').toBe(false)
    } finally { lock.releaseSuiteLock(held) }
    const now = Date.now()
    const aged = seed(root, { level: 1, startedAt: minutesAgo(now, 90), levelOrderVersion: 2, p0GrantsAtQueue: counter.grants, p0GrantsGeneration: counter.generation })
    const p0 = seed(root, { level: 0, startedAt: minutesAgo(now, 0), levelOrderVersion: 2 })
    expect(statusNumbers(root, now), 'the aged P1 recorded against the removed counter is no longer passed').toEqual([aged, p0])
  })
  it('B9c a P0 grant whose write AND invalidation both fail fails the admission: the lease is handed back, nothing overtakes silently', async () => {
    const root = temp(); const counter = ensureP0Counter(root)
    const failure = (code: string) => () => { throw Object.assign(new Error(code), { code }) }
    const attempt = lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P0', waitS: 1, pollMs: 10, p0GrantSeams: { write: failure('EIO'), remove: failure('EIO') } })
    await expect(attempt).rejects.toMatchObject({ code: 'EIO' })
    expect(lock.readSuiteLock({ root }).held, 'the provisional lease was handed back').toBe(false)
    expect(records(root), 'the ticket is withdrawn').toEqual([])
    expect(readP0Counter(root)).toEqual(counter)
  })
})

describe('declared P0 order in a queue older than one hour (bounded P0 bypass): counter reads and queue-only fields', () => {
  it('B9d a transient counter read error is retried before it reads as no counter; absence and corruption are not retried', () => {
    const root = temp(); const counter = ensureP0Counter(root)
    let calls = 0
    const flaky = (file: string, encoding: BufferEncoding) => { calls += 1; if (calls === 1) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return readFileSync(file, encoding) }
    expect(readP0Counter(root, flaky), 'a sharing violation that clears is read through').toEqual(counter); expect(calls).toBe(2)
    let missing = 0
    expect(readP0Counter(temp(), (file: string, encoding: BufferEncoding) => { missing += 1; return readFileSync(file, encoding) })).toEqual({ generation: null, grants: 0 }); expect(missing).toBe(1)
    let persistent = 0
    expect(readP0Counter(root, () => { persistent += 1; throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) })).toEqual({ generation: null, grants: 0 })
    expect(persistent, 'a persistent error is retried a bounded number of times').toBeGreaterThan(1)
    writeFileSync(join(root, 'p0-grants'), '{not json')
    let corrupt = 0
    expect(readP0Counter(root, (file: string, encoding: BufferEncoding) => { corrupt += 1; return readFileSync(file, encoding) })).toEqual({ generation: null, grants: 0 }); expect(corrupt).toBe(1)
  })
  it('B9b a queued P1 still acquires when the P0 counter cannot be created, and its queued ticket records no P0 fields', async () => {
    const root = temp(); const holder = await lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P0' }); mkdirSync(join(root, 'p0-grants'))
    const pending = lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P1', waitS: 5, pollMs: 10 })
    try {
      await waitFor(() => records(root).length === 1)
      const ticket = JSON.parse(readFileSync(join(root, 'queue.d', records(root)[0]!), 'utf8'))
      expect(ticket).toMatchObject({ level: 1, levelOrderVersion: 2 }); expect(ticket).not.toHaveProperty('p0GrantsAtQueue'); expect(ticket).not.toHaveProperty('p0GrantsGeneration')
    } finally { lock.releaseSuiteLock(holder) }
    lock.releaseSuiteLock(await pending)
  })
  it('B10 the holder record carries neither the order marker nor the queue-only P0 fields', async () => {
    const root = temp(); const held = await lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P2' })
    try {
      const holder = JSON.parse(readFileSync(join(root, 'lock.d', 'holder.json'), 'utf8'))
      expect(holder).not.toHaveProperty('levelOrderVersion'); expect(holder).not.toHaveProperty('p0GrantsAtQueue'); expect(holder).not.toHaveProperty('p0GrantsGeneration')
      expect(existsSync(join(root, 'p0-grants')), 'a P2 waiter records against the P0 counter, creating it').toBe(true)
    } finally { lock.releaseSuiteLock(held) }
  })
})

describe('unobserved short-holder progress', () => {
  it('C6 renews on counter advancement despite a worse historical place; a hung queue times out', async () => {
    const root = temp(); const ahead = seed(root)
    const notices: string[] = []; let grants = 0
    const pending = lock.acquireSuiteLock({ root, env: envFor(root), waitS: 0.25, staleS: 0.25, pollMs: 70,
      onWait: (line: string) => notices.push(line) }).then((lease: unknown) => { lock.releaseSuiteLock(lease); return 'acquired' }, (error: { code: string }) => error.code)
    await waitFor(() => notices.length > 0)
    const timer = setInterval(() => {
      // Real light admissions complete synchronously between the exclusive waiter's polls.
      if (grants < 6) void lock.acquireSuiteLock({ root, env: envFor(root), light: true, waitS: 0, pollMs: 1 }).then((lease: unknown) => { grants += 1; lock.releaseSuiteLock(lease) })
    }, 50)
    try { await pause(450); removeTicket(join(root, 'queue.d'), ahead); expect(await pending).toBe('acquired'); expect(grants).toBeGreaterThan(4) }
    finally { clearInterval(timer) }
    const holder = await lock.acquireSuiteLock({ root, env: envFor(root) }); seed(root)
    try { await expect(lock.acquireSuiteLock({ root, env: envFor(root), waitS: 0.15, staleS: 0.15, pollMs: 10 })).rejects.toMatchObject({ code: 'WT_SUITE_LOCK_TIMEOUT' }) }
    finally { lock.releaseSuiteLock(holder) }
  }, 10_000)
  it('F2 cancellation churn behind the same hung holder still times out within its budget', async () => {
    const root = temp(); const held = await lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P0' })
    seed(root, { level: 0 }); const now = Date.now(); const renew = vi.fn(); let result = 'waiting'; let endedAt = Infinity
    const controller = new AbortController()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const pending = lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P0', waitS: 0.2, staleS: 0.2, pollMs: 50, signal: controller.signal, onRenew: renew })
      .then((lease: unknown) => { lock.releaseSuiteLock(lease); result = 'acquired' }, (error: { code: string }) => { result = error.code; endedAt = Date.now() - now })
    try {
      await vi.advanceTimersByTimeAsync(0)
      for (let index = 0; index < 40; index += 1) {
        const cancelled = seed(root, { level: 0, light: true })
        await vi.advanceTimersByTimeAsync(50); removeTicket(join(root, 'queue.d'), cancelled)
        await vi.advanceTimersByTimeAsync(50)
      }
      expect(result, 'cancellation churn must not renew a hung-holder watchdog').toBe('WT_SUITE_LOCK_TIMEOUT')
      expect(endedAt).toBeLessThanOrEqual(250); expect(renew).not.toHaveBeenCalled()
    } finally { controller.abort(); vi.useRealTimers(); lock.releaseSuiteLock(held); await pending }
  })
  it('F3 hidden exclusive P0 admissions renew a P2 waiter until it acquires', async () => {
    const root = temp(); const first = await lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P0' }); lock.releaseSuiteLock(first)
    const ahead = seed(root, { level: 2 }); const renew = vi.fn(); const handover = vi.fn(); let result = 'waiting'
    const controller = new AbortController()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const pending = lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P2', waitS: 0.2, staleS: 0.2, pollMs: 50, signal: controller.signal, onRenew: renew, onHandover: handover })
      .then((lease: unknown) => { lock.releaseSuiteLock(lease); result = 'acquired' }, (error: { code: string }) => { result = error.code })
    try {
      await vi.advanceTimersByTimeAsync(0)
      for (let index = 0; index < 8; index += 1) {
        await vi.advanceTimersByTimeAsync(25)
        const hidden = await lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P0', waitS: 0 }); lock.releaseSuiteLock(hidden)
        await vi.advanceTimersByTimeAsync(25)
      }
      removeTicket(join(root, 'queue.d'), ahead); await vi.advanceTimersByTimeAsync(50)
      expect(result, 'hidden exclusive admissions must renew the watchdog until acquisition').toBe('acquired')
      expect(renew.mock.calls.length).toBeGreaterThanOrEqual(4); expect(handover).not.toHaveBeenCalled()
      expect(readLightCounter(root).grants).toBe(0)
    } finally { controller.abort(); vi.useRealTimers(); removeTicket(join(root, 'queue.d'), ahead); await pending }
  })
  it('F3 renews only for increasing admissions under the same valid generation', () => {
    const before = { admissions: { generation: 'same', grants: 2 }, aheadNumbers: [1], counter: { generation: 'light', grants: 0 } }
    const place = { liveNumbers: [], admissions: { generation: 'same', grants: 3 }, counter: { generation: 'light', grants: 9 } }
    expect(suiteQueueAdvanced(before, place)).toBe(true)
    for (const admissions of [{ generation: 'same', grants: 2 }, { generation: 'same', grants: 1 }, { generation: 'other', grants: 9 }, { generation: null, grants: 9 }]) {
      expect(suiteQueueAdvanced(before, { ...place, admissions })).toBe(false)
    }
    expect(suiteQueueAdvanced({ ...before, admissions: { generation: null, grants: 0 } }, place)).toBe(false)
  })
  it.each([{}, { light: true }, { priority: 'release' }])('F3 counts every admission exactly once (%j)', async (options) => {
    const root = temp(); const first = await lock.acquireSuiteLock({ root, env: envFor(root), ...options })
    const counter = readAdmissionCounter(root)
    expect(counter.grants).toBe(1); lock.releaseSuiteLock(first)
    const second = await lock.acquireSuiteLock({ root, env: envFor(root), ...options })
    try { expect(readAdmissionCounter(root)).toEqual({ generation: counter.generation, grants: 2 }) }
    finally { lock.releaseSuiteLock(second) }
  })
  it.each(['admissions', `admissions.${process.pid}.tmp`])('F3 counter write failure at %s does not fail or retry admission', async (file) => {
    const root = temp(); mkdirSync(join(root, file)); const publish = vi.fn()
    const held = await lock.acquireSuiteLock({ root, env: envFor(root), beforePublish: publish })
    try { expect(held.holder.leaseId).toBeTruthy(); expect(publish).toHaveBeenCalledTimes(1); expect(existsSync(join(root, file))).toBe(true) }
    finally { lock.releaseSuiteLock(held) }
  })
})

describe('lane operator release boundary', () => {
  // Each case wraps its argument list in a one-element tuple: a bare array row would be spread into separate callback parameters.
  const releaseArgs: Array<[string[]]> = [[[]], [['--force']], [['--stale-s', '0']]]
  it.each(releaseArgs)('lane release %j refuses before reading or modifying a lock', async (args) => {
    const root = temp(); const held = await lock.acquireSuiteLock({ root, env: envFor(root) })
    const before = readFileSync(join(root, 'lock.d', 'holder.json'), 'utf8')
    try {
      const result = cli(root, ['release', ...args], { WT_SUITE_LOCK_BROKER: join(root, 'missing.sock') })
      expect(result.status, result.stderr).toBe(2)
      expect(result.stderr).toContain('release is not available inside a lane sandbox; the host operator releases the lock')
      expect(readFileSync(join(root, 'lock.d', 'holder.json'), 'utf8')).toBe(before)
    } finally { lock.releaseSuiteLock(held) }
  })
  it('lane release refuses even when its masked lock directory cannot be read', () => {
    const root = temp(); const obstacle = join(root, 'not-directory'); writeFileSync(obstacle, 'untouched')
    const result = cli(root, ['release', '--force'], { WT_SUITE_LOCK_BROKER: join(root, 'missing.sock'), WT_SUITE_LOCK_DIR: obstacle })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('release is not available inside a lane sandbox; the host operator releases the lock')
    expect(result.stderr).not.toContain('ENOTDIR'); expect(readFileSync(obstacle, 'utf8')).toBe('untouched')
  })
})

describe('declaration and isolated environments', () => {
  it('F6 explicit root retains P0 despite an ambient broker and never connects', async () => {
    const root = temp(); const connect = vi.spyOn(net, 'connect')
    const held = await lock.acquireSuiteLock({ root, env: envFor(root, { WT_SUITE_LOCK_BROKER: join(root, 'missing.sock') }), priority: 'P0' })
    try { expect(held.broker).toBeUndefined(); expect(held.holder.level, 'explicit filesystem root must retain P0 despite an ambient broker').toBe(0); expect(connect).not.toHaveBeenCalled() }
    finally { lock.releaseSuiteLock(held) }
  })
  it('C8 accepts lowercase flags and exports the normalized child level', () => {
    const result = cli(temp(), ['run', '--priority', 'p0', '--', process.execPath, '-e', 'process.stdout.write(process.env.WT_SUITE_LOCK_PRIORITY)'])
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('P0')
  })
  it.each(['invalid\n\u001b[31m', 'release'])('C8 invalid env %j warns safely and uses P1', async (value) => {
    const notes: string[] = []; vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { notes.push(String(chunk)); return true })
    const root = temp(); const lease = await lock.acquireSuiteLock({ root, env: envFor(root, { WT_SUITE_LOCK_PRIORITY: value }) })
    try { expect(lease.holder.level).toBe(1); expect(notes).toHaveLength(1); expect(notes[0]!.trim()).not.toMatch(/[\x00-\x1f\x7f-\x9f]/u) }
    finally { lock.releaseSuiteLock(lease) }
  })
  it('C8b explicit option wins over env; invalid flags exit 2; release is not exported', async () => {
    const root = temp(); const lease = await lock.acquireSuiteLock({ root, env: envFor(root, { WT_SUITE_LOCK_PRIORITY: 'P0' }), priority: 'P2' })
    expect(lease.holder.level).toBe(2); lock.releaseSuiteLock(lease)
    expect(cli(root, ['run', '--priority', 'bad', '--', process.execPath, '-e', '']).status).toBe(2)
    const result = cli(root, ['run', '--priority', 'release', '--', process.execPath, '-e', 'process.stdout.write(process.env.WT_SUITE_LOCK_PRIORITY || "unset")'])
    expect(result.status).toBe(0); expect(result.stdout).toBe('unset')
  })
  it.each(['P0', 'invalid'])('C10 default helpers neutralise polluted priority %s and long-hold env', (priority) => {
    vi.stubEnv('WT_SUITE_LOCK_PRIORITY', priority); vi.stubEnv('WT_SUITE_LOCK_LONG_HOLD_S', '0.001')
    vi.stubEnv('WT_SUITE_LOCK_LIGHT_HOLD_S', '0.001')
    const env = envFor(temp())
    expect(env.WT_SUITE_LOCK_PRIORITY).toBeUndefined(); expect(env.WT_SUITE_LOCK_LONG_HOLD_S).toBeUndefined()
    expect(env.WT_SUITE_LOCK_LIGHT_HOLD_S).toBeUndefined()
    expect(sealedPluginCliEnv(temp(), { WT_SUITE_LOCK_PRIORITY: 'P2' }).WT_SUITE_LOCK_PRIORITY).toBe('P2')
  })
})

describe('light class holder warning timer', () => {
  registerLightTimerUnitTests()
  registerLightTimerLockTests()
  registerLightTimerCleanupTests()
  registerDirectLightRunTests()
  registerLightRunLifecycleTests()
  registerLightRunOlderBrokerTests()
})

function registerLightTimerUnitTests() {
  it('light class timer is unrefed, fires once strictly past the bound and sanitises the command', async () => {
    // @ts-expect-error runtime JavaScript under plugin/
    const { watchLightSuiteLease } = await import('../../../../plugin/bin/lib/suite-lock-light-hold.mjs')
    let now = 1000; let callback = () => {}; const unref = vi.fn(); const clear = vi.fn(); const write = vi.fn()
    const timer = { unref }; const schedule = vi.fn((fn: () => void) => { callback = fn; return timer })
    const stop = watchLightSuiteLease({ light: true, argv: ['job\n\u001b\u202e'], startedAt: new Date(now).toISOString() },
      { env: { WT_SUITE_LOCK_LIGHT_HOLD_S: '5' }, now: () => now, setTimer: schedule, clearTimer: clear, write })
    expect(unref).toHaveBeenCalledTimes(1); expect(schedule.mock.calls[0]).toHaveLength(2)
    now = 6000; callback(); expect(write).not.toHaveBeenCalled()
    now = 6001; callback(); now = 9000; callback()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toBe('wt-suite-lock: light lease past its class: held 5.0 s above the 5 s bound (job???); the lock is still held, nobody is pre-empted\n')
    stop(); expect(clear).toHaveBeenCalledWith(timer)
  })
}

function registerLightTimerLockTests() {
  it('light class timer counts from the lease startedAt, not from arming', async () => {
    const { watchLightSuiteLease } = await loadPluginModule('plugin/bin/lib/suite-lock-light-hold.mjs')
    let now = 10_000; let callback = () => {}; const write = vi.fn()
    const schedule = vi.fn((fn: () => void) => { callback = fn; return { unref: vi.fn() } })
    watchLightSuiteLease({ light: true, argv: ['aged'], startedAt: new Date(now - 4000).toISOString() },
      { env: { WT_SUITE_LOCK_LIGHT_HOLD_S: '5' }, now: () => now, setTimer: schedule, clearTimer: vi.fn(), write })
    expect((schedule.mock.calls[0] as unknown[])[1], 'first delay is the bound minus the lease age, plus 1 ms').toBe(1001)
    now = 10_999; callback(); expect(write).not.toHaveBeenCalled()
    now = 11_001; callback(); expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toContain('held 5.0 s')
  })
  it('light class timer survives a stderr whose write throws', async () => {
    const { watchLightSuiteLease } = await loadPluginModule('plugin/bin/lib/suite-lock-light-hold.mjs')
    let now = 1000; let callback = () => {}
    const write = vi.fn(() => { throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) })
    watchLightSuiteLease({ light: true, argv: ['x'], startedAt: new Date(now).toISOString() },
      { env: { WT_SUITE_LOCK_LIGHT_HOLD_S: '1' }, now: () => now, setTimer: (fn: () => void) => { callback = fn; return { unref: vi.fn() } }, clearTimer: vi.fn(), write })
    now = 5000; expect(() => callback()).not.toThrow(); expect(write).toHaveBeenCalledTimes(1)
  })
}

function registerLightTimerCleanupTests() {
  it('light class timer is cleared for a short lease, absent for exclusives and caps long timer delays', async () => {
    // @ts-expect-error runtime JavaScript under plugin/
    const { watchLightSuiteLease } = await import('../../../../plugin/bin/lib/suite-lock-light-hold.mjs')
    vi.useFakeTimers(); const write = vi.fn()
    const stop = watchLightSuiteLease({ light: true, argv: ['short'] }, { env: {}, write })
    expect(vi.getTimerCount()).toBe(1); stop(); expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(700_000); expect(write).not.toHaveBeenCalled()
    watchLightSuiteLease({ light: false, argv: ['exclusive'] }, { env: { WT_SUITE_LOCK_LIGHT_HOLD_S: '0' }, write })()
    expect(vi.getTimerCount()).toBe(0)
    const schedule = vi.fn(() => ({ unref: vi.fn() }))
    watchLightSuiteLease({ light: true, argv: ['long'] }, { env: { WT_SUITE_LOCK_LIGHT_HOLD_S: '3000000' }, setTimer: schedule, clearTimer: vi.fn(), write })()
    expect(schedule.mock.calls[0]).toHaveLength(2)
    expect((schedule.mock.calls[0] as unknown[])[1]).toBe(2_147_483_647)
  })
}

function registerDirectLightRunTests() {
  it.each([true, false])('light class run process warns exactly once while its command still holds the direct lease (light=%s)', async (light) => {
    const root = temp(); const finished = join(root, 'finish')
    const script = `const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finished)})){clearInterval(timer)}},10)`
    const child = spawn(process.execPath, [CLI, 'run', ...(light ? ['--light'] : []), '--', process.execPath, '-e', script],
      { env: envFor(root, { WT_SUITE_LOCK_LIGHT_HOLD_S: '0' }), stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
    let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve))
    try {
      await waitFor(() => light ? stderr.includes('light lease past its class:') : existsSync(join(root, 'lock.d', 'holder.json')))
      expect(lock.readSuiteLock({ root }).held).toBe(true)
    } finally { writeFileSync(finished, 'done') }
    expect(await exit).toBe(0)
    expect(stderr.split('\n').filter((line) => line.startsWith('wt-suite-lock: light lease past its class:'))).toHaveLength(light ? 1 : 0)
    expect(lock.readSuiteLock({ root }).held).toBe(false)
  })
}

function registerLightRunLifecycleTests() {
  it('light class run arms the watcher from the lease start and clears it when the command ends', async () => {
    const root = temp()
    for (const [key, value] of Object.entries({ WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', WT_SUITE_LOCK_LIGHT_HOLD_S: '600' })) vi.stubEnv(key, value)
    const { runSuiteLockCli } = await loadPluginModule('plugin/bin/wt-suite-lock.mjs')
    const armed = vi.spyOn(globalThis, 'setTimeout'); const cleared = vi.spyOn(globalThis, 'clearTimeout')
    const code = await runSuiteLockCli(['run', '--light', '--', process.execPath, '-e', ''])
    expect(code).toBe(0)
    const watchers = armed.mock.calls.flatMap((call, index) => Number(call[1]) > 598_000 && Number(call[1]) <= 600_001 ? [armed.mock.results[index]!.value] : [])
    expect(watchers, `watcher armed near the 600 s bound, saw delays ${JSON.stringify(armed.mock.calls.map((call) => call[1]))}`).toHaveLength(1)
    expect(cleared.mock.calls.map((call) => call[0]), 'the watcher timer is cleared when the command ends').toContain(watchers[0])
    expect(lock.readSuiteLock({ root }).held).toBe(false)
  })
  it('light class run survives a closed stderr and releases the lease only after the command ends', async () => {
    const root = temp(); const done = join(root, 'done')
    const [started, go] = [join(root, 'started'), join(root, 'go')]
    const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'x');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(go)})){clearInterval(t);fs.writeFileSync(${JSON.stringify(done)},'x')}},10)`
    const child = spawn(process.execPath, [CLI, 'run', '--light', '--', process.execPath, '-e', script],
      { env: envFor(root, { WT_SUITE_LOCK_LIGHT_HOLD_S: '0' }), stdio: ['ignore', 'ignore', 'pipe'] }); children.push(child)
    child.stderr!.destroy()
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve))
    // The 1 ms warning timer fires, and its write meets the closed stderr, while the command is still being spawned.
    await waitFor(() => existsSync(started))
    expect(existsSync(done), 'the command is still running').toBe(false)
    expect(lock.readSuiteLock({ root }).held, 'the lease is held while the command runs').toBe(true)
    writeFileSync(go, 'x')
    expect(await exit).toBe(0)
    expect(existsSync(done), 'the run waited for the command').toBe(true)
    expect(lock.readSuiteLock({ root }).held).toBe(false)
  })
}

function registerLightRunOlderBrokerTests() {
  it('light class run behind an older broker is granted exclusive and arms no watcher', async () => {
    const root = temp(); const socket = join(root, 'old-broker.sock'); const requests: Array<Record<string, unknown>> = []
    const server = net.createServer((conn) => {
      conn.on('data', (chunk) => {
        const request = JSON.parse(String(chunk).split('\n')[0]!); requests.push(request)
        if ('light' in request) conn.end('error argv must be an array of strings (only argv and waitS accepted); requested command "unavailable"\n')
        else conn.write('granted old-lease\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    try {
      const script = `setTimeout(()=>{},800)`
      const child = spawn(process.execPath, [CLI, 'run', '--light', '--', process.execPath, '-e', script],
        { env: envFor(root, { WT_SUITE_LOCK_BROKER: socket, WT_SUITE_LOCK_LIGHT_HOLD_S: '0' }), stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
      let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
      expect(await new Promise<number | null>((resolve) => child.once('exit', resolve))).toBe(0)
      expect(requests.map((request) => 'light' in request)).toEqual([true, false])
      expect(stderr).toContain('broker is older')
      expect(stderr, 'an exclusive grant is never reported as an overdue light lease').not.toContain('light lease past its class:')
    } finally { server.close() }
  })
}

describe('light class status snapshot', () => {
  registerLightStatusBoundaryTests()
  registerLightStatusDefaultTests()
})

function registerLightStatusBoundaryTests() {
  it.each([599_999, 600_000, 600_001, 3_600_001])('light class status uses the full-precision holder age %i in text and JSON', async (ageMs) => {
    const root = temp(); const now = Date.parse('2026-01-01T12:00:00Z')
    const held = await lock.acquireSuiteLock({ root, env: envFor(root), light: true,
      startedAt: new Date(now - ageMs).toISOString(), argv: ['unsafe\n\u001b\u202e'] })
    try {
      const snapshot = lock.readSuiteLockStatus({ root, env: envFor(root), now: () => now })
      expect(snapshot).toMatchObject({ ageMs, lightPastClass: ageMs > 600_000, lightHoldBoundS: 600 })
      expect(statusApi.suiteLockStatusJson(snapshot)).toMatchObject({ lightPastClass: ageMs > 600_000, lightHoldBoundS: 600 })
      const text = statusApi.formatSuiteLockStatus(snapshot, lock.formatSuiteLockHolder(snapshot.holder))
      expect(text.includes('light lease past its class:')).toBe(ageMs > 600_000)
      expect(text.includes('long hold:')).toBe(ageMs > 3_600_000)
      if (ageMs > 600_000) {
        const line = text.split('\n').find((value: string) => value.startsWith('light lease past its class:'))!
        expect(line).toContain(`pid ${process.pid}`); expect(line).toContain('held '); expect(line).toContain('unsafe???')
        expect(line).not.toMatch(/[\x00-\x1f\u202e]/u)
      }
      expect(lock.readSuiteLock({ root }).held, 'status is warn-only').toBe(true)
    } finally { lock.releaseSuiteLock(held) }
  })
  it.each([true, false])('light class bound override and zero never flag an exclusive holder (light=%s)', async (light) => {
    const root = temp(); const now = Date.now()
    const held = await lock.acquireSuiteLock({ root, env: envFor(root), light, startedAt: new Date(now - 5001).toISOString() })
    try {
      for (const bound of ['0', '5', '6']) {
        const snapshot = lock.readSuiteLockStatus({ root, env: envFor(root, { WT_SUITE_LOCK_LIGHT_HOLD_S: bound }), now: () => now })
        expect(snapshot).toMatchObject({ lightPastClass: light && Number(bound) < 5.001, lightHoldBoundS: Number(bound) })
        expect(statusApi.formatSuiteLockStatus(snapshot, '').includes('light lease past its class:')).toBe(light && Number(bound) < 5.001)
      }
    } finally { lock.releaseSuiteLock(held) }
  })
}

function registerLightStatusDefaultTests() {
  it('light class status names a dead light holder as stale only, not also past its class', () => {
    const holder = { pid: 4242, light: true, startedAt: '2026-01-01T00:00:00Z', argv: ['job'] }
    const current = { held: true, stale: true, holder, ageMs: 700_000, lightPastClass: true, lightHoldBoundS: 600, longHold: false, queue: [] }
    const text = statusApi.formatSuiteLockStatus(current, 'holder text')
    expect(text).toContain('stale holder')
    expect(text).not.toContain('light lease past its class:')
    expect(statusApi.formatSuiteLockStatus({ ...current, stale: false }, 'holder text')).toContain('light lease past its class:')
  })
  it('light class status leaves free and unknown-age holders unflagged', () => {
    const root = temp()
    expect(lock.readSuiteLockStatus({ root, env: envFor(root) })).toMatchObject({ lightPastClass: false, lightHoldBoundS: 600 })
    mkdirSync(join(root, 'lock.d')); writeFileSync(join(root, 'lock.d', 'holder.json'), JSON.stringify({ light: true, startedAt: 'unknown' }))
    expect(lock.readSuiteLockStatus({ root, env: envFor(root) })).toMatchObject({ ageMs: null, lightPastClass: false })
  })
  it.each(['bad\n\u001b', '-1', 'Infinity', ''])('light class invalid bound %j emits one safe diagnostic and defaults to 600', (value) => {
    const note = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(priorityApi.suiteLockLightHoldSeconds({ WT_SUITE_LOCK_LIGHT_HOLD_S: value })).toBe(600)
    expect(note).toHaveBeenCalledTimes(1)
    expect(String(note.mock.calls[0]![0])).toContain('invalid WT_SUITE_LOCK_LIGHT_HOLD_S')
    expect(String(note.mock.calls[0]![0]).trim()).not.toMatch(/[\x00-\x1f]/u)
  })
}

describe('read-only status snapshot', () => {
  it('F4 malformed holder and ticket argv objects do not invoke JSON-supplied coercion', async () => {
    const root = temp(); const held = await lock.acquireSuiteLock({ root, env: envFor(root) })
    const record = { ...held.holder, argv: [{ toString: 0 }] }
    writeFileSync(join(root, 'lock.d', 'holder.json'), JSON.stringify(record)); takeTicket(join(root, 'queue.d'), record)
    try { expect(cli(root, ['status']).status).toBe(0); expect(cli(root, ['status', '--json']).status).toBe(0) }
    finally { lock.releaseSuiteLock(held) }
  })
  it('F4 text and JSON status bound a 2000-deep holder and ticket record', async () => {
    const root = temp(); const held = await lock.acquireSuiteLock({ root, env: envFor(root) })
    const nested = '{"nested":'.repeat(2000) + '"leaf"' + '}'.repeat(2000)
    const raw = JSON.stringify(held.holder).slice(0, -1) + ',"metadata":' + nested + '}'
    writeFileSync(join(root, 'lock.d', 'holder.json'), raw); takeTicket(join(root, 'queue.d'), JSON.parse(raw))
    try {
      expect(cli(root, ['status']).status, 'text status must complete for a 2000-deep holder').toBe(0)
      const result = cli(root, ['status', '--json'])
      expect(result.status, 'JSON status must complete for a 2000-deep holder').toBe(0)
      const json = JSON.parse(result.stdout)
      expect(json.holder.metadata.nested.nested.nested.nested).toBe('[truncated]')
      expect(result.stdout.length).toBeLessThan(4000); expect(records(root)).toHaveLength(1)
    } finally { lock.releaseSuiteLock(held) }
  })
  it.each([1, true, 'partial'])('F5 primitive %j remains an unknown ticket in text and JSON status', (primitive) => {
    const root = temp(); const number = takeTicket(join(root, 'queue.d'), primitive)
    const file = join(root, 'queue.d', `${String(number).padStart(16, '0')}.json`)
    expect(cli(root, ['status']).stdout).toContain('unknown')
    const result = cli(root, ['status', '--json']); expect(result.status, `status must treat ${JSON.stringify(primitive)} as unknown without throwing`).toBe(0)
    expect(JSON.parse(result.stdout).queue[0]).toMatchObject({ number, pid: null, level: null, waitedMs: null, stale: false })
    expect(readFileSync(file, 'utf8').trim()).toBe(JSON.stringify(primitive))
    expect(orderSuiteLockTickets([{ number, record: primitive }], { generation: null, grants: 0 }, Date.now()).tickets[0].record).toBeNull()
  })
  it.each([1, true, 'partial'])('F5 an acquiring waiter does not throw on primitive %j', async (primitive) => {
    const root = temp(); const number = takeTicket(join(root, 'queue.d'), primitive); const notices: string[] = []
    const pending = lock.acquireSuiteLock({ root, env: envFor(root), waitS: 1, staleS: 1, pollMs: 10, onWait: (line: string) => notices.push(line) })
      .then((lease: unknown) => { lock.releaseSuiteLock(lease); return 'acquired' }, (error: Error) => error.name)
    await waitFor(() => notices.length > 0); removeTicket(join(root, 'queue.d'), number)
    expect(await pending, `acquisition must not throw for primitive ${JSON.stringify(primitive)}`).toBe('acquired')
  })
  it('C9 reports holder age and level, aged service order, stale last, safe argv and queue-time waits', async () => {
    const root = temp(); const now = Date.now()
    const held = await lock.acquireSuiteLock({ root, env: envFor(root), startedAt: new Date(now - 3_840_000).toISOString() })
    const aged = seed(root, { level: 2, startedAt: new Date(now - 3_660_000).toISOString(), argv: ['unsafe\n\u001b\u202e'] })
    seed(root, { level: 0 }); const stale = seed(root, { level: undefined, pid: 2147483647 })
    const before = readFileSync(join(root, 'light-grants'), 'utf8')
    try {
      const snapshot = lock.readSuiteLockStatus({ root, env: envFor(root), now: () => now })
      expect(snapshot).toMatchObject({ ageMs: 3_840_000, level: 1, longHold: true, longHoldBoundS: 3600, order: 'levels' })
      expect(snapshot.queue[0]).toMatchObject({ position: 1, number: aged, level: 2, effectiveLevel: 0, waitedMs: 3_660_000, light: false, release: false, stale: false })
      expect(snapshot.queue[0].argv).not.toMatch(/[\x00-\x1f\u202e]/u)
      expect(snapshot.queue[2]).toMatchObject({ number: stale, stale: true })
      const text = cli(root, ['status']).stdout
      expect(text).toContain('held 1 h 04 min'); expect(text).toContain('P1'); expect(text).toContain('long hold:')
      expect(text).toContain('never pre-empts a holder'); expect(text).toContain(`pid ${process.pid}`)
      expect(text).toContain('declared P2'); expect(text).toContain('stale')
      const json = JSON.parse(cli(root, ['status', '--json']).stdout)
      expect(json.queue).toHaveLength(3); expect(json.order).toBe('levels'); expect(json.ageMs).toBeGreaterThanOrEqual(3_840_000)
      expect(records(root)).toHaveLength(3); expect(readFileSync(join(root, 'light-grants'), 'utf8')).toBe(before)
    } finally { lock.releaseSuiteLock(held) }
  })
  it('C9b names compatible order, unspecified levels, free waiters and invalid bound safely', () => {
    const root = temp(); seed(root, { level: undefined, argv: ['old'] }); seed(root, { level: 0, light: true })
    const text = cli(root, ['status'], { WT_SUITE_LOCK_LONG_HOLD_S: 'bad\n\u001b' })
    expect(text.status).toBe(0); expect(text.stdout).toContain('suite lock free; 2 wait')
    expect(text.stdout).toContain('compatibility order'); expect(text.stdout).toContain('level unspecified')
    expect(text.stderr.trim()).not.toMatch(/[\x00-\x1f]/u)
    const json = JSON.parse(cli(root, ['status', '--json']).stdout)
    expect(json.order).toBe('compatible'); expect(json.queue.map((item: { number: number }) => item.number)).toEqual([2, 1])
    expect(json.queue[1].level).toBeNull(); expect(json.longHoldBoundS).toBe(3600)
  })
  it('C9c unknown numbers stay unknown, heartbeat mtime does not replace startedAt', () => {
    const root = temp(); const number = seed(root, { level: Number.NaN, pid: 'bad\npid', startedAt: 'bad', argv: ['cmd\nforged'] })
    const file = join(root, 'queue.d', `${String(number).padStart(16, '0')}.json`)
    const now = new Date(); utimesSync(file, now, now)
    const snapshot = lock.readSuiteLockStatus({ root, env: envFor(root) })
    expect(snapshot.queue[0]).toMatchObject({ level: null, pid: null, waitedMs: null })
    expect(cli(root, ['status']).stdout).toContain('unknown')
    expect(existsSync(file)).toBe(true)
  })
  it('C9e reads the clock once and does not initialise a missing queue or counter', () => {
    const root = temp(); const now = vi.fn(() => Date.now())
    expect(lock.readSuiteLockStatus({ root, env: envFor(root), now })).toMatchObject({ held: false, queue: [], order: 'levels' })
    expect(now).toHaveBeenCalledTimes(1); expect(readdirSync(root)).toEqual([])
  })
  it('C9f sanitises nested holder fields in JSON and preserves nullable namespace metadata', async () => {
    const root = temp(); const held = await lock.acquireSuiteLock({ root, env: envFor(root) })
    writeFileSync(join(root, 'lock.d', 'holder.json'), JSON.stringify({ ...held.holder, pidNamespace: null,
      metadata: { 'key\u202e': ['unsafe\n\u001b\u202e'] } }))
    try {
      const json = JSON.parse(cli(root, ['status', '--json']).stdout)
      expect(json.holder.metadata['key?']).toEqual(['unsafe???'])
      expect(json.holder.pidNamespace).toBeNull()
    } finally { lock.releaseSuiteLock(held) }
  })
})

describe.skipIf(process.platform === 'win32')('broker host level and protocol compatibility [unix sockets]', () => {
  async function localBroker(extra: Record<string, unknown> = {}) {
    const root = temp(); const address = join(root, 'broker.sock')
    vi.stubEnv('WT_SUITE_LOCK_DIR', root); vi.stubEnv('WT_SUITE_LOCK_BROKER', ''); vi.stubEnv('WT_SUITE_LEASE', '')
    vi.stubEnv('WT_SUITE_LOCK_PRIORITY', 'P2')
    const server = createSuiteLockBroker({ env: envFor(root, { WT_SUITE_LOCK_PRIORITY: 'P2' }), ...extra }) as net.Server & { releaseAll: () => void }
    await new Promise<void>((resolve) => server.listen(address, resolve))
    return { root, address, server }
  }
  async function childResult(root: string, args: string[], broker: string) {
    const child = spawn(process.execPath, [CLI, ...args], { env: envFor(root, { WT_SUITE_LOCK_BROKER: broker }), stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
    let stdout = ''; let stderr = ''
    child.stdout!.on('data', (chunk) => { stdout += String(chunk) }); child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
    const status = await new Promise<number | null>((resolve) => child.once('exit', resolve))
    return { status, stdout, stderr }
  }
  it('F4 broker status completes with bounded 2000-deep holder metadata', async () => {
    const { root, address, server } = await localBroker()
    const held = await lock.acquireSuiteLock({ root, env: envFor(root) })
    const raw = JSON.stringify(held.holder).slice(0, -1) + ',"metadata":' + '{"nested":'.repeat(2000) + '"leaf"' + '}'.repeat(2000) + '}'
    writeFileSync(join(root, 'lock.d', 'holder.json'), raw)
    try {
      const snapshot = await lock.readBrokerSuiteLock(address)
      expect(snapshot.held).toBe(true); expect(snapshot.holder.metadata.nested.nested.nested.nested).toBe('[truncated]')
      expect(JSON.stringify(snapshot).length).toBeLessThan(4000)
    } finally { server.releaseAll(); server.close(); lock.releaseSuiteLock(held) }
  })
  it.for(['preLevels', 'preRelease'] as const)('C4c actual %s broker agrees with a new light waiter', { timeout: 15_000 }, async (role, { skip }) => {
    const archiveRoot = temp(); const base = await baseSuiteLock(archiveRoot, role)
    if (!base.client) { skip(base.unavailable); return }
    const oldBroker = await import(pathToFileURL(join(archiveRoot, 'plugin/bin/lib/host/lane-suite-lock-broker.mjs')).href)
    const root = temp(); const address = join(root, 'old.sock')
    vi.stubEnv('WT_SUITE_LOCK_DIR', root); vi.stubEnv('WT_SUITE_LOCK_BROKER', ''); vi.stubEnv('WT_SUITE_LEASE', '')
    const holder = await lock.acquireSuiteLock({ root, env: envFor(root) })
    const server = oldBroker.createSuiteLockBroker() as net.Server & { releaseAll: () => void }
    await new Promise<void>((resolve) => server.listen(address, resolve))
    const socket = net.connect(address); let text = ''
    socket.on('data', (chunk) => { text += String(chunk) }); socket.write('{"argv":["old-exclusive"],"waitS":5}\n')
    try {
      await waitFor(() => records(root).length === 1)
      const pending = lock.acquireSuiteLock({ root, env: envFor(root), priority: 'P0', light: true, waitS: 5, pollMs: 10 })
      void pending.catch(() => {})
      await waitFor(() => records(root).length === 2); lock.releaseSuiteLock(holder)
      const lease = await pending
      expect(text, 'old broker must still wait while the new light holder is inside').not.toContain('granted ')
      lock.releaseSuiteLock(lease); await waitFor(() => text.includes('granted '))
    } finally { socket.destroy(); server.releaseAll(); server.close(); lock.releaseSuiteLock(holder) }
  })
  it.each([undefined, 'P0'])('C7 host env/option level %s applies and sandbox flag is ignored', async (priority) => {
    const { root, address, server } = await localBroker({ priority })
    try {
      const result = await childResult(root, ['run', '--priority', 'P0', '--', process.execPath, '-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(root, 'lock.d', 'holder.json'))},'utf8'))`], address)
      expect(result.status, result.stderr).toBe(0); expect(result.stderr).toContain("host sets a lane's priority")
      expect(JSON.parse(result.stdout).level).toBe(priority ? 0 : 2)
      expect((await childResult(root, ['run', '--priority', 'release', '--', process.execPath, '-e', ''], address)).status).toBe(2)
      expect(JSON.parse((await childResult(root, ['status', '--json'], address)).stdout)).toMatchObject({ queue: [], order: 'levels', longHoldBoundS: 3600 })
    } finally { server.releaseAll(); server.close() }
  }, 15_000)
  it('C7b never sends a level-related field and refuses injected broker request levels', async () => {
    const root = temp(); const address = join(root, 'mock.sock'); let request: Record<string, unknown> = {}
    const server = net.createServer((socket) => socket.once('data', (chunk) => { request = JSON.parse(String(chunk)); socket.write('granted fixed\n') }))
    await new Promise<void>((resolve) => server.listen(address, resolve))
    try {
      const lease = await lock.acquireSuiteLock({ priority: 'P0', env: envFor(root, { WT_SUITE_LOCK_BROKER: address, WT_SUITE_LOCK_PRIORITY: 'P0' }) })
      lock.releaseSuiteLock(lease); expect(Object.keys(request).sort()).toEqual(['argv', 'waitS'])
    } finally { server.close() }
    const broker = await localBroker()
    try {
      const reply = await new Promise<string>((resolve) => { const socket = net.connect(broker.address); let text = ''; socket.on('data', (chunk) => { text += String(chunk) }); socket.once('end', () => resolve(text)); socket.write(JSON.stringify({ argv: ['x'], waitS: 1, level: 0 }) + '\n') })
      expect(reply).toContain('error argv must be an array')
    } finally { broker.server.releaseAll(); broker.server.close() }
  })
  it('C7c renewal line renews a new watchdog and actual develop ignores the added line', async ({ skip }) => {
    const base = await baseSuiteLock(temp(), 'preLevels')
    if (!base.client) { skip(base.unavailable); return }
    const old = base.client; const root = temp(); const address = join(root, 'renew.sock')
    const server = net.createServer((socket) => socket.once('data', () => {
      socket.write('progress 1 3 1\n')
      const timer = setInterval(() => socket.write('renew 1 3 1\n'), 100)
      const done = setTimeout(() => { clearInterval(timer); socket.write('granted renewed\n') }, 2_350)
      socket.once('close', () => { clearInterval(timer); clearTimeout(done) })
    }))
    await new Promise<void>((resolve) => server.listen(address, resolve))
    try {
      const lease = await lock.acquireSuiteLock({ waitS: 0.1, env: envFor(root, { WT_SUITE_LOCK_BROKER: address }) })
      expect(lease.holder.leaseId).toBe('renewed'); lock.releaseSuiteLock(lease)
      const older = await old.acquireSuiteLock({ waitS: 3, env: envFor(root, { WT_SUITE_LOCK_BROKER: address }) })
      expect(older.holder.leaseId).toBe('renewed'); old.releaseSuiteLock(older)
      await expect(old.acquireSuiteLock({ waitS: 0.1, env: envFor(root, { WT_SUITE_LOCK_BROKER: address }) })).rejects.toMatchObject({ code: 'WT_SUITE_LOCK_TIMEOUT' })
    } finally { server.close() }
  }, 15_000)
  it.each(['text', 'json'])('C9d an older broker status reply explicitly says the queue is unavailable (%s)', async (mode) => {
    const root = temp(); const address = join(root, 'old-status.sock')
    const server = net.createServer((socket) => socket.once('data', () => socket.end('status {"held":false,"holder":null}\n')))
    await new Promise<void>((resolve) => server.listen(address, resolve))
    try {
      const result = await childResult(root, mode === 'json' ? ['status', '--json'] : ['status'], address)
      expect(result.stdout).toContain('queue unavailable from an older broker')
      if (mode === 'json') expect(JSON.parse(result.stdout).queue).toBeNull()
    }
    finally { server.close() }
  })
  it('C7d host broker publishes renewal for admissions it never observes as holders', async () => {
    const { root, address, server } = await localBroker({ priority: 'P1' }); recordAdmissionGrant(root); seed(root)
    let text = ''; const socket = net.connect(address)
    socket.on('data', (chunk) => { text += String(chunk) }); socket.write('{"argv":["waiting"],"waitS":0.4}\n')
    try {
      await waitFor(() => text.includes('progress '))
      for (let index = 0; index < 4; index += 1) {
        const previous = text.length; recordAdmissionGrant(root)
        await waitFor(() => text.slice(previous).includes('renew '))
      }
      expect(readAdmissionCounter(root).grants).toBe(5)
      expect(readLightCounter(root).grants).toBe(0)
    } finally { socket.destroy(); server.releaseAll(); server.close() }
  })
})
