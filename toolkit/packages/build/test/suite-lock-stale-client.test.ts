import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import net from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error Shared executable regression has no TypeScript declarations.
import { assertCurrencyRefusal, assertCurrencyQualityParity, assertResolverParity } from './helpers/suite-lock-currency.selftest.mjs'
// @ts-expect-error Shared executable regression has no TypeScript declarations.
import { assertAcquisitionProjectCurrency } from './helpers/suite-lock-currency-fixes.selftest.mjs'
// @ts-expect-error Host JavaScript has no TypeScript declarations.
import { acquireSuiteLock, releaseSuiteLock } from '../../../../plugin/bin/lib/suite-lock.mjs'
// @ts-expect-error Host JavaScript has no TypeScript declarations.
import { currentPidNamespace, processStartTime } from '../../../../plugin/bin/lib/host/pid-namespace.mjs'
// @ts-expect-error Host JavaScript has no TypeScript declarations.
import { orderSuiteLockTickets } from '../../../../plugin/bin/lib/suite-lock-order.mjs'

const PLUGIN = process.env.WT_CURRENCY_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL('../../../../plugin', import.meta.url))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-client-currency-')))
  roots.push(root)
  const config = join(root, 'config'), project = join(root, 'project'), lock = join(root, 'locks')
  mkdirSync(project)
  const cache = join(config, 'plugins/cache/workflow-toolbox/workflow-toolbox')
  const old = join(cache, '0.0.1'), current = join(cache, '0.0.2')
  for (const [target, version] of [[old, '0.0.1'], [current, '0.0.2']] as const) {
    cpSync(join(PLUGIN, 'bin'), join(target, 'bin'), { recursive: true })
    mkdirSync(join(target, '.claude-plugin'))
    writeFileSync(join(target, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'workflow-toolbox', version }))
  }
  const order = join(old, 'bin/lib/suite-lock-order.mjs')
  writeFileSync(order, readFileSync(order, 'utf8').replace('SUITE_LOCK_ORDER_VERSION = 4', 'SUITE_LOCK_ORDER_VERSION = 3'))
  const registry = (entries: object[]) => writeFileSync(join(config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'workflow-toolbox@workflow-toolbox': entries } }))
  registry([{ scope: 'user', installPath: current, version: '0.0.2' }])
  const env = sealedPluginCliEnv(root, { CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project, WT_SUITE_LOCK_DIR: lock,
    WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', WT_SUITE_LOCK: undefined, WT_SUITE_LOCK_STATIC_LANE: undefined,
    WT_PLUGIN_ROOT: undefined, CLAUDE_PLUGIN_ROOT: undefined, NODE_OPTIONS: undefined })
  const cli = join(old, 'bin/wt-suite-lock.mjs'), marker = join(root, 'child-marker')
  const script = join(root, 'child.mjs')
  writeFileSync(script, 'import fs from "node:fs"; fs.writeFileSync(process.argv[2], "ran")')
  const child = [process.execPath, script, marker]
  const run = (args = ['run', '--light', '--', ...child], extra: NodeJS.ProcessEnv = {}, entry = cli) =>
    spawnSync(process.execPath, [entry, ...args], { env: { ...env, ...extra }, cwd: project, encoding: 'utf8', timeout: 20_000 })
  return { root, config, project, lock, old, current, registry, env, cli, marker, child, run }
}

it('refuses an older cached writer before publication and prints an executable replacement with identical arguments', () => {
  assertCurrencyRefusal(PLUGIN)
})

it('T2 uses explicit acquisition cwd ahead of the service cwd and project environment', () => {
  assertAcquisitionProjectCurrency(PLUGIN)
})

it('T1 probes once for consecutive same-process enqueues and again after a registry edit', () => {
  assertAcquisitionProjectCurrency(PLUGIN, 'memo')
})

it.skipIf(process.platform === 'win32')('T2 uses the broker project root ahead of its service cwd and environment', () => {
  assertAcquisitionProjectCurrency(PLUGIN, 'broker')
})

it.skipIf(process.platform === 'win32')('T2 falls back to the project environment when no broker root was supplied', () => {
  assertAcquisitionProjectCurrency(PLUGIN, 'broker-env')
})

it.each(['mutation-cli', 'mutation-order', 'mutation-admission'])('R1 refreshes cached currency after %s on disk', (scenario) => {
  assertAcquisitionProjectCurrency(PLUGIN, scenario)
})

it.skipIf(process.platform === 'win32')('R2 refuses a CLI-shaped null-root broker using the project environment', () => {
  assertAcquisitionProjectCurrency(PLUGIN, 'broker-null')
})

