import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_ROOT = join(REPO_ROOT, 'plugin')
const HOOK = join(PLUGIN_ROOT, 'bin/wt-session-start-registry-hook.mjs')
const MANIFEST = readFileSync(join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8')
// The project directory is a sibling of the config dir, never the same directory.
const projectOf = (root: string) => join(root, 'proj')
const KEY = 'workflow-toolbox@workflow-toolbox'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(enabled = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt double registration-')))
  roots.push(root)
  const configDir = join(root, '.claude')
  const installedRoot = join(root, 'cache', 'workflow-toolbox', '0.182.0')
  mkdirSync(join(configDir, 'plugins'), { recursive: true })
  mkdirSync(join(root, 'proj'), { recursive: true })
  mkdirSync(join(installedRoot, '.claude-plugin'), { recursive: true })
  writeFileSync(join(installedRoot, '.claude-plugin/plugin.json'), JSON.stringify({ ...JSON.parse(MANIFEST), version: '0.182.0' }))
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'workflow-toolbox@workflow-toolbox': enabled },
  }))
  writeFileSync(join(configDir, 'plugins/installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'workflow-toolbox@workflow-toolbox': [{
        scope: 'user',
        installPath: installedRoot,
        version: '0.182.0',
      }],
    },
  }))
  return { configDir, installedRoot, root }
}

/** Another installed copy of the plugin under the fixture root, at `version`. */
function installCopy(root: string, dir: string, version: string) {
  const installPath = join(root, 'cache', dir)
  mkdirSync(join(installPath, '.claude-plugin'), { recursive: true })
  writeFileSync(join(installPath, '.claude-plugin/plugin.json'), JSON.stringify({ ...JSON.parse(MANIFEST), version }))
  return installPath
}

function writeRegistry(configDir: string, entries: Array<Record<string, unknown>>) {
  writeFileSync(join(configDir, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [KEY]: entries } }))
}

function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

const hookEntry = (event = 'SessionStart') => ({ [event]: [{ hooks: [{ type: 'command', command: `node "${HOOK}"` }] }] })

function run(configDir: string, pluginRoot: string | undefined, root: string, pluginId?: string,
  { hook = HOOK, event = 'SessionStart' as string | null } = {}) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ ...(event ? { hook_event_name: event } : {}), session_id: 'session-double', cwd: projectOf(root) }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_DATA: pluginId ? join(configDir, 'plugins', 'data', pluginId.replace(/[^A-Za-z0-9_-]/g, '-')) : undefined,
      HOME: root,
      WT_OUTBOUND_GUARD_DIR: join(root, 'outbound'),
    },
  })
}

