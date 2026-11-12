import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
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
const legacyOrder = await load('suite-lock-legacy-order').catch(() => order)
const roots: string[] = []
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'suite-rank-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const now = Date.parse('2026-01-01T12:00:00Z')
const counter = { generation: 'light', grants: 0 }
const context = (extra = {}) => ({ lightCounter: counter, now, turns: {}, history: {}, precedence: {}, ...extra })
const ticket = (number: number, fields = {}) => ({ number, record: { level: 2, levelOrderVersion: 3,
  project: 'alpha', size: 'L', startedAt: new Date(now).toISOString(), lightGrantsAtQueue: 0,
  lightGrantsGeneration: 'light', ...fields } })
const rank = (entry: ReturnType<typeof ticket>, extra = {}) => order.rankSuiteLockTicket(entry, context(extra))
const numbers = (tickets: ReturnType<typeof ticket>[], extra = {}) => order.orderSuiteLockTickets(tickets, counter, now, undefined, context(extra)).tickets.map((t: { number: number }) => t.number)
const envFor = (root: string, extra = {}) => sealedPluginCliEnv(root, { WT_SUITE_LOCK_DIR: root, WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', WT_SUITE_LOCK_PROJECT: '', WT_SUITE_LOCK_SIZE: '', ...extra })
const cli = (root: string, args: string[], extra = {}) => spawnSync(process.execPath, [join(plugin, 'bin/wt-suite-lock.mjs'), ...args], { env: envFor(root, extra), encoding: 'utf8', timeout: 15_000 })

it('malformed order-version markers keep legacy ordering', () => {
  expect(order.orderSuiteLockTickets([ticket(1, { levelOrderVersion: '3' })], counter, now).levelOrder, 'malformed version marker retains exact legacy mode').toBe('legacy')
})

describe('one queue ranking policy', () => {
  registerRankPriority()
  registerRankProjects()
  registerRankDiagnostics()
})

function registerRankPriority() {
  it('row 1 removes level aging from v3', () => {
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
    expect(events.find((event) => event.event === 'release')).toMatchObject({ served: true, heldMs: expect.any(Number) })
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
  it('retains exactly the develop key when even one v2 ticket is live', () => {
    const tickets = [ticket(1, { levelOrderVersion: 2, startedAt: new Date(now - 3 * 3600_000).toISOString() }), ticket(2, { level: 0 })]
    const old = legacyOrder.orderSuiteLockTickets(tickets, counter, now)
    const mixed = order.orderSuiteLockTickets(tickets, counter, now)
    expect(mixed.tickets.map((t: { key: number[] }) => t.key)).toEqual(old.tickets.map((t: { key: number[] }) => t.key))
    expect(Number(old.tickets[0].number === 1) + Number(mixed.tickets[0].number === 2), 'exactly one client elects itself first').toBe(1)
    expect(mixed.levelOrder).toBe('bounded-p0')
    expect(mixed.tickets[0].reason.line).toContain('bonus inactive in legacy order')
  })
  it('proves P0 floor inert without aging over every level and counter class', async () => {
    const source = readFileSync(join(plugin, 'bin/lib/suite-lock-legacy-order.mjs'), 'utf8').replace('const LEVEL_AGING_STEP_MS = 30 * 60 * 1000', 'const LEVEL_AGING_STEP_MS = Infinity')
    const noAging = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
    let cases = 0
    for (const level of [0, 1, 2]) for (const grants of [0, 7, 8, 15, 16, 17]) for (const generation of ['p0', 'lost', null]) for (const queued of [undefined, -1, 0, 5, 20]) for (const lightGrants of [0, 7, 8]) for (const lightGeneration of ['light', 'lost']) {
      const record = { ...ticket(1).record, level, levelOrderVersion: 2, startedAt: new Date(now - 3 * 3600_000).toISOString(), p0GrantsAtQueue: queued, p0GrantsGeneration: generation }
      const lightCounter = { generation: lightGeneration, grants: lightGrants }
      const legacy = noAging.orderSuiteLockTickets([{ number: 1, record }], lightCounter, now, { generation: 'p0', grants }).tickets[0].effectiveLevel
      expect(rank(ticket(1, record), { lightCounter }).key[1]).toBe(legacy); cases += 1
    }
    expect(cases).toBe(1620)
  })
}

function registerServiceHistory() {
  it('writes turns and duration only at served exclusive release before removing mutex', async () => {
    const root = temp(); const env = envFor(root)
    const lease = await lock.acquireSuiteLock({ root, env, project: 'alpha', size: 'S' })
    expect(state.readSuiteLockRankState(root).turns).toEqual({})
    lock.releaseSuiteLock(lease, { exit: 0, heldMs: 600_001 })
    expect(state.readSuiteLockRankState(root)).toMatchObject({ turns: { alpha: 1 }, history: { alpha: { overran: true, heldMs: 600_001 } } })
    const next = await lock.acquireSuiteLock({ root, env, project: 'alpha', size: 'S' })
    lock.releaseSuiteLock(next, { exit: 0, heldMs: 20 })
    expect(state.readSuiteLockRankState(root)).toMatchObject({ turns: { alpha: 2 }, history: { alpha: { overran: false } } })
  })
}

function registerServiceExclusions() {
  it.each([{ exit: 75 }, { exit: 0, served: false }, { lost: true }, { exit: 0, yielded: true }])('does not stamp an unserved lease %j', async (outcome) => {
    const root = temp(); const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', size: 'S' })
    lock.releaseSuiteLock(lease, outcome)
    expect(state.readSuiteLockRankState(root).turns).toEqual({})
  })
  it.each([{ light: true }, { priority: 'release' }, { static: true }])('does not write rank state for %j', async (options) => {
    const root = temp(); const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', size: 'S', ...options })
    lock.releaseSuiteLock(lease)
    expect(readdirSync(root).filter((name) => ['turn-seq', 'project-turns', 'size-history', 'precedence'].includes(name))).toEqual([])
    if (lease.staticDomain) expect(readdirSync(join(root, 'static-lane')).filter((name) => ['turn-seq', 'project-turns', 'size-history', 'precedence'].includes(name))).toEqual([])
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
    expect(state.readSuiteLockRankState(root).turns).toEqual({})
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
      const child = spawn(process.execPath, [join(plugin, 'bin/wt-suite-lock.mjs'), 'precedence', 'set', '--project', project, '--until', '2027-01-01T00:00:00Z', '--source', 'operator'], { env: envFor(root), stdio: 'ignore' })
      child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`precedence set exit ${code}`)))
    })))
    expect(JSON.parse(cli(root, ['precedence', 'list']).stdout).map((entry: { project: string }) => entry.project)).toEqual(['alpha', 'beta'])
    expect(cli(root, ['precedence', 'clear', '--project', 'alpha']).status).toBe(0)
    expect(state.readSuiteLockRankState(root).precedence.alpha.until).toBe(null)
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
