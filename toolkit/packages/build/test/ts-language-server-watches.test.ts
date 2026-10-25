import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import * as installedPolicy from '../../../../plugin/bin/lib/host/ts-watch-policy.mjs'
import * as installedCounts from '../../../../plugin/bin/lib/host/ts-watch-count.mjs'
import * as installedProcesses from '../../../../plugin/bin/lib/host/ts-process.mjs'
import { fixtureEnvironment, startFixture, testPluginRoot, watchedInodes, watchFixture } from './helpers/ts-watch-fixture.js'

const moduleUrl = (name: string) => pathToFileURL(join(testPluginRoot, `bin/lib/host/${name}.mjs`)).href
const policy: typeof installedPolicy = process.env.WT_TSLS_TEST_PLUGIN_ROOT ? await import(moduleUrl('ts-watch-policy')) : installedPolicy
const counts: typeof installedCounts = process.env.WT_TSLS_TEST_PLUGIN_ROOT ? await import(moduleUrl('ts-watch-count')) : installedCounts
const processes: typeof installedProcesses = process.env.WT_TSLS_TEST_PLUGIN_ROOT ? await import(moduleUrl('ts-process')) : installedProcesses
const require = createRequire(import.meta.url)
let tsserver: string | undefined
try { tsserver = require.resolve('typescript/lib/tsserver.js') } catch { /* Stated integration skip below. */ }
const scratch: string[] = []
const temporary = () => { const root = fs.mkdtempSync(join(tmpdir(), 'wt-tsls-policy-')); scratch.push(root); return root }
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const root of scratch.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function watcher() {
  return Object.assign(new EventEmitter(), { close() {}, ref() { return this }, unref() { return this } }) as fs.FSWatcher
}

const nativeWatchSpy = () => vi.fn<(file: fs.PathLike, options?: unknown, listener?: unknown) => fs.FSWatcher>(() => watcher())

type ServerShape = { version: string; shared?: boolean; shim?: boolean; change?: string; compiler?: string; reason?: string }
function compatibilityServer(shape: ServerShape) {
  const root = temporary(), lib = join(root, 'lib')
  fs.mkdirSync(lib)
  fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ version: shape.version, type: 'commonjs' }))
  const compiler = `const original = require(${JSON.stringify(require.resolve('typescript'))});
    const ts = { ...original, version: ${JSON.stringify(shape.version)}, sys: { ...original.sys } };
    ${shape.change ?? ''}
    globalThis.directoryBefore = ts.sys?.watchDirectory;
    globalThis.closedBefore = ts.server?.ProjectService?.prototype.watchClosedScriptInfo;
    module.exports = ts;`
  fs.writeFileSync(join(lib, 'typescript.js'), shape.compiler ?? compiler)
  const server = `const fs = require('node:fs'), Module = require('node:module');
    const ts = ${shape.shared ? 'require("./typescript.js")' : '{ version: ' + JSON.stringify(shape.version) + ' }'};
    require('node:readline').createInterface({ input: process.stdin }).once('line', line => setImmediate(() => {
      let refused = false;
      try { fs.watch(__filename).close() } catch (error) { refused = error.code === 'ENOSPC' }
      console.log(JSON.stringify({ answer: JSON.parse(line).value + 1, refused,
        nativeUnchanged: fs.watch === globalThis.nativeBefore,
        promisesUnchanged: fs.promises.watch === globalThis.promisesBefore,
        directoryUnchanged: ts.sys?.watchDirectory === globalThis.directoryBefore,
        closedUnchanged: ts.server?.ProjectService?.prototype.watchClosedScriptInfo === globalThis.closedBefore,
        requireUnchanged: Module.prototype.require === globalThis.requireBefore }));
    }));`
  fs.writeFileSync(join(lib, shape.shim ? '_tsserver.js' : 'tsserver.js'), server)
  if (shape.shim) fs.writeFileSync(join(lib, 'tsserver.js'), 'module.exports = require("./_tsserver.js")')
  const seal = pathToFileURL(fileURLToPath(new URL('./fixtures/ts-watch/network-seal.mjs', import.meta.url))).href
  const observer = `data:text/javascript,import fs from 'node:fs'; import Module from 'node:module';
    globalThis.nativeBefore=fs.watch; globalThis.promisesBefore=fs.promises.watch; globalThis.requireBefore=Module.prototype.require;`
  const compatibilityPreload = pathToFileURL(join(testPluginRoot, 'bin/lib/host/ts-watch-preload.mjs')).href
  return spawnSync(process.execPath, ['--import', seal, '--import', observer, '--import', compatibilityPreload, join(lib, 'tsserver.js')], {
    encoding: 'utf8', input: '{"value":41}\n', timeout: 15_000,
    env: { ...fixtureEnvironment(root), WT_TSLS_NATIVE_WATCH_BUDGET: '0' },
  })
}

