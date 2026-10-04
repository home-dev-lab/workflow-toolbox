import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error dependency-free Node locks are also run directly before the suite
import { fixLocks, runFixLock } from './helpers/adopt-shim-fix-locks.mjs'

const REPO = fileURLToPath(new URL('../../../..', import.meta.url))
const INSTALLER = process.env.WT_SHIM_INSTALLER ?? join(REPO, 'plugin/skills/adopt/scripts/install.mjs')
const HOOK = process.env.WT_SHIM_HOOK ?? join(REPO, 'plugin/bin/wt-adopt-check-hook.mjs')
const FILES = ['wt-lane.mjs', 'wt-lane-wait.mjs', 'wt-arc-watch.mjs', 'wt-quota-watch.mjs']
const roots: string[] = []
describe('adopted script review regression locks', () => {
  for (const name of Object.keys(fixLocks)) {
    it.skipIf(process.platform === 'win32' && name === 'non executable interpreter preflight')(name, () => { runFixLock(name) })
  }
})
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-script-shim-'))); roots.push(root)
  const config = join(root, 'config'), project = join(root, 'project'), scripts = join(config, 'scripts')
  mkdirSync(join(config, 'plugins'), { recursive: true }); mkdirSync(project)
  const env = sealedPluginCliEnv(root, { CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: undefined, WT_PLUGIN_ROOT: undefined, NODE_OPTIONS: undefined })
  const plugin = fakePlugin(root, 'installed')
  cpSync(join(REPO, 'plugin/bin/lib'), join(plugin, 'bin/lib'), { recursive: true })
  registry(config, [{ scope: 'user', installPath: plugin }])
  return { root, config, project, scripts, plugin, env }
}
function fakePlugin(root: string, label: string, name = 'workflow-toolbox') {
  const plugin = join(root, label)
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true }); mkdirSync(join(plugin, 'bin'))
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0' }))
  for (const file of FILES) writeFileSync(join(plugin, 'bin', file), `process.stdout.write(${JSON.stringify(label)});`)
  return plugin
}
function registry(config: string, entries: object | object[], wrapped = true) {
  const plugins = { 'workflow-toolbox@fixture': entries }
  writeFileSync(join(config, 'plugins/installed_plugins.json'), JSON.stringify(wrapped ? { plugins } : plugins))
}
function install(f: ReturnType<typeof fixture>, ...extra: string[]) {
  return spawnSync(process.execPath, [INSTALLER, '--set', 'scripts', '--install', '--dir', f.scripts, ...extra], { env: f.env, cwd: f.project, encoding: 'utf8' })
}
function adopt(f: ReturnType<typeof fixture>) {
  const result = install(f); expect(result.status, result.stdout + result.stderr).toBe(0)
}
function check(f: ReturnType<typeof fixture>, strict = true) {
  return spawnSync(process.execPath, [INSTALLER, '--set', 'scripts', '--check', '--dir', f.scripts, ...(strict ? ['--fail-on-drift'] : [])], { env: f.env, cwd: f.project, encoding: 'utf8' })
}
function run(f: ReturnType<typeof fixture>, file: string, args: string[] = []) {
  return spawnSync(process.execPath, [join(f.scripts, file), ...args], { env: f.env, cwd: f.project })
}
function age(file: string) {
  const text = readFileSync(file, 'utf8'), lines = text.split('\n')
  const body = lines[0] + '\n' + lines.slice(3).join('\n') + '// old template\n'
  const fp = createHash('sha256').update(body).digest('hex').slice(0, 12)
  writeFileSync(file, body.replace('\n', `\n// installed from workflow-toolbox v0.0.1 · content sha256:${fp} by the adopt skill -- editable copy.\n\n`))
}