describe('SessionStart plugin-root state', () => {
  it('T1: an inline plugin-dir replacement runs once and is not a duplicate', () => {
    const { configDir, installedRoot, root } = fixture()
    const dev = run(configDir, PLUGIN_ROOT, root, 'workflow-toolbox@inline')
    expect(dev.status).toBe(0)
    expect(dev.stdout).not.toContain('DUPLICATE HOOK REGISTRATION')
    expect(dev.stdout).not.toContain('STALE PLUGIN VERSION')
    expect(dev.stdout).not.toContain(installedRoot)
  })

  it('T2: a loaded installed identity at an old root is stale, not double-loaded', () => {
    const { configDir, installedRoot, root } = fixture()
    const dev = run(configDir, PLUGIN_ROOT, root, 'workflow-toolbox@workflow-toolbox')
    expect(dev.status).toBe(0)
    expect(dev.stdout).toContain('STALE PLUGIN VERSION')
    expect(dev.stdout).toContain(PLUGIN_ROOT)
    expect(dev.stdout).toContain(installedRoot)
    expect(dev.stdout).toContain(`v${JSON.parse(MANIFEST).version}`)
    expect(dev.stdout).toContain('v0.182.0')
    expect(dev.stdout).toContain('a different version is installed')
    expect(dev.stdout).toContain('/reload-plugins')
    expect(dev.stdout).toContain('monitors')
    expect(dev.stdout).toContain('MCP servers')
    expect(dev.stdout).not.toContain('DUPLICATE')
    expect(dev.stdout).not.toContain('twice')
  })

  it('T3: a settings-registered hook shared with the enabled installed manifest is a real double', () => {
    const { configDir, installedRoot, root } = fixture()
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'workflow-toolbox@workflow-toolbox': true },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node "${HOOK}"` }] }] },
    }))
    // No payload event: only the settings-file parser can produce this finding.
    const result = run(configDir, undefined, root, undefined, { event: null })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DUPLICATE HOOK REGISTRATION')
    expect(result.stdout).toContain(PLUGIN_ROOT)
    expect(result.stdout).toContain(installedRoot)
    expect(result.stdout).toContain('SessionStart: bin/wt-session-start-registry-hook.mjs')
    expect(result.stdout).not.toContain('PreToolUse: bin/wt-main-guard-hook.mjs')
    expect(result.stdout).toContain('claude plugin disable workflow-toolbox@workflow-toolbox')
  })

  it('T4: an unregistered settings invocation and an unknown plugin identity make no root claim', () => {
    const { configDir, root } = fixture()
    expect(run(configDir, undefined, root, undefined, { event: null }).stdout).not.toContain('DUPLICATE HOOK REGISTRATION')
    const unknown = run(configDir, PLUGIN_ROOT, root)
    expect(unknown.stdout).not.toContain('STALE PLUGIN VERSION')
    expect(unknown.stdout).not.toContain('DUPLICATE HOOK REGISTRATION')
  })

  it('a harness-invoked hook without a plugin root is a double even when no readable settings file declares it', () => {
    // A --settings argument or managed settings registers the hook where this process cannot read it.
    const { configDir, installedRoot, root } = fixture()
    const result = run(configDir, undefined, root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DUPLICATE HOOK REGISTRATION')
    expect(result.stdout).toContain(installedRoot)
    expect(result.stdout).toContain('SessionStart: bin/wt-session-start-registry-hook.mjs')
    expect(result.stdout).toContain('claude plugin disable workflow-toolbox@workflow-toolbox')
    expect(run(configDir, undefined, root, undefined, { event: 'PreToolUse' }).stdout).not.toContain('DUPLICATE HOOK REGISTRATION')
  })

  it('a settings entry pointing into the enabled installed root itself is a double', () => {
    const { configDir, installedRoot, root } = fixture()
    cpSync(join(PLUGIN_ROOT, 'bin'), join(installedRoot, 'bin'), { recursive: true })
    const installedHook = join(installedRoot, 'bin/wt-session-start-registry-hook.mjs')
    const result = run(configDir, undefined, root, undefined, { hook: installedHook })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DUPLICATE HOOK REGISTRATION')
    expect(result.stdout).toContain('SessionStart: bin/wt-session-start-registry-hook.mjs')
  })

  it('a settings hook in the project local settings is detected only at the same event', () => {
    const { configDir, root } = fixture()
    mkdirSync(join(projectOf(root), '.claude'), { recursive: true })
    writeFileSync(join(projectOf(root), '.claude', 'settings.local.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `node '${HOOK}'` }] }] },
    }))
    expect(run(configDir, undefined, root, undefined, { event: null }).stdout).toContain('DUPLICATE HOOK REGISTRATION')
    writeFileSync(join(projectOf(root), '.claude', 'settings.local.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `node '${HOOK}'` }] }] },
    }))
    // Without a payload event only the settings files count, so the PreToolUse entry is not read as SessionStart.
    expect(run(configDir, undefined, root, undefined, { event: null }).stdout).not.toContain('DUPLICATE HOOK REGISTRATION')
  })

  it('does not warn for an installed copy disabled in settings, for either kind of finding', () => {
    const { configDir, root } = fixture(false)
    // Stale kind: the running root differs in version from the disabled installed copy.
    const stale = run(configDir, PLUGIN_ROOT, root, KEY)
    expect(stale.status).toBe(0)
    expect(stale.stdout).not.toContain('STALE PLUGIN VERSION')
    // Duplicate kind: a settings-registered hook with a payload event.
    writeJson(join(configDir, 'settings.json'), { enabledPlugins: { [KEY]: false }, hooks: hookEntry() })
    const duplicate = run(configDir, undefined, root)
    expect(duplicate.status).toBe(0)
    expect(duplicate.stdout).not.toContain('DUPLICATE HOOK REGISTRATION')
  })

  it('an installed copy at the SAME version as the running manifest is not stale', () => {
    const { configDir, root } = fixture()
    const same = installCopy(root, 'same', JSON.parse(MANIFEST).version)
    writeRegistry(configDir, [{ scope: 'user', installPath: same, version: JSON.parse(MANIFEST).version }])
    const result = run(configDir, PLUGIN_ROOT, root, KEY)
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('STALE PLUGIN VERSION')
  })

  it('F1: a local-scope entry for another project does not make this session stale', () => {
    const { configDir, installedRoot, root } = fixture()
    const current = installCopy(root, 'current', JSON.parse(MANIFEST).version)
    writeRegistry(configDir, [
      { scope: 'user', installPath: current, version: JSON.parse(MANIFEST).version },
      { scope: 'local', projectPath: join(root, 'another-project'), installPath: installedRoot, version: '0.182.0' },
    ])
    const result = run(configDir, PLUGIN_ROOT, root, KEY)
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('STALE PLUGIN VERSION')
  })

  it('F1 control: a local-scope entry for THIS project at another version is stale', () => {
    const { configDir, installedRoot, root } = fixture()
    writeRegistry(configDir, [{ scope: 'local', projectPath: projectOf(root), installPath: installedRoot, version: '0.182.0' }])
    const result = run(configDir, PLUGIN_ROOT, root, KEY)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('STALE PLUGIN VERSION')
    expect(result.stdout).toContain(installedRoot)
  })

  it('F2: project settings.local.json disabling the plugin outranks user settings', () => {
    const { configDir, root } = fixture()
    writeJson(join(configDir, 'settings.json'), { enabledPlugins: { [KEY]: true }, hooks: hookEntry() })
    writeJson(join(projectOf(root), '.claude', 'settings.local.json'), { enabledPlugins: { [KEY]: false } })
    const result = run(configDir, undefined, root, undefined, { event: null })
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('DUPLICATE HOOK REGISTRATION')
  })

  it('F2: a plugin enabled only in the project settings is still checked for staleness', () => {
    const { configDir, root } = fixture()
    writeJson(join(configDir, 'settings.json'), {})
    writeJson(join(projectOf(root), '.claude', 'settings.json'), { enabledPlugins: { [KEY]: true } })
    const result = run(configDir, PLUGIN_ROOT, root, KEY)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('STALE PLUGIN VERSION')
  })

  it('F3: a hook only in <configDir>/settings.local.json is not a documented source', () => {
    const { configDir, root } = fixture()
    writeJson(join(configDir, 'settings.local.json'), { hooks: hookEntry() })
    const result = run(configDir, undefined, root, undefined, { event: null })
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('DUPLICATE HOOK REGISTRATION')
  })
})
