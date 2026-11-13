import path from 'node:path'
import { expect, it } from 'vitest'
// @ts-expect-error Host JavaScript has no TypeScript declarations.
import { staleSuiteLockClient, suiteLockCacheIdentity, suiteLockReplacementCommand } from '../../../../plugin/bin/lib/host/suite-lock-client-currency.mjs'
// @ts-expect-error Shared executable regression has no TypeScript declarations.
import { currencyFixCases } from './helpers/suite-lock-currency-fixes.selftest.mjs'

it.each(currencyFixCases as { name: string; run: () => void }[])('$name', ({ run }) => { run() })

const moduleUrl = 'file:///C:/Config/plugins/cache/workflow-toolbox/workflow-toolbox/old/bin/lib/suite-lock.mjs'
function fixture() {
  const own = 'C:\\Config\\plugins\\cache\\workflow-toolbox\\workflow-toolbox\\old'
  const target = 'C:\\Config\\plugins\\cache\\workflow-toolbox\\workflow-toolbox\\new'
  const warnings: string[] = [], calls: string[] = []
  const entry = { scope: 'user', installPath: target, version: 'new' }
  const state = { registry: { plugins: { 'workflow-toolbox@workflow-toolbox': [entry] } },
    probe: { status: 0, stdout: '4', error: undefined as Error | undefined }, manifest: { name: 'workflow-toolbox', version: 'new' } }
  const io = {
    realpathSync: (file: string) => file,
    statSync: () => ({ isFile: () => true, mtimeMs: 1, size: 100 }),
    readFileSync: (file: string) => file.endsWith('installed_plugins.json') ? JSON.stringify(state.registry)
      : file.endsWith('plugin.json') ? JSON.stringify(state.manifest) : '',
    spawnSync: (_command: string, args: string[], options: { timeout: number }) => {
      calls.push(args[0]!)
      expect(options).toMatchObject({ timeout: 5000, killSignal: 'SIGKILL' })
      return state.probe
    },
    warn: (line: string) => warnings.push(line),
  }
  const check = (extra: Record<string, unknown> = {}) => staleSuiteLockClient({ moduleUrl, ownOrderVersion: 3,
    argv: ['node', `${own}\\bin\\wt-suite-lock.mjs`, 'run', '--', 'true'], platform: 'win32', paths: path.win32,
    env: {}, cwd: 'C:\\Project', io, ...extra })
  return { own, target, entry, state, warnings, calls, io, check }
}

it('recognises Windows cache segments and derives the registry config directory', () => {
  expect(suiteLockCacheIdentity(moduleUrl, 'win32', path.win32)).toMatchObject({
    config: 'C:\\Config', key: 'workflow-toolbox@workflow-toolbox', version: 'old',
  })
})

it('makes checkout and non-cache roots inert before IO', () => {
  const f = fixture()
  expect(f.check({ moduleUrl: 'file:///C:/checkout/plugin/bin/lib/suite-lock.mjs' })).toBeNull()
  expect(f.calls).toEqual([])
  expect(f.warnings).toEqual([])
})

it('compares Windows self identity after realpath and case folding', () => {
  const f = fixture()
  f.entry.installPath = f.own.toUpperCase()
  expect(f.check()).toBeNull()
  expect(f.calls).toEqual([])
  f.entry.installPath = 'C:\\Alias'
  f.io.realpathSync = (file) => file === 'C:\\Alias' ? f.own : file
  expect(f.check()).toBeNull()
})

it('treats equal order versions as current and namespace-missing own versions as zero', () => {
  const f = fixture()
  expect(f.check({ ownOrderVersion: 4 })).toBeNull()
  expect(f.check({ ownOrderVersion: undefined })).toMatchObject({ orderVersion: 4 })
})

it('accepts the historical order-module namespace shape without a current-version export', async () => {
  const url = 'data:text/javascript,export const BOUNDED_P0_ORDER_VERSION = 2'
  const legacy = await import(url) as Record<string, unknown>
  const f = fixture()
  expect(f.check({ ownOrderVersion: legacy.SUITE_LOCK_ORDER_VERSION })).toMatchObject({ orderVersion: 4 })
})

it.each(['undefined', 'null', '4.5', '"4"'])('fails open for a non-integer namespace export %s', (value) => {
  const f = fixture()
  f.state.probe.stdout = value
  expect(f.check()).toBeNull()
  expect(f.warnings).toHaveLength(1)
})

it.each(['timeout', 'failure'])('fails open for probe %s with one warning', (failure) => {
  const f = fixture()
  if (failure === 'timeout') f.state.probe.error = new Error('ETIMEDOUT')
  else f.state.probe.status = 1
  expect(f.check()).toBeNull()
  expect(f.warnings).toHaveLength(1)
})

it('does not print a fabricated shell command for a library process', () => {
  const f = fixture(), result = f.check({ argv: ['node', 'C:\\service.mjs'] })
  expect(result).toMatchObject({ installPath: f.target, command: null })
})

it('fails open when paths or warning output are unreadable', () => {
  const f = fixture()
  f.io.realpathSync = () => { throw new Error('unreadable\npath') }
  expect(f.check()).toBeNull()
  expect(f.warnings).toHaveLength(1)
  expect(f.warnings[0]).not.toContain('\n')
  f.io.warn = () => { throw new Error('closed stderr') }
  expect(f.check()).toBeNull()
})

it('renders POSIX quotes, empty strings and newlines without losing argument content', () => {
  expect(suiteLockReplacementCommand('/plugin/bin/entry', ["a'b", '', 'a\nb'], 'linux', { execPath: '/runtime/node', execArgv: [] }))
    .toBe("'/runtime/node' '/plugin/bin/entry' 'a'\\''b' '' 'a\nb'")
})

it('renders Windows spaces, backslashes and trailing separators with double quotes', () => {
  expect(suiteLockReplacementCommand('C:\\Plugin Dir\\entry.mjs', ['a b', 'C:\\tail\\'], 'win32', { execPath: 'C:\\Runtime\\node.exe', execArgv: [] }))
    .toBe('cmd.exe: "C:\\Runtime\\node.exe" "C:\\Plugin Dir\\entry.mjs" "a b" "C:\\tail\\\\"')
})

it.each(['%', '!', '^', '"', '\n', '\r'])('refuses with restart guidance instead of promising an unsafe cmd.exe argument %j', (argument) => {
  const f = fixture()
  expect(f.check({ argv: ['node', `${f.own}\\bin\\wt-suite-lock.mjs`, 'run', '--', argument] })).toMatchObject({ orderVersion: 4, command: null })
  expect(f.warnings).toHaveLength(0)
})

it('bounds literal import closure traversal before probing', () => {
  const f = fixture(), original = f.io.readFileSync
  let count = 0
  f.io.readFileSync = (file) => file.endsWith('plugin.json') || file.endsWith('installed_plugins.json') ? original(file)
    : `export * from './next-${count++}.mjs'`
  expect(f.check()).toBeNull()
  expect(f.calls).toEqual([])
  expect(f.warnings).toHaveLength(1)
  expect(f.warnings[0]).toContain('exceeds 400 files')
})
