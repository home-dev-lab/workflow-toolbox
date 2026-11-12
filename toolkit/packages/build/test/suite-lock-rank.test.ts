import childProcess, { spawn, spawnSync } from 'node:child_process'
import fs, { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
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
const legacyOrder = await load('suite-lock-legacy-order').catch(() => order)
const toolkit = process.env.WT_RANK_TEST_TOOLKIT ?? resolve(import.meta.dirname, '../../..')
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
const readState = (root: string, projects = ['alpha', 'beta']) => state.readSuiteLockRankState(root, projects.map((project, i) => ticket(i, { project })))
const statePath = (root: string, kind: string, project: string) => join(root, kind, createHash('sha256').update(project).digest('hex').slice(0, 16) + '.json')
const events = (root: string) => readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))

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
  it('CLI exit 75 and spawn failure do not consume a project turn', () => {
    for (const command of [[process.execPath, '-e', 'process.exit(75)'], [join(temp(), 'nonexistent-command')]]) {
      const root = temp(); const result = cli(root, ['run', '--size', 'S', '--project', 'alpha', '--', ...command])
      expect(result.status).not.toBe(0)
      expect(readState(root)).toEqual({ turns: {}, history: {}, precedence: {} })
      expect(events(root).at(-1)).toMatchObject({ served: false })
    }
  })
  it('CLI history records command runtime rather than grant-to-release elapsed time', () => {
    const root = temp()
    const script = `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const spawn=cp.spawn;cp.spawn=function(...args){const child=spawn(...args);const now=Date.now;Date.now=()=>now()+3600000;return child};syncBuiltinESMExports();const {runSuiteLockCli}=await import(${JSON.stringify(pathToFileURL(join(plugin, 'bin/wt-suite-lock.mjs')).href)});process.exitCode=await runSuiteLockCli(['run','--size','S','--project','alpha','--',process.execPath,'-e','setTimeout(()=>{},120)'])`
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: envFor(root), encoding: 'utf8' }).status).toBe(0)
    const history = readState(root).history.alpha
    expect(history.heldMs).toBeGreaterThanOrEqual(120)
    expect(history.heldMs).toBeLessThan(10_000)
    expect(history.overran).toBe(false)
    expect(readState(root).turns.alpha).toBe(1)
  })
}

function registerCompletionCallers() {
  it('release-certify refusal consumes no turn and an executed certification does', async () => {
    const root = temp(); const certifyRoot = join(root, 'toolkit'); mkdirSync(certifyRoot)
    const program = `import {certify} from ${JSON.stringify(pathToFileURL(join(toolkit, 'scripts/release-certify.mjs')).href)};process.exitCode=await certify({root:${JSON.stringify(certifyRoot)},lockRoot:${JSON.stringify(root)},gates:['typecheck'],probe:()=>({load:5,capacity:2,source:'fixture'}),override:process.argv[1]==='run',executeGate:async()=>0})`
    const run = (mode: string) => spawnSync(process.execPath, ['--input-type=module', '-e', program, mode], { env: envFor(root, { WT_SUITE_LOCK_PROJECT: 'alpha', WT_SUITE_LOCK_SIZE: 'S' }), encoding: 'utf8' })
    expect(run('refuse').status).toBe(75)
    expect(readState(root)).toEqual({ turns: {}, history: {}, precedence: {} })
    expect(events(root).at(-1)).toMatchObject({ served: false, exit: 75 })
    expect(run('run').status).toBe(0)
    expect(readState(root).turns).toEqual({ alpha: 1 })
    expect(events(root).at(-1)).toMatchObject({ served: true, exit: 0 })
  })
  it('vitest global setup marks its completed covered run explicitly served', () => {
    const root = temp()
    const program = `import setup from ${JSON.stringify(pathToFileURL(join(toolkit, 'test-support/suite-lease.global-setup.mjs')).href)};await setup({config:{watch:false}})`
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', program], { env: envFor(root, { WT_SUITE_LOCK_PROJECT: 'alpha', WT_SUITE_LOCK_SIZE: 'S' }), encoding: 'utf8' }).status).toBe(0)
    expect(readState(root).turns).toEqual({ alpha: 1 })
    expect(events(root).at(-1)).toMatchObject({ served: true, exit: 0 })
  })
}