it.skipIf(process.platform === 'win32')('R3 selects by broker root while preserving the service cwd in its ticket', () => {
  assertAcquisitionProjectCurrency(PLUGIN, 'broker-ticket')
})

it('preserves resolver outputs, errors, property reads and outgoing call order against the frozen base', () => {
  expect(assertResolverParity(PLUGIN)).toBeGreaterThan(30)
})

it('preserves quality-cleanup outputs, errors, metadata writes and traversal/read order', () => {
  expect(assertCurrencyQualityParity(PLUGIN)).toBe(304)
})

it.each(['status', 'journal', 'precedence', 'release'])('does not judge non-enqueueing %s', (verb) => {
  const f = fixture()
  const args = verb === 'precedence' ? [verb, 'list'] : [verb]
  const result = f.run(args)
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).not.toContain('REFUSED stale-client:')
})

it('bypasses stale-client admission with WT_SUITE_LOCK=0', () => {
  const f = fixture(), result = f.run(undefined, { WT_SUITE_LOCK: '0' })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(f.marker)).toBe(true)
  expect(existsSync(f.lock)).toBe(false)
})

it('inherits a valid main lease before stale-client admission', () => {
  const f = fixture()
  mkdirSync(join(f.lock, 'lock.d'), { recursive: true })
  writeFileSync(join(f.lock, 'lock.d/holder.json'), JSON.stringify({ leaseId: 'ancestor' }))
  const result = f.run(undefined, { WT_SUITE_LEASE: `${f.lock}|ancestor` })
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(f.marker)).toBe(true)
  expect(existsSync(join(f.lock, 'queue.d'))).toBe(false)
})

it('never refuses an explicitly static ticket', () => {
  const f = fixture(), result = f.run(['run', '--static', '--', ...f.child])
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(join(f.lock, 'static-lane/queue.d'))).toBe(true)
})

it('routes automatic static lint before judging currency and refuses when the static lane is disabled', () => {
  const f = fixture(), args = ['run', '--', 'pnpm', 'lint']
  const staticResult = f.run(args)
  expect(staticResult.status, staticResult.stderr).not.toBe(78)
  expect(existsSync(join(f.lock, 'static-lane/queue.d'))).toBe(true)
  const mainResult = f.run(args, { WT_SUITE_LOCK_STATIC_LANE: '0' })
  expect(mainResult.status, mainResult.stderr).toBe(78)
  expect(existsSync(join(f.lock, 'queue.d'))).toBe(false)
})

it('release priority still judges the main writer when static was requested', () => {
  const f = fixture(), result = f.run(['run', '--static', '--priority', 'release', '--', ...f.child])
  expect(result.status, result.stderr).toBe(78)
  expect(existsSync(f.lock)).toBe(false)
})

it('ignores unlisted cache copies and lets project scope override a newer user entry', () => {
  const f = fixture()
  f.registry([{ scope: 'user', installPath: f.old, version: '0.0.1' }])
  expect(f.run().status).toBe(0)
  f.registry([{ scope: 'user', installPath: f.current, version: '0.0.2' },
    { scope: 'project', projectPath: f.project, installPath: f.old, version: '0.0.1' }])
  expect(f.run().status).toBe(0)
})

it('resolves only the applicable project and exact marketplace identity, ignoring root overrides', () => {
  const f = fixture(), other = join(f.root, 'other-project')
  mkdirSync(other)
  f.registry([{ scope: 'local', projectPath: other, installPath: f.old, version: '0.0.1' },
    { scope: 'project', projectPath: f.project, installPath: f.current, version: '0.0.2' }])
  expect(f.run(undefined, { WT_PLUGIN_ROOT: f.old, CLAUDE_PLUGIN_ROOT: f.old }).status).toBe(78)
  expect(f.run(undefined, { CLAUDE_PROJECT_DIR: other }).status).toBe(0)
  writeFileSync(join(f.config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: {
    'workflow-toolbox@other-marketplace': [{ scope: 'user', installPath: f.current, version: '0.0.2' }],
  } }))
  expect(f.run().status).toBe(0)
})

it('fails open when an unreadable project scope makes the effective entry ambiguous', () => {
  const f = fixture()
  f.registry([{ scope: 'user', installPath: f.current, version: '0.0.2' },
    { scope: 'project', projectPath: join(f.root, 'missing-project'), installPath: f.old, version: '0.0.1' }])
  const result = f.run()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).not.toContain('REFUSED stale-client:')
})