it('starts and answers with a pre-5 compiler without server and a separately bundled tsserver', () => {
  const result = compatibilityServer({ version: '3.9.10', change: 'delete ts.server;' })
  expect(result.status, `legacy bundled server must start and answer: ${result.stderr}`).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ answer: 42, nativeUnchanged: true, promisesUnchanged: true, refused: false })
  expect(result.stderr.trim().split('\n')).toEqual(['wt-tsls: warning: TypeScript 3.9.10: native watch budget and closed-input polling not applied (unsupported-version)'])
})

it.each<[string, ServerShape]>([
  ['shared TypeScript 5', { version: '5.1.6', shared: true }],
  ['shared TypeScript 6 shim', { version: ts.version, shared: true, shim: true }],
  ['pre-5 separate server namespace', { version: '4.9.5', reason: 'unsupported-version' }],
  ['missing server namespace', { version: ts.version, shared: true, change: 'delete ts.server;', reason: 'unsupported-watch-surface' }],
  ['missing ProjectService', { version: ts.version, shared: true, change: 'ts.server = {};', reason: 'unsupported-watch-surface' }],
  ['missing polling factory', { version: ts.version, shared: true, change: 'delete ts.createSystemWatchFunctions;', reason: 'unsupported-watch-surface' }],
  ['unknown future version', { version: '7.0.0', shared: true, reason: 'unsupported-version' }],
  ['unknown version format', { version: 'unrecognized', shared: true, reason: 'unsupported-version' }],
  ['malformed version in a known major', { version: '6.not-a-version', shared: true, reason: 'unsupported-version' }],
  ['separate bundled compiler with a full adjacent surface', { version: ts.version, reason: 'server-module-not-shared' }],
  ['throwing compiler load with a bundled server', { version: ts.version, compiler: 'throw new Error("compiler cannot load")', reason: 'preload-initialization-failed' }],
  ['immutable watch surface', { version: ts.version, shared: true, change: 'Object.freeze(ts.sys);', reason: 'watch-installation-failed' }],
  ['throwing installation rolls back all patches', { version: ts.version, shared: true, change: 'ts.createSystemWatchFunctions = () => { throw new Error("factory failed") };', reason: 'watch-installation-failed' }],
])('applies or explicitly skips the watch bound for %s', (_name, shape) => {
  const result = compatibilityServer(shape)
  expect(result.status, `compatibility must not prevent startup: ${result.stderr}`).toBe(0)
  const answer = JSON.parse(result.stdout), skipped = Boolean(shape.reason)
  expect(answer, 'native admission must match the verified shared-module verdict').toMatchObject({ answer: 42, nativeUnchanged: skipped, promisesUnchanged: skipped, refused: !skipped, requireUnchanged: true })
  if (shape.shared) expect(answer).toMatchObject({ directoryUnchanged: skipped, closedUnchanged: skipped })
  expect(result.stderr.trim().split('\n').filter(Boolean)).toEqual(shape.reason
    ? [`wt-tsls: warning: TypeScript ${shape.version}: native watch budget and closed-input polling not applied (${shape.reason})`] : [])
})

  it('inherits the preload without replacing an explicit Node client option', () => {
    const env = { NODE_OPTIONS: '--no-warnings', SENTINEL: 'preserved' }
    const options = processes.tsProcessOptions({ env, windowsHide: true })
    expect(options.env.NODE_OPTIONS).toContain('--no-warnings --import=file:')
    expect(options.env.NODE_OPTIONS).toContain('ts-watch-preload.mjs')
    expect(options.env.SENTINEL).toBe('preserved')
    expect(options.windowsHide).toBe(true)
    expect(env).toEqual({ NODE_OPTIONS: '--no-warnings', SENTINEL: 'preserved' })
  })

  it('preserves project watchOptions and explicit native options without mutating their objects', () => {
    vi.stubEnv('WT_TSLS_NATIVE_WATCH_BUDGET', '1')
    const root = temporary(), native = nativeWatchSpy()
    const parsed = ts.parseJsonConfigFileContent({ watchOptions: { watchFile: 'useFsEvents', watchDirectory: 'dynamicPriorityPolling', excludeFiles: ['**/cache/**'] } }, ts.sys, root)
    const before = structuredClone(parsed.watchOptions)
    const filesystem = { watch: native, watchFile: vi.fn() }
    policy.boundTypeScriptWatches({ ...ts, sys: { ...ts.sys } }, filesystem)
    const options = { ...parsed.watchOptions, persistent: false, recursive: false, encoding: 'utf8' as const }
    const callback = () => {}
    const handle = filesystem.watch(root, options, callback)
    expect(native.mock.calls[0]?.[0]).toBe(root)
    expect(native.mock.calls[0]?.[1]).toMatchObject(before!)
    expect(options).toEqual({ ...before, persistent: false, recursive: false, encoding: 'utf8' })
    expect(parsed.watchOptions).toEqual(before)
    expect(parsed.watchOptions?.watchDirectory).toBe(ts.WatchDirectoryKind.DynamicPriorityPolling)
    expect(() => filesystem.watch(root, options, callback), 'installed admission must refuse a second native watch at budget one').toThrow(expect.objectContaining({ code: 'ENOSPC' }))
    expect(native).toHaveBeenCalledTimes(1)
    handle.close()
  })

  it.each([false, true])('disables automatic type acquisition inside the actual tsserver entry process (symlink=%s)', (symlink) => {
    const root = temporary()
    fs.writeFileSync(join(root, 'tsserver.js'), 'console.log(JSON.stringify({ disabled: process.argv.includes("--disableAutomaticTypingAcquisition"), serverDisabled: require("./typescript.js").server.hasArgument("--disableAutomaticTypingAcquisition") }))')
    fs.writeFileSync(join(root, 'typescript.js'), `module.exports = require(${JSON.stringify(require.resolve('typescript'))})`)
    const sealFile = fileURLToPath(new URL('./fixtures/ts-watch/network-seal.mjs', import.meta.url))
    const seal = pathToFileURL(sealFile).href
    const preloadFile = join(testPluginRoot, 'bin/lib/host/ts-watch-preload.mjs')
    const preload = pathToFileURL(preloadFile).href
    const warm = `data:text/javascript,import ${JSON.stringify(pathToFileURL(require.resolve('typescript')).href)}`
    fs.mkdirSync(join(root, 'tools'))
    if (symlink) fs.symlinkSync(join(root, 'tsserver.js'), join(root, 'tools/tsserver.js'))
    const entry = join(root, symlink ? 'tools/tsserver.js' : 'tsserver.js')
    const result = spawnSync(process.execPath, ['--import', seal, '--import', warm, '--import', preload, entry], { encoding: 'utf8', timeout: 25_000, env: fixtureEnvironment(root) })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ disabled: true, serverDisabled: true })
  })

  it.each([false, true])('unref native watches lets an otherwise idle child exit (ref cycle=%s)', (cycle) => {
    const root = temporary(), file = join(root, 'value.ts')
    fs.writeFileSync(file, 'export const value = 42')
    const sealFile = fileURLToPath(new URL('./fixtures/ts-watch/network-seal.mjs', import.meta.url))
    const seal = pathToFileURL(sealFile).href
    const code = `import ts from ${JSON.stringify(pathToFileURL(require.resolve('typescript')).href)};
      import { createBoundedFsWatch } from ${JSON.stringify(moduleUrl('ts-watch-policy'))};
      const handle = createBoundedFsWatch(ts, undefined, { budget: 1 })(${JSON.stringify(file)}, { persistent: false });
      ${cycle ? 'handle.ref(); handle.unref();' : ''} console.log('unreferenced');`
    const result = spawnSync(process.execPath, ['--import', seal, '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15_000, env: fixtureEnvironment(root) })
    expect(result.status, 'persistent:false and unref must release native watcher liveness').toBe(0)
    expect(result.stdout).toContain('unreferenced')
  })

function proc(watches: number, max = 1000) {
  return {
    platform: 'linux', list: () => ['1', '2'],
    read: (file: string) => file.endsWith('max_user_watches') ? `${max}\n` : file.endsWith('/1') ? `pos: 0\n${'inotify wd:1 ino:1\n'.repeat(watches)}` : 'pos: 0\n',
  }
}

  it('counts inotify records across fdinfo and reads the actual watch budget', () => {
    expect(counts.readTsserverWatchCount(123, proc(301))).toEqual({ status: 'measured', watches: 301, max: 1000 })
  })
  it('warns exactly once above the threshold, using full precision before rendering', () => {
    const write = vi.fn<(chunk: unknown) => boolean>(() => true)
    const check = counts.createWatchWarning({ write }, { ...proc(2504, 10_000), threshold: 25 })
    check(123); check(123)
    expect(write.mock.calls).toEqual([['wt-tsls: warning: tsserver holds 2504 inotify watches (25.0% of max_user_watches 10000)\n']])
  })
  it('stays silent below and exactly at the threshold', () => {
    const write = vi.fn<(chunk: unknown) => boolean>(() => true)
    for (const n of [0, 249, 250]) counts.createWatchWarning({ write }, { ...proc(n), threshold: 25 })(123)
    expect(write).not.toHaveBeenCalled()
  })
  it('silences every proc read failure and reports unavailable rather than zero', () => {
    const write = vi.fn<(chunk: unknown) => boolean>(() => true)
    for (const seam of ['kernel', 'fdinfo', 'list']) {
      const original = proc(301)
      const fail = () => { throw new Error('unreadable proc') }
      const reader = { ...original, list: seam === 'list' ? fail : original.list, read: (file: string) => file.includes(seam === 'kernel' ? 'max_user_watches' : 'fdinfo') ? fail() : original.read(file) }
      expect(counts.createWatchWarning({ write }, reader)(123)).toEqual({ status: 'unavailable' })
    }
    expect(write).not.toHaveBeenCalled()
  })
  it('names the non-Linux skipped state without reading proc on macOS or Windows', () => {
    const read = vi.fn(() => { throw new Error('must not read') })
    for (const platform of ['darwin', 'win32']) expect(counts.readTsserverWatchCount(123, { platform, read })).toEqual({ status: 'skipped', reason: 'non-linux' })
    expect(read).not.toHaveBeenCalled()
  })
  it('uses the named 25 percent default and validates the environment override', () => {
    expect(counts.DEFAULT_WATCH_WARN_PCT).toBe(25)
    for (const value of [undefined, '', 'garbage', '-1', '101']) expect(counts.watchWarningThreshold(value)).toBe(25)
    expect(counts.watchWarningThreshold('12.5')).toBe(12.5)
    expect(counts.watchWarningThreshold('0')).toBe(0)
  })
  it('rejects an invalid kernel budget rather than returning a plausible measured value', () => {
    for (const max of [0, -1, 0.5, NaN]) expect(counts.readTsserverWatchCount(123, proc(1, max))).toEqual({ status: 'unavailable' })
  })

  it('monitors only its own TLS tsserver children, warns once, and stops on close', () => {
    vi.useFakeTimers()
    vi.stubEnv('WT_TSLS_WATCH_WARN_PCT', '25')
    const child = Object.assign(new EventEmitter(), { pid: 10 })
    const write = vi.fn<(chunk: unknown) => boolean>(() => true)
    const read = vi.fn((file: string) => {
      if (file === '/proc/10/task/10/children') return '11 12'
      if (file === '/proc/11/cmdline') return '/node\0/tsserver.js\0'
      if (file === '/proc/12/cmdline') return '/node\0/typingsInstaller.js\0'
      return proc(301).read(file)
    })
    expect(counts.monitorTsserverWatches(child, { write }, { ...proc(301), read })).toEqual({ status: 'monitoring' })
    vi.advanceTimersByTime(counts.WATCH_SAMPLE_INTERVAL_MS * 2)
    expect(write).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith('/proc/11/fdinfo/1')
    expect(read).not.toHaveBeenCalledWith('/proc/12/fdinfo/1')
    child.emit('close')
    const calls = read.mock.calls.length
    vi.advanceTimersByTime(counts.WATCH_SAMPLE_INTERVAL_MS)
    expect(read).toHaveBeenCalledTimes(calls)
  })

const integrationSkipReason = process.platform !== 'linux' ? 'requires Linux /proc' : tsserver ? undefined : 'typescript/lib/tsserver.js is not resolvable'
const integrationSuffix = integrationSkipReason ? ` (skipped: ${integrationSkipReason})` : ''
const linuxTest = it.skipIf(Boolean(integrationSkipReason))
  linuxTest.each([
    ['bounds native watches', 64],
    ['delegates the large umbrella to TypeScript polling', 0],
  ] as const)(`%s and observes all 2880 dependency program files${integrationSuffix}`, async (_label, budget) => {
    const fixture = watchFixture(true), server = startFixture(fixture, tsserver!, { budget })
    try {
      const pid = (await server.wait((message) => message.method === '$/tsserverPid')).params!.pid!
      await server.command(10, 'open', { file: join(fixture.workspace, 'entry.ts'), projectRootPath: fixture.workspace })
      const info = await server.command(11, 'projectInfo', { file: join(fixture.workspace, 'entry.ts'), needFileNameList: true })
      expect(info.success, server.stderr()).toBe(true)
      const programFiles = (info.body as { fileNames: string[] }).fileNames
      expect(fixture.dependencies.every((file) => programFiles.includes(file)), 'all fixture dependencies must belong to the live program').toBe(true)
      const closedFiles = programFiles.filter((file) => file.endsWith('.ts') && file !== join(fixture.workspace, 'entry.ts'))
      expect(closedFiles.every((file) => file.startsWith(fixture.workspace)), 'disk-edit proof is confined to the owned fixture').toBe(true)
      const sample = counts.readTsserverWatchCount(pid)
      expect(sample.status).toBe('measured')
      if (sample.status !== 'measured') throw new Error('Linux proc watch count is unavailable')
      console.log(`umbrella tsserver watches=${sample.watches}; budget=${budget}; dependencyFiles=2880`)
      if (process.env.WT_TSLS_TEST_METRICS) fs.writeFileSync(process.env.WT_TSLS_TEST_METRICS, `${JSON.stringify(sample)}\n`)
      expect(sample.watches, 'native watch count must stay within the configured budget').toBeLessThanOrEqual(budget)
      const updated = server.backgroundUpdate().then(() => true, () => false)
      const changedAt = performance.now()
      for (const dependency of closedFiles) fs.writeFileSync(dependency, 'export const value: number = "changed"\n')
      expect(await updated, 'dependency disk edits must signal a project update').toBe(true)
      console.log(`umbrella backgroundUpdateMs=${(performance.now() - changedAt).toFixed(1)}; transport=TypeScript-fallback`)
      for (const [index, dependency] of closedFiles.entries()) {
        const diagnostics = await server.command(index + 100, 'semanticDiagnosticsSync', { file: dependency })
        expect(diagnostics.body, `program input must remain observed: ${dependency}`).toEqual(expect.arrayContaining([expect.objectContaining({ code: 2322 })]))
      }
      const observed = new Set(fs.readFileSync(fixture.watchEvents, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string))
      expect(closedFiles.filter((file) => !observed.has(file)), 'every closed program input must receive a watch-transport event').toEqual([])
      const polled = new Set(fs.readFileSync(`${fixture.watchEvents}.polling`, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string))
      if (budget === 0) expect(closedFiles.filter((file) => !polled.has(file)), 'every closed input must be delivered through TypeScript fs.watchFile polling').toEqual([])
      console.log(`umbrella observedClosedProgramFiles=${closedFiles.length}; diagnostic=2322 for every file`)
      const after = counts.readTsserverWatchCount(pid)
      expect(after.status === 'measured' && after.watches <= budget, 'the budget must still hold after polling delivers changes').toBe(true)
      if (budget > 0) {
        await server.warning()
        expect(server.stderr().match(/wt-tsls: warning: tsserver holds/g)).toHaveLength(1)
      }
    } finally { await server.dispose(); fixture.dispose() }
  }, 120_000)

  linuxTest(`keeps ordinary single-repo answers and project polling choices intact${integrationSuffix}`, async () => {
    const fixture = watchFixture(false), server = startFixture(fixture, tsserver!)
    const file = join(fixture.workspace, 'entry.ts')
    try {
      await server.wait((message) => message.id === 1)
      await server.command(20, 'open', { file, projectRootPath: fixture.workspace })
      const definition = await server.command(21, 'definition', { file, line: 3, offset: 2 })
      expect(definition.body).toMatchObject([{ file: join(fixture.workspace, 'value.ts'), start: { line: 1, offset: 14 } }])
      const references = await server.command(22, 'references', { file, line: 3, offset: 2 })
      expect(references.body).toMatchObject({ refs: expect.arrayContaining([expect.objectContaining({ file: join(fixture.workspace, 'value.ts') }), expect.objectContaining({ file })]) })
      const diagnostics = await server.command(23, 'semanticDiagnosticsSync', { file })
      expect(diagnostics.body).toEqual(expect.arrayContaining([expect.objectContaining({ code: 2322, start: { line: 2, offset: 7 } })]))
      const pid = (await server.wait((message) => message.method === '$/tsserverPid')).params!.pid!
      const rootInode = fs.statSync(fixture.workspace, { bigint: true }).ino.toString(16)
      expect(watchedInodes(pid).has(rootInode), 'project directory polling must still win').toBe(false)
    } finally { await server.dispose(); fixture.dispose() }
  }, 40_000)

function inputFixture(name: string) {
  const fixture = watchFixture(false), file = join(fixture.workspace, 'entry.ts'), source = join(fixture.workspace, name)
  fs.mkdirSync(join(source, '..'), { recursive: true })
  const declaration = name.endsWith('.d.ts')
  fs.writeFileSync(source, declaration ? 'export declare const answer: number\n' : 'export const answer = 42\n')
  fs.utimesSync(source, new Date(1_700_000_000_000), new Date(1_700_000_000_000))
  fs.writeFileSync(file, `import { answer } from './${name.replace(/\.d\.ts$|\.ts$/, '')}'\nconst result: number = answer\n`)
  fs.writeFileSync(join(fixture.workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [], strict: true, noEmit: true, outDir: 'dist' }, include: ['entry.ts'], watchOptions: { watchFile: 'useFsEvents', watchDirectory: 'useFsEvents' } }))
  fs.mkdirSync(join(fixture.workspace, 'app'))
  fs.writeFileSync(join(fixture.workspace, 'app/tsconfig.build.json'), JSON.stringify({ compilerOptions: { outDir: '../generated' } }))
  return { fixture, file, source, declaration }
}

