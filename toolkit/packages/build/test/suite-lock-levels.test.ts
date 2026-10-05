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
import { ensureLightCounter, readAdmissionCounter, readLightCounter, recordAdmissionGrant, removeTicket, takeTicket } from '../../../../plugin/bin/lib/host/suite-lock-queue.mjs'
// @ts-expect-error runtime JavaScript under plugin/
import { orderSuiteLockTickets } from '../../../../plugin/bin/lib/suite-lock-order.mjs'
// @ts-expect-error runtime JavaScript under plugin/
import { suiteQueueAdvanced } from '../../../../plugin/bin/lib/suite-lock-progress.mjs'
// @ts-expect-error runtime JavaScript under plugin/
import { currentPidNamespace } from '../../../../plugin/bin/lib/host/pid-namespace.mjs'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

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
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 15_000
  while (!check()) { if (Date.now() > deadline) throw new Error('fixture deadline'); await pause(10) }
}
function cli(root: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env: envFor(root, extra), encoding: 'utf8', timeout: 15_000 })
}
async function archived(root: string, ref = 'b9118d49') {
  const archive = spawnSync('git', ['archive', ref, 'plugin/bin/lib'], { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 })
  expect(archive.status, String(archive.stderr)).toBe(0)
  expect(spawnSync('tar', ['-x', '-C', root], { input: archive.stdout }).status).toBe(0)
  mkdirSync(join(root, 'plugin/.claude-plugin'))
  writeFileSync(join(root, 'plugin/.claude-plugin/plugin.json'), readFileSync(join(ROOT, 'plugin/.claude-plugin/plugin.json')))
  return import(pathToFileURL(join(root, 'plugin/bin/lib/suite-lock.mjs')).href)
}
async function service(root: string, specs: Array<{ name: string; priority?: string; light?: boolean; api?: typeof lock }>) {
  const holder = await lock.acquireSuiteLock({ root, env: envFor(root) })
  const order: string[] = []; const levels: Array<number | undefined> = []; let inside = 0; let peak = 0
  const all: Promise<void>[] = []
  const abort = new AbortController()
  try {
    for (const spec of specs) {
      const api = spec.api ?? lock
      const promise = api.acquireSuiteLock({ root, env: envFor(root, { WT_SUITE_LOCK_PRIORITY: spec.priority }),
        ...(spec.priority === 'release' ? { priority: 'release' } : {}), light: spec.light, argv: [spec.name],
        waitS: 5, staleS: 5, pollMs: 10, signal: abort.signal,
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
  it.each([0, 1, 2])('F1 a P%i exclusive becomes unpassable after one aging step', () => {
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
  it('C4 actual develop exclusive and new light P0 both acquire, with develop light ordering', async () => {
    const old = await archived(temp()); const root = temp()
    const result = await service(root, [{ name: 'old-E', api: old }, { name: 'new-L', priority: 'P0', light: true }])
    expect(result.order).toEqual(['new-L', 'old-E'])
    expect(result.peak).toBe(1)
  })
  it('C4b an old ticket preserves exact develop order in a mixed queue', async () => {
    const old = await archived(temp())
    const result = await service(temp(), [{ name: 'P0', priority: 'P0' }, { name: 'old', api: old }, { name: 'P2-L', priority: 'P2', light: true }, { name: 'R', priority: 'release' }])
    expect(result.order).toEqual(['R', 'P2-L', 'P0', 'old'])
  })
  it('C5 mixed levels, light, release and actual older clients all acquire singly', async () => {
    const old = await archived(temp(), '95b4150b')
    const result = await service(temp(), [{ name: 'P2', priority: 'P2' }, { name: 'P1-L', priority: 'P1', light: true }, { name: 'P0', priority: 'P0' }, { name: 'R', priority: 'release' }, { name: 'old', api: old }])
    expect(result.peak).toBe(1)
    expect(result.order.slice().sort()).toEqual(['P0', 'P1-L', 'P2', 'R', 'old'].sort())
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
    const env = envFor(temp())
    expect(env.WT_SUITE_LOCK_PRIORITY).toBeUndefined(); expect(env.WT_SUITE_LOCK_LONG_HOLD_S).toBeUndefined()
    expect(sealedPluginCliEnv(temp(), { WT_SUITE_LOCK_PRIORITY: 'P2' }).WT_SUITE_LOCK_PRIORITY).toBe('P2')
  })
})

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
  it.each(['b9118d49', '95b4150b'])('C4c actual %s broker agrees with a new light waiter', async (ref) => {
    const archiveRoot = temp(); await archived(archiveRoot, ref)
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
  }, 15_000)
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
  it('C7c renewal line renews a new watchdog and actual develop ignores the added line', async () => {
    const old = await archived(temp()); const root = temp(); const address = join(root, 'renew.sock')
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