describe('adopted script shim contract', () => {
  it('loads upgraded canonical bodies immediately without re-adoption', () => {
    const f = fixture(); adopt(f)
    const installed = readFileSync(join(f.scripts, FILES[0]!), 'utf8')
    expect(run(f, FILES[0]!).stdout.toString()).toBe('installed')
    writeFileSync(join(f.plugin, 'bin', FILES[0]!), "process.stdout.write('upgraded')")
    expect(run(f, FILES[0]!).stdout.toString()).toBe('upgraded')
    expect(readFileSync(join(f.scripts, FILES[0]!), 'utf8')).toBe(installed)
    expect(check(f).status).toBe(0)
  })
  it.each(FILES)('renders %s as a fingerprinted shim and catches edits', (file) => {
    const f = fixture(); adopt(f)
    const target = join(f.scripts, file)
    expect(existsSync(target)).toBe(true)
    const text = readFileSync(target, 'utf8')
    expect(text.split('\n')[1]).toMatch(/^\/\/ installed from workflow-toolbox v/)
    expect(text).not.toContain('./lib/')
    expect(check(f).stdout).toContain(`${file}: UP-TO-DATE`)
    writeFileSync(target, text + '// local edit\n')
    const drift = check(f); expect(drift.status).toBe(1); expect(drift.stdout).toContain(`${file}: EDITED`)
    expect(check(f, false).status).toBe(0)
  })
  it.each(FILES)('refuses to overwrite hand-authored %s even with force and fails the drift check', (file) => {
    const f = fixture(); mkdirSync(f.scripts); const target = join(f.scripts, file)
    writeFileSync(target, '// my script\n')
    expect(install(f, '--force').status).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('// my script\n')
    const drift = check(f); expect(drift.status).toBe(1); expect(drift.stdout).toContain(`${file}: PRESENT (no toolbox banner`)
  })
  it.each(FILES)('fails the drift check for stale %s and refreshes it', (file) => {
    const f = fixture(); adopt(f); age(join(f.scripts, file))
    const drift = check(f); expect(drift.status).toBe(1); expect(drift.stdout).toContain(`${file}: STALE`)
    adopt(f); expect(check(f).status).toBe(0)
  })
  it.each(FILES)('reports a missing canonical %s target, refuses installation, and refuses execution', (file) => {
    const f = fixture(); adopt(f); rmSync(join(f.plugin, 'bin', file))
    const drift = check(f); expect(drift.status).toBe(1); expect(drift.stdout).toContain(`${file}: TARGET-MISSING`)
    expect(check(f, false).status).toBe(0)
    const refused = install(f, '--force'); expect(refused.status).toBe(1); expect(refused.stdout).toContain('TARGET-MISSING')
    const actual = run(f, file); expect(actual.status).toBe(2); expect(actual.stdout.toString()).toContain(`bin/${file}`)
    expect(actual.stderr).toEqual(actual.stdout)
  })
  it.each(FILES)('does not write absent %s when its canonical target is missing', (file) => {
    const f = fixture(); rmSync(join(f.plugin, 'bin', file))
    expect(install(f).status).toBe(1); expect(existsSync(join(f.scripts, file))).toBe(false)
    expect(check(f).status).toBe(0)
  })
  it('treats an entirely absent scripts set as no drift', () => { expect(check(fixture()).status).toBe(0) })
  it.each(FILES)('preserves argv, bytes, cwd, env, and exit codes through %s', (file) => {
    const f = fixture(); adopt(f)
    writeFileSync(join(f.plugin, 'bin', file), `import fs from 'node:fs'; fs.writeSync(1, Buffer.from([0,255,10])); fs.writeSync(2, Buffer.from([254,0,10])); fs.writeSync(1, JSON.stringify({argv:process.argv.slice(2), target:process.argv[1], cwd:process.cwd(), env:process.env.SHIM_SENTINEL})); process.exit(Number(process.argv[2]));`)
    f.env.SHIM_SENTINEL = 'verbatim value'
    for (const code of [0, 7]) {
      const args = [String(code), '', 'a b', '--quoted="x"', 'λ']
      const actual = run(f, file, args)
      const direct = spawnSync(process.execPath, [join(f.plugin, 'bin', file), ...args], { env: f.env, cwd: f.project })
      expect(actual.status).toBe(code); expect(actual.stdout).toEqual(direct.stdout); expect(actual.stderr).toEqual(direct.stderr)
    }
  })
  it.each(FILES)('fails visibly on both streams without a root for %s', (file) => {
    const f = fixture(); adopt(f); rmSync(join(f.config, 'plugins/installed_plugins.json'))
    const actual = run(f, file); expect(actual.status).toBe(2)
    expect(actual.stdout.toString()).toContain('WT_PLUGIN_ROOT'); expect(actual.stdout.toString()).toContain('installed_plugins.json')
    expect(actual.stdout.toString()).toContain('CLAUDE_PLUGIN_ROOT'); expect(actual.stderr).toEqual(actual.stdout)
    expect(actual.stdout.toString().split('\n')).toHaveLength(2)
  })
  it.each(FILES)('answers --help and -h without a root for %s', (file) => {
    const f = fixture(); adopt(f); rmSync(join(f.config, 'plugins/installed_plugins.json'))
    for (const flag of ['--help', '-h']) {
      const actual = run(f, file, [flag]); expect(actual.status).toBe(0)
      expect(actual.stdout.toString()).toContain('launcher for the installed workflow-toolbox plugin'); expect(actual.stdout.toString()).toContain('plugin not found')
    }
  })
  it('uses WT_PLUGIN_ROOT before applicable registry and loaded roots', () => {
    const f = fixture(); adopt(f)
    f.env.WT_PLUGIN_ROOT = fakePlugin(f.root, 'override'); f.env.CLAUDE_PLUGIN_ROOT = fakePlugin(f.root, 'loaded')
    expect(run(f, FILES[0]!).stdout.toString()).toBe('override'); expect(check(f).status).toBe(0)
  })
  it.each(['project', 'local'])('prefers applicable %s scope to user and ignores another project', (scope) => {
    const f = fixture(); adopt(f)
    const other = join(f.root, 'other'); mkdirSync(other)
    const wrong = fakePlugin(f.root, 'wrong'), preferred = fakePlugin(f.root, 'preferred')
    registry(f.config, [{ scope, projectPath: other, installPath: wrong }, { scope: 'user', installPath: f.plugin }, { scope, projectPath: f.project, installPath: preferred }])
    f.env.CLAUDE_PLUGIN_ROOT = fakePlugin(f.root, 'loaded')
    expect(run(f, FILES[0]!).stdout.toString()).toBe('preferred')
    delete f.env.CLAUDE_PROJECT_DIR
    expect(run(f, FILES[0]!).stdout.toString()).toBe('preferred')
  })
  it.each([true, false])('accepts single registry entries (wrapper=%s) before the loaded root', (wrapped) => {
    const f = fixture(); adopt(f); registry(f.config, { scope: 'user', installPath: f.plugin }, wrapped)
    f.env.CLAUDE_PLUGIN_ROOT = fakePlugin(f.root, 'loaded')
    expect(run(f, FILES[0]!).stdout.toString()).toBe('installed')
  })
  it('ignores foreign project entries but refuses the first applicable broken installation', () => {
    const f = fixture(); adopt(f)
    const invalid = fakePlugin(f.root, 'invalid', 'different-plugin'), directory = fakePlugin(f.root, 'directory')
    rmSync(join(directory, 'bin', FILES[0]!)); mkdirSync(join(directory, 'bin', FILES[0]!))
    registry(f.config, [{ scope: 'project', projectPath: join(f.root, 'missing'), installPath: f.plugin }, { scope: 'user', installPath: invalid }, { scope: 'user', installPath: directory }])
    f.env.CLAUDE_PLUGIN_ROOT = fakePlugin(f.root, 'loaded')
    for (const broken of [invalid, directory]) {
      registry(f.config, [{ scope: 'project', projectPath: join(f.root, 'missing'), installPath: f.plugin }, { scope: 'user', installPath: broken }, { scope: 'user', installPath: f.plugin }])
      const result = run(f, FILES[0]!)
      expect(result.status).toBe(2); expect(result.stdout.toString()).toContain(broken)
      expect(check(f).status).toBe(1)
    }
  })
  it('uses HOME/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    const f = fixture(); adopt(f)
    const config = join(f.env.HOME || f.env.USERPROFILE!, '.claude'); mkdirSync(join(config, 'plugins'), { recursive: true })
    registry(config, { scope: 'user', installPath: f.plugin }); delete f.env.CLAUDE_CONFIG_DIR
    expect(run(f, FILES[0]!).stdout.toString()).toBe('installed')
  })
  it('diffs the expected shim rather than the canonical implementation', () => {
    const f = fixture(); adopt(f); writeFileSync(join(f.scripts, FILES[0]!), readFileSync(join(f.scripts, FILES[0]!), 'utf8') + '// edit\n')
    const diff = spawnSync(process.execPath, [INSTALLER, '--set', 'scripts', '--diff', FILES[0]!, '--dir', f.scripts], { env: f.env, encoding: 'utf8' })
    expect(diff.status).toBe(0); expect(diff.stdout.split('=== SHIPPED').at(-1)).toContain('process.execve')
    expect(diff.stdout).not.toContain("process.stdout.write(\"installed\")")
  })
  it('fails safely before execve if the running Node executable cannot be checked', () => {
    const f = fixture(); adopt(f); const preload = join(f.root, 'unavailable-node.mjs')
    writeFileSync(preload, "import fs from 'node:fs'; const stat = fs.statSync; fs.statSync = (file, ...args) => { if (file === process.execPath) throw new Error('unavailable interpreter'); return stat(file, ...args) }")
    const actual = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(f.scripts, FILES[0]!)], { env: f.env })
    expect(actual.status).toBe(2); expect(actual.signal).toBe(null)
    expect(actual.stdout.toString()).toContain('Node executable not found'); expect(actual.stderr).toEqual(actual.stdout)
  })
  it('falls back to the loaded root when the registry is malformed', () => {
    const f = fixture(); adopt(f); writeFileSync(join(f.config, 'plugins/installed_plugins.json'), '{broken')
    f.env.CLAUDE_PLUGIN_ROOT = fakePlugin(f.root, 'loaded')
    expect(run(f, FILES[0]!).stdout.toString()).toBe('loaded')
  })
  it('reports fallback spawn errors synchronously on both streams', () => {
    const f = fixture(); adopt(f)
    const executable = join(f.root, 'not-an-executable'), preload = join(f.root, 'broken-spawn.mjs')
    writeFileSync(executable, 'not an interpreter', { mode: 0o644 })
    writeFileSync(preload, `import fs from 'node:fs'; fs.accessSync = () => {}; process.execve = undefined; process.execPath = ${JSON.stringify(executable)}`)
    const actual = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(f.scripts, FILES[0]!)], { env: f.env })
    expect(actual.status).toBe(2); expect(actual.stdout.toString()).toContain('could not start')
    expect(actual.stderr).toEqual(actual.stdout)
  })
})