it('compares imported order values rather than release versions or constant text', () => {
  const f = fixture(), order = join(f.current, 'bin/lib/suite-lock-order.mjs'), source = readFileSync(order, 'utf8')
  writeFileSync(order, source.replace('SUITE_LOCK_ORDER_VERSION = 4', "SUITE_LOCK_ORDER_VERSION = Number('3')"))
  expect(f.run().status).toBe(0)
  writeFileSync(order, source.replace('SUITE_LOCK_ORDER_VERSION = 4', "SUITE_LOCK_ORDER_VERSION = Number('4')"))
  expect(f.run().status).toBe(78)
})

it('treats the invoking namespace without a current-version export as order zero', () => {
  const f = fixture(), order = join(f.old, 'bin/lib/suite-lock-order.mjs')
  writeFileSync(order, readFileSync(order, 'utf8').replace('export const SUITE_LOCK_ORDER_VERSION = 3', 'const SUITE_LOCK_ORDER_VERSION = 3'))
  const result = f.run()
  expect(result.status, result.stderr).toBe(78)
  expect(result.stderr).toContain('client 0.0.1 (order 0)')
})

it.each(['missing registry', 'invalid registry', 'manifest mismatch', 'missing import', 'missing lazy import', 'empty lock module', 'invalid order'])('fails open for %s with at most one currency warning', (damage) => {
  const f = fixture()
  if (damage === 'missing registry') rmSync(join(f.config, 'plugins/installed_plugins.json'))
  if (damage === 'invalid registry') writeFileSync(join(f.config, 'plugins/installed_plugins.json'), '{')
  if (damage === 'manifest mismatch') writeFileSync(join(f.current, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'workflow-toolbox', version: 'wrong' }))
  if (damage === 'missing import') rmSync(join(f.current, 'bin/lib/suite-lock-cli-options.mjs'))
  if (damage === 'missing lazy import') {
    const file = join(f.current, 'bin/lib/suite-lock-order.mjs')
    writeFileSync(file, readFileSync(file, 'utf8') + "\nexport const later = () => import('./currency-missing.mjs')\n")
  }
  if (damage === 'empty lock module') writeFileSync(join(f.current, 'bin/lib/suite-lock.mjs'), '')
  if (damage === 'invalid order') {
    const file = join(f.current, 'bin/lib/suite-lock-order.mjs')
    writeFileSync(file, readFileSync(file, 'utf8').replace('SUITE_LOCK_ORDER_VERSION = 4', 'SUITE_LOCK_ORDER_VERSION = 4.5'))
  }
  const result = f.run()
  expect(result.status, result.stderr).toBe(0)
  expect(existsSync(f.marker)).toBe(true)
  const warnings = result.stderr.split('\n').filter((line) => line.includes('client currency unknown'))
  expect(warnings.length).toBeLessThanOrEqual(1)
  if (!damage.includes('registry')) expect(warnings).toHaveLength(1)
})

it('fails open after the bounded loadability probe even when the target ignores TERM', () => {
  const f = fixture(), cli = join(f.current, 'bin/wt-suite-lock.mjs')
  writeFileSync(cli, readFileSync(cli, 'utf8') + '\nprocess.on("SIGTERM", () => {}); await new Promise(() => setInterval(() => {}, 1000))\n')
  const result = f.run()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toContain('not loadable (5 s probe)')
  expect(existsSync(f.marker)).toBe(true)
})

it('preserves the runner entry and its original argument form in the replacement command', () => {
  const f = fixture(), entry = join(f.old, 'bin/wt-suite-lock-run.mjs')
  const result = f.run(['--light', '--', ...f.child], {}, entry)
  expect(result.status, result.stderr).toBe(78)
  expect(result.stderr).toContain(join(f.current, 'bin/wt-suite-lock-run.mjs'))
  expect(result.stderr).not.toContain('Usage:')
  expect(result.stderr).toContain(process.platform === 'win32' ? '"--light" "--"' : "'--light' '--'")
})

it.each(['missing', 'syntax'])('fails open when the replacement runner is %s', (damage) => {
  const f = fixture(), runner = join(f.current, 'bin/wt-suite-lock-run.mjs')
  if (damage === 'missing') rmSync(runner)
  else writeFileSync(runner, 'syntax error {{{')
  const result = f.run(f.child, {}, join(f.old, 'bin/wt-suite-lock-run.mjs'))
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toContain('client currency unknown')
})

