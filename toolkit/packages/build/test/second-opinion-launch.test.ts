import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error executable .mjs test companion
import { documentedLaunch, launchFixture, pluginRoot, skillPath } from '../../../scripts/second-opinion-launch-e2e.mjs'

// Each test blocks in one synchronous PowerShell launch, bounded at 60 s on Windows plus a 5 s
// completion poll; vitest fails a synchronous test that outlasts its timeout, so this must exceed both.
vi.setConfig({ testTimeout: process.platform === 'win32' ? 90_000 : 20_000 })

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const f = launchFixture()
  roots.push(f.root)
  return f
}

it('the documented launch preserves a missing CLI startup error beside --out', () => {
  const f = fixture()
  const result = documentedLaunch(f)
  expect(result.out).toBeNull()
  expect(existsSync(`${f.out}.launch.log`), 'documented launch must preserve startup diagnostics beside --out').toBe(true)
  expect(result.log).toMatch(/MODULE_NOT_FOUND|Cannot find module/)
})

it.each([
  ['missing import', "import './missing-dependency.mjs'", /MODULE_NOT_FOUND|Cannot find module/],
  ['syntax error in an import', "import './bad.mjs'", /SyntaxError/],
] as const)('the documented launch preserves a %s before --out can be written', (_name, source, error) => {
  const f = fixture()
  mkdirSync(join(f.plugin, 'bin'))
  writeFileSync(join(f.plugin, 'bin/wt-second-opinion.mjs'), source)
  writeFileSync(join(f.plugin, 'bin/bad.mjs'), 'export const = broken')
  const result = documentedLaunch(f)
  expect(result.out).toBeNull()
  expect(result.log).toMatch(error)
})

it('the documented launch runs the real CLI with a sealed no-consent profile', () => {
  const f = fixture()
  const result = documentedLaunch(f, { env: { WT_PLUGIN_ROOT: pluginRoot } })
  expect(result.out).toBe('REFUSED: Astra requires active GPT lane consent.\nEXIT=1\n')
})

it.skipIf(process.platform !== 'linux')('the documented launch captures a missing node executable', () => {
  const f = fixture()
  const bin = join(f.root, 'bin')
  mkdirSync(bin)
  for (const tool of ['setsid', 'nohup']) symlinkSync(`/usr/bin/${tool}`, join(bin, tool))
  const result = documentedLaunch(f, { env: { PATH: bin } })
  expect(result.out).toBeNull()
  expect(result.log).toMatch(/node/)
  expect(result.log).toMatch(/No such file|not found/)
})

it('the documented launch captures stdout as well as stderr before the CLI writes --out', () => {
  const f = fixture()
  mkdirSync(join(f.plugin, 'bin'))
  writeFileSync(join(f.plugin, 'bin/wt-second-opinion.mjs'), "console.log('startup stdout'); console.error('REFUSED: startup stderr')")
  const result = documentedLaunch(f)
  expect(result.out).toBeNull()
  if (process.platform === 'win32') {
    expect(readFileSync(`${f.out}.launch.stdout.log`, 'utf8')).toContain('startup stdout')
  } else expect(result.log).toContain('startup stdout')
  expect(result.log).toContain('REFUSED: startup stderr')
})

function registry(f: ReturnType<typeof fixture>, entries: unknown[]) {
  mkdirSync(join(f.config, 'plugins'), { recursive: true })
  writeFileSync(join(f.config, 'plugins/installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'workflow-toolbox@test': entries },
  }))
}

it('loaded skill text resolves an updated registry after its old plugin root is removed', () => {
  const f = fixture()
  const loaded = join(f.root, 'loaded-skill.md')
  writeFileSync(loaded, readFileSync(skillPath, 'utf8'))
  registry(f, [{ scope: 'user', installPath: f.plugin }])
  rmSync(f.plugin, { recursive: true })
  registry(f, [{ scope: 'user', installPath: pluginRoot }])
  const result = documentedLaunch(f, { skill: loaded, env: { WT_PLUGIN_ROOT: undefined } })
  expect(result.out).toBe('REFUSED: Astra requires active GPT lane consent.\nEXIT=1\n')
})

it.each(['project', 'local'])('the current %s installation ranks above user and unrelated project entries', (scope) => {
  const f = fixture()
  registry(f, [
    { scope, projectPath: f.config, installPath: f.plugin },
    { scope: 'user', installPath: f.plugin },
    { scope, projectPath: f.root, installPath: pluginRoot },
  ])
  const result = documentedLaunch(f, { env: { WT_PLUGIN_ROOT: undefined } })
  expect(result.out).toBe('REFUSED: Astra requires active GPT lane consent.\nEXIT=1\n')
})

it('a broken selected installation refuses with diagnostics rather than falling back', () => {
  const f = fixture()
  registry(f, [{ scope: 'user', installPath: pluginRoot }])
  const result = documentedLaunch(f)
  expect(result.out).toBeNull()
  expect(result.log).toContain('wt-second-opinion.mjs')
  expect(result.log).toMatch(/MODULE_NOT_FOUND|Cannot find module/)
})

it.skipIf(process.platform === 'win32')('the stock macOS nohup launch form also captures a missing CLI', () => {
  const result = documentedLaunch(fixture(), { platform: 'darwin' })
  expect(result.out).toBeNull()
  expect(result.log).toMatch(/MODULE_NOT_FOUND|Cannot find module/)
})

it('the Windows form redirects both streams and records Start-Process failures', () => {
  const text = readFileSync(skillPath, 'utf8')
  const block = text.match(/```powershell\n([\s\S]*?)```/)?.[1]
  expect(block).toContain('-RedirectStandardError "${out}.launch.log"')
  expect(block).toContain('-RedirectStandardOutput "${out}.launch.stdout.log"')
  expect(block).toContain('-ErrorAction Stop')
  expect(block).toContain('[IO.File]::AppendAllText("${out}.launch.log"')
})