function registerExhaustedOrder() {
  it('exhausted exclusives alternate projects while every interleaved light keeps its slot', () => {
    const entries = [ticket(1), ticket(2), ticket(3), ticket(4, { project: 'beta' })]
    const extra = { lightCounter: { ...counter, grants: 8 }, turns: { alpha: 10, beta: 3 } }
    expect(numbers(entries, extra)).toEqual([4, 1, 2, 3])
    for (let index = 0; index <= entries.length; index++) {
      const interleaved = entries.map((entry) => ({ ...entry, number: entry.number * 2 }))
      interleaved.push(ticket(index * 2 + 1, { light: true }))
      const expected = [8, 2, 4, 6]; expected.splice(index, 0, index * 2 + 1)
      expect(numbers(interleaved.reverse(), extra)).toEqual(expected)
    }
  })
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

function registerLegacyDiagnostics() {
  it('mixed snapshots expose legacy order without v3 bonus or tier in every diagnostic', async () => {
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
  it.each([{ served: false }, { lost: true }, { yielded: true }, { served: true, exit: 75 }])('long S history survives an unserved ending %j', async (outcome) => {
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
      mkdirSync(join(root, kind)); writeFileSync(statePath(root, kind, 'old'), JSON.stringify({ project: 'old', turn: 7, size: 'S', heldMs: 12 })); utimesSync(statePath(root, kind, 'old'), stale, stale)
      writeFileSync(statePath(root, kind, 'recent'), JSON.stringify({ project: 'recent', turn: 9, size: 'S', heldMs: 20 }))
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
  it('broker measures S duration on the host, never from the sandboxed client report', async () => {
    const root = temp(); let clock: ReturnType<typeof vi.spyOn> | undefined
    try {
      const exit = await brokerRun(root, [process.execPath, '-e', 'setTimeout(()=>process.exit(0),300)'], 5, () => {
        const started = Date.parse(JSON.parse(readFileSync(join(root, 'lock.d/holder.json'), 'utf8')).startedAt)
        clock = vi.spyOn(Date, 'now').mockReturnValue(started + 600_001)
      })
      expect(exit).toBe(0)
      expect(readState(root)).toMatchObject({ turns: { alpha: 1 }, history: { alpha: { size: 'S', heldMs: 600_001, overran: true } } })
    } finally { clock?.mockRestore() }
  })
  it('broker hold-limit loss records a long S overrun without serving a turn', async () => {
    const root = temp(); let clock: ReturnType<typeof vi.spyOn> | undefined
    try {
      const exit = await brokerRun(root, [process.execPath, '-e', 'setInterval(()=>{},1000)'], 0.3, () => {
        const started = Date.parse(JSON.parse(readFileSync(join(root, 'lock.d/holder.json'), 'utf8')).startedAt)
        clock = vi.spyOn(Date, 'now').mockReturnValue(started + 600_001)
      })
      expect(exit).toBe(75)
      expect(readState(root)).toMatchObject({ turns: {}, history: { alpha: { size: 'S', heldMs: 600_001, overran: true } } })
      expect(events(root).at(-1)).toMatchObject({ served: false, lost: true, heldMs: 600_001 })
    } finally { clock?.mockRestore() }
  })
}

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
  it('writes turns and duration only at served exclusive release before removing mutex', async () => {
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
  it.each([{ exit: 75 }, { exit: 0, served: false }, { lost: true }, { exit: 0, yielded: true }])('does not stamp an unserved lease %j', async (outcome) => {
    const root = temp(); const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', size: 'S' })
    lock.releaseSuiteLock(lease, outcome)
    expect(readState(root).turns).toEqual({})
  })
  it.each([{ light: true }, { static: true }])('does not write rank state for %j', async (options) => {
    const root = temp(); const lease = await lock.acquireSuiteLock({ root, env: envFor(root, { WT_SUITE_LOCK_STATIC_LANE: '1' }), project: 'alpha', size: 'S', ...options })
    if (options.static) expect(lease.staticDomain).toBe(true)
    lock.releaseSuiteLock(lease, { served: true, heldMs: 700_000 })
    expect(readdirSync(root).filter((name) => ['turn-seq', 'project-turns', 'size-history', 'precedence'].includes(name))).toEqual([])
    expect(existsSync(join(root, 'static-lane', 'project-turns'))).toBe(false)
    expect(existsSync(join(root, 'static-lane', 'size-history'))).toBe(false)
  })
  it('release priority consumes no project turn but any exclusive S overrun is recorded', async () => {
    const root = temp(); const lease = await lock.acquireSuiteLock({ root, env: envFor(root), project: 'alpha', size: 'S', priority: 'release' })
    lock.releaseSuiteLock(lease, { served: true, heldMs: 600_001 })
    expect(readState(root)).toMatchObject({ turns: {}, history: { alpha: { size: 'S', heldMs: 600_001, overran: true } } })
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
    expect(readState(root).precedence.alpha.until).toBe(null)
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