linuxTest(`individually polls a closed dependency with unchanged parent mtime${integrationSuffix}`, async () => {
  const { fixture, file, source } = inputFixture('node_modules/pkg/index.d.ts')
  const server = startFixture(fixture, tsserver!, { budget: 0 })
  try {
    await server.command(50, 'open', { file, projectRootPath: fixture.workspace })
    expect((await server.command(51, 'semanticDiagnosticsSync', { file })).body).toEqual([])
    const pid = (await server.wait((message) => message.method === '$/tsserverPid')).params!.pid!
    const subscriptions = fs.readFileSync(`${fixture.watchEvents}.subscriptions`, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string)
    expect(subscriptions, 'a closed dependency must have an individual file-poll subscription').toContain(source)
    const parent = join(source, '..'), parentMtime = fs.statSync(parent).mtimeMs
    const originalMtime = fs.statSync(source).mtimeMs
    const updated = server.backgroundUpdate().then(() => true, () => false), changedAt = performance.now()
    fs.writeFileSync(source, 'export declare const answer: string\n')
    fs.utimesSync(source, new Date(originalMtime + 10_000), new Date(originalMtime + 10_000))
    expect(fs.statSync(source).mtimeMs).not.toBe(originalMtime)
    expect(fs.statSync(parent).mtimeMs, 'the parent directory must not supply the change signal').toBe(parentMtime)
    expect(await updated, 'the individual dependency poll must update the project without reopening').toBe(true)
    const diagnostics = await server.command(52, 'semanticDiagnosticsSync', { file })
    expect(diagnostics.body, 'the closed dependency edit must refresh diagnostic 2322 without reload').toEqual(expect.arrayContaining([expect.objectContaining({ code: 2322 })]))
    const delivered = fs.readFileSync(`${fixture.watchEvents}.polling`, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string)
    expect(delivered, 'TypeScript file polling must deliver the dependency event').toContain(source)
    expect(counts.readTsserverWatchCount(pid)).toMatchObject({ status: 'measured', watches: 0 })
    console.log(`closed dependency: native=0; individualPoll=true; parentMtimeUnchanged=true; diagnostic=2322; updateMs=${(performance.now() - changedAt).toFixed(1)}`)
  } finally { await server.dispose(); fixture.dispose() }
}, 40_000)