it('checks replacement runner syntax without executing its top-level main', () => {
  const f = fixture(), probeMarker = join(f.root, 'runner-executed')
  writeFileSync(join(f.current, 'bin/wt-suite-lock-run.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(probeMarker)}, 'unexpected')`)
  const result = f.run(f.child, {}, join(f.old, 'bin/wt-suite-lock-run.mjs'))
  expect(result.status, result.stderr).toBe(78)
  expect(existsSync(probeMarker)).toBe(false)
})

it('propagates the covered command exit 78 without a stale-client marker', () => {
  const f = fixture(), result = f.run(['run', '--light', '--', process.execPath, '-e', 'process.exit(78)'], {}, join(f.current, 'bin/wt-suite-lock.mjs'))
  expect(result.status).toBe(78)
  expect(result.stderr).not.toContain('REFUSED stale-client:')
})

it('names the replacement root rather than fabricating a command for a library writer', () => {
  const f = fixture(), url = pathToFileURL(join(f.old, 'bin/lib/suite-lock.mjs')).href
  const script = `const { acquireSuiteLock } = await import(${JSON.stringify(url)}); try { await acquireSuiteLock({ light: true }) } catch (error) { process.stdout.write(JSON.stringify({ code: error.code, exit: error.exitCode, message: error.message })) }`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: f.env, cwd: f.project, encoding: 'utf8', timeout: 20_000 })
  expect(result.status, result.stderr).toBe(0)
  const error = JSON.parse(result.stdout) as { code: string; exit: number; message: string }
  expect(error).toMatchObject({ code: 'WT_SUITE_LOCK_STALE_CLIENT', exit: 78 })
  expect(error.message).toContain(`restart this process from ${f.current}`)
  expect(error.message).not.toContain('Replacement command:')
  expect(existsSync(f.lock)).toBe(false)
})

function privatePark(f: ReturnType<typeof fixture>) {
  const directory = join(f.root, 'private')
  mkdirSync(directory, { mode: 0o700 })
  const key = 'fixture-park-key-longer-than-thirty-two-bytes'
  writeFileSync(join(directory, 'key'), key, { mode: 0o600 })
  const owner = { pid: process.pid, startTime: processStartTime(process.pid), pidNamespace: currentPidNamespace() }
  return { directory, keyHash: createHash('sha256').update(key).digest('hex'), owner, windowMs: 60_000 }
}

it('finishes a refused park attempt as not-parked without publishing a ticket', () => {
  const f = fixture(), park = privatePark(f)
  const flags = ['--park-dir', park.directory, '--park-s', '60', '--park-owner-pid', String(process.pid)]
  const result = f.run(['run', ...flags, '--', ...f.child])
  expect(result.status, result.stderr).toBe(78)
  expect(readFileSync(join(park.directory, 'outcome'), 'utf8')).toBe('not-parked\n')
  expect(existsSync(f.lock)).toBe(false)
})

it.each([false, true])('upgrades a resumed v2 park to v4 and preserves priority/class (saved metadata: %s)', async (savedMetadata) => {
  const f = fixture(), park = privatePark(f)
  const args = ['run', '--priority', 'P2', '--park-dir', park.directory, '--park-s', '60', '--park-owner-pid', String(process.pid), '--', process.execPath, '-e', 'require("node:fs").writeFileSync(process.env.WT_SUITE_LOCK_PARK_REQUEST,"yield")']
  const parked = f.run(args, {}, join(f.current, 'bin/wt-suite-lock.mjs'))
  expect(parked.status, parked.stderr).toBe(0)
  const named = JSON.parse(readFileSync(join(park.directory, 'parked.json'), 'utf8')) as { number: number }
  const file = join(f.lock, 'queue.d', `${String(named.number).padStart(16, '0')}.parked`)
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { record: Record<string, unknown> }
  saved.record.levelOrderVersion = 2
  if (savedMetadata) { saved.record.project = 'saved'; saved.record.size = 'L' }
  else { delete saved.record.project; delete saved.record.size }
  writeFileSync(file, JSON.stringify(saved))
  const holder = await acquireSuiteLock({ root: f.lock, env: f.env, project: 'holder', size: 'L' })
  let published: Record<string, unknown> | undefined
  const lease = await acquireSuiteLock({ root: f.lock, env: f.env, park, priority: 'P0', light: true, project: 'fresh', size: 'S',
    onWait: () => { published = JSON.parse(readFileSync(file.replace(/\.parked$/, '.json'), 'utf8')) as Record<string, unknown>; releaseSuiteLock(holder) },
  }).finally(() => releaseSuiteLock(holder))
  try {
    expect(lease.record).toMatchObject({ level: 2, levelOrderVersion: 4, project: savedMetadata ? 'saved' : 'fresh', size: savedMetadata ? 'L' : 'S' })
    expect(published).toMatchObject({ level: 2, levelOrderVersion: 4, project: savedMetadata ? 'saved' : 'fresh', size: savedMetadata ? 'L' : 'S' })
    expect(lease.record.light).toBeUndefined()
    const ordered = orderSuiteLockTickets([{ number: lease.ticket, record: published }], null, Date.now())
    expect(ordered.levelOrder).toBe('rank-v4')
    expect(ordered.tickets[0].effectiveLevel).toBe(savedMetadata ? 2 : 1)
  } finally { releaseSuiteLock(lease) }
})