function hook(f: ReturnType<typeof fixture>) {
  const result = spawnSync(process.execPath, [HOOK], { env: f.env, cwd: f.project, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.project }) })
  expect(result.status).toBe(0)
  return result.stdout
}
describe('scripts adoption notice', () => {
  it.each(FILES)('reports every drifting state of %s with actionable commands', (file) => {
    const f = fixture(); adopt(f); const target = join(f.scripts, file), original = readFileSync(target, 'utf8')
    for (const state of ['edited', 'stale', 'hand-authored', 'missing']) {
      writeFileSync(target, original)
      if (state === 'edited') writeFileSync(target, original + '// edit\n')
      if (state === 'stale') age(target)
      if (state === 'hand-authored') writeFileSync(target, '// manual\n')
      if (state === 'missing') rmSync(join(f.plugin, 'bin', file))
      const message = hook(f); expect(message).toContain(file); expect(message).toContain('--set scripts')
      expect(message).toContain('--fail-on-drift')
      if (state !== 'missing') expect(message).toContain('--install')
      if (state === 'missing') expect(message).toContain('TARGET-MISSING')
    }
  })
  it('is silent about current and absent scripts and ignores project scripts', () => {
    const f = fixture()
    const rules = spawnSync(process.execPath, [INSTALLER, '--set', 'rules', '--install', '--dir', join(f.config, 'rules/wt')], { env: f.env, cwd: f.project, encoding: 'utf8' })
    expect(rules.status, rules.stdout + rules.stderr).toBe(0)
    expect(hook(f)).toBe('')
    adopt(f); expect(hook(f)).toBe('')
    mkdirSync(join(f.project, '.claude/scripts'), { recursive: true }); writeFileSync(join(f.project, '.claude/scripts/wt-lane.mjs'), '// local\n')
    expect(hook(f)).toBe('')
  })
})