linuxTest.each([
  ['imported configured output', 'dist/value.ts'],
  ['imported dependency declaration', 'node_modules/pkg/index.d.ts'],
  ['sibling configured output', 'generated/pkg/value.ts'],
] as const)(`observes closed %s through polling under a zero native budget${integrationSuffix}`, async (label, name) => {
  const { fixture, file, source, declaration } = inputFixture(name)
  const server = startFixture(fixture, tsserver!, { budget: 0 })
  try {
    await server.wait((message) => message.id === 1)
    await server.command(40, 'open', { file, projectRootPath: fixture.workspace })
    expect((await server.command(41, 'semanticDiagnosticsSync', { file })).body).toEqual([])
    const pid = (await server.wait((message) => message.method === '$/tsserverPid')).params!.pid!
    const sample = counts.readTsserverWatchCount(pid)
    expect(sample.status).toBe('measured')
    if (sample.status !== 'measured') throw new Error('Linux proc count unavailable')
    const updated = server.backgroundUpdate().then(() => true, () => false)
    const changedAt = performance.now()
    fs.writeFileSync(source, declaration ? 'export declare const answer: string\n' : 'export const answer = ""\n')
    expect(await updated, `${label} disk edit must reach the server`).toBe(true)
    const diagnostics = await server.command(42, 'semanticDiagnosticsSync', { file })
    expect(diagnostics.body, 'closed imported program input must refresh diagnostics').toEqual(expect.arrayContaining([expect.objectContaining({ code: 2322 })]))
    expect(sample.watches, 'zero native budget must cover sibling and dependency subscriptions').toBe(0)
    console.log(`${label}: native=${sample.watches}; budget=0; diagnostic=2322; updateMs=${(performance.now() - changedAt).toFixed(1)}`)
  } finally { await server.dispose(); fixture.dispose() }
}, 40_000)

  it.skipIf(!tsserver).each([
    ['toolkit/packages/build/src', 'toolkit/packages/build/src/cli.ts', ['**/*.ts']],
    ['filename glob', 'build/foobar.ts', ['entry.ts', 'build/foo*.ts']],
    ['configDir glob', 'build/src/value.ts', ['entry.ts', '${configDir}/build/src/**/*']],
    ['import outside include', 'build/src/value.ts', ['entry.ts']],
  ] as const)('refreshes diagnostics after a disk edit to closed %s source', async (_label, path, include) => {
    const fixture = watchFixture(false)
    const source = join(fixture.workspace, path)
    const file = join(fixture.workspace, 'entry.ts')
    fs.mkdirSync(join(source, '..'), { recursive: true })
    fs.writeFileSync(source, 'export const answer = 42\n')
    fs.writeFileSync(file, `import { answer } from './${path.replace(/\.ts$/, '')}'\nconst result: number = answer\n`)
    fs.writeFileSync(join(fixture.workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [], strict: true }, include, watchOptions: { watchFile: 'fixedPollingInterval', watchDirectory: 'fixedPollingInterval' } }))
    const server = startFixture(fixture, tsserver!)
    try {
      await server.wait((message) => message.id === 1)
      await server.command(30, 'open', { file, projectRootPath: fixture.workspace })
      expect((await server.command(31, 'semanticDiagnosticsSync', { file })).body).toEqual([])
      const updated = server.backgroundUpdate().then(() => true, () => false)
      fs.writeFileSync(source, 'export const answer = "changed"\n')
      expect(await updated, 'closed source edit must signal a background project update without reopening').toBe(true)
      const reply = await server.command(32, 'semanticDiagnosticsSync', { file })
      expect((reply.body as Array<{ code: number }>).some((diagnostic) => diagnostic.code === 2322), 'closed source disk edit must refresh diagnostics without reopening').toBe(true)
    } finally { await server.dispose(); fixture.dispose() }
  }, 40_000)