function runAsync(entry: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env, cwd, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, stderr }))
  })
}

// Resolves when the broker publishes its readiness marker; rejects if the broker exits first.
function brokerReady(child: ReturnType<typeof spawn>, socket: string) {
  const marker = `${socket}.ready`
  return new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(socket))
    const finish = (failure?: Error) => {
      watcher.close(); child.off('exit', exited)
      if (failure) reject(failure); else resolve()
    }
    const exited = (code: number | null, signal: string | null) => finish(new Error(`broker exited (${code ?? signal}) before readiness`))
    watcher.on('change', () => { if (existsSync(marker)) finish() })
    watcher.on('error', (cause) => finish(cause))
    child.once('exit', exited)
    if (existsSync(marker)) finish()
  })
}

async function stopBroker(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  child.kill('SIGTERM')
  await exited
}

it.skipIf(process.platform === 'win32')('does not map an unrelated broker error containing marker text in argv to stale-client', async () => {
  const f = fixture(), socket = join(f.root, 'broker.sock')
  const server = net.createServer((connection) => connection.once('data', () => connection.end('error unrelated; requested command ["wt-suite-lock: REFUSED stale-client: text"]\n')))
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  try {
    const result = await runAsync(f.cli, ['run', '--', ...f.child], { ...f.env, WT_SUITE_LOCK_BROKER: socket }, f.project)
    expect(result.status, result.stderr).toBe(2)
    expect(existsSync(f.lock)).toBe(false)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})

it.skipIf(process.platform === 'win32')('judges the broker writer tree and forwards a leading stale-client protocol field', async () => {
  const f = fixture(), socket = join(f.root, 'broker.sock')
  const broker = spawn(process.execPath, [join(f.old, 'bin/lib/host/lane-suite-lock-broker.mjs'), '--socket', socket, '--parent', String(process.pid), '--label', 'fixture'], { env: f.env, stdio: 'ignore' })
  try {
    await brokerReady(broker, socket)
    const reply = await new Promise<string>((resolve, reject) => {
      const connection = net.connect(socket)
      let text = ''
      connection.once('connect', () => connection.write(JSON.stringify({ argv: f.child, light: true, waitS: 10 }) + '\n'))
      connection.on('data', (chunk) => { text += String(chunk) })
      connection.once('error', reject)
      connection.once('close', () => resolve(text))
    })
    expect(reply).toMatch(/^error stale-client /)
    expect(reply).toContain(`restart this process from ${f.current}`)
    expect(reply).not.toContain('Replacement command:')
    const result = f.run(['run', '--light', '--', ...f.child], { WT_SUITE_LOCK_BROKER: socket }, join(PLUGIN, 'bin/wt-suite-lock.mjs'))
    expect(result.status, result.stderr).toBe(78)
    expect(result.stderr).toContain('wt-suite-lock: REFUSED stale-client:')
    expect(result.stderr).not.toContain('Usage:')
    expect(existsSync(f.lock)).toBe(false)
  } finally { await stopBroker(broker) }
})

it.skipIf(process.platform === 'win32')('lets a stale sandbox wrapper delegate to a current broker writer', async () => {
  const f = fixture(), socket = join(f.root, 'broker.sock')
  const broker = spawn(process.execPath, [join(f.current, 'bin/lib/host/lane-suite-lock-broker.mjs'), '--socket', socket, '--parent', String(process.pid), '--label', 'fixture'], { env: f.env, stdio: 'ignore' })
  try {
    await brokerReady(broker, socket)
    const result = f.run(undefined, { WT_SUITE_LOCK_BROKER: socket })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(f.marker)).toBe(true)
    expect(result.stderr).not.toContain('REFUSED stale-client:')
  } finally { await stopBroker(broker) }
})