async function liveShim(f: ReturnType<typeof fixture>, preload?: string) {
  const child = spawn(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []), join(f.scripts, FILES[0]!)], { env: f.env, cwd: f.project, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const ready = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('shim readiness timed out')) }, 30_000)
    child.stdout.once('data', (data: Buffer) => { clearTimeout(timeout); resolve(Number(data.toString().trim())) })
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
  })
  const watchdog = setTimeout(() => { child.kill('SIGKILL'); try { process.kill(ready, 'SIGKILL') } catch { /* already reaped */ } }, 30_000)
  void closed.finally(() => clearTimeout(watchdog))
  return { child, closed, ready }
}
describe('shim process lifecycle', () => {
  it.skipIf(process.platform === 'win32' || typeof process.execve !== 'function')('execve keeps the pid and canonical argv[1], including after SIGKILL', async () => {
    const f = fixture(); adopt(f)
    writeFileSync(join(f.plugin, 'bin', FILES[0]!), 'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)')
    const { child, closed, ready } = await liveShim(f)
    try { expect(ready).toBe(child.pid) } finally {
      child.kill('SIGKILL')
      if (ready !== child.pid) { try { process.kill(ready, 'SIGKILL') } catch { /* already reaped */ } }
    }
    expect(await closed).toEqual({ code: null, signal: 'SIGKILL' })
    expect(() => process.kill(ready, 0)).toThrow()
  })
  it.each([0, 9])('fallback inherits output and preserves exit %s', (code) => {
    const f = fixture(); adopt(f); const preload = join(f.root, 'no-execve.mjs')
    writeFileSync(preload, 'process.execve = undefined')
    writeFileSync(join(f.plugin, 'bin', FILES[0]!), `process.stdout.write('fallback'); process.stderr.write('error'); process.exit(${code})`)
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(f.scripts, FILES[0]!)], { env: f.env })
    expect(result.status).toBe(code); expect(result.stdout.toString()).toBe('fallback'); expect(result.stderr.toString()).toBe('error')
  })
  it.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)('fallback forwards %s, reaps the child, and re-raises without its handlers', async (signal) => {
    const f = fixture(); adopt(f); const preload = join(f.root, 'no-execve.mjs')
    writeFileSync(preload, 'process.execve = undefined')
    writeFileSync(join(f.plugin, 'bin', FILES[0]!), 'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)')
    const { child, closed, ready } = await liveShim(f, preload)
    try { expect(ready).not.toBe(child.pid); child.kill(signal); expect(await closed).toEqual({ code: null, signal }) }
    finally { try { process.kill(ready, 'SIGKILL') } catch { /* already reaped */ } child.kill('SIGKILL') }
    expect(() => process.kill(ready, 0)).toThrow()
  })
  it.skipIf(process.platform === 'win32')('fallback faithfully reports a child that kills itself with SIGTERM', () => {
    const f = fixture(); adopt(f); const preload = join(f.root, 'no-execve.mjs')
    writeFileSync(preload, 'process.execve = undefined')
    writeFileSync(join(f.plugin, 'bin', FILES[0]!), "process.kill(process.pid, 'SIGTERM')")
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(f.scripts, FILES[0]!)], { env: f.env })
    expect(result.status).toBe(null); expect(result.signal).toBe('SIGTERM')
  })
})
