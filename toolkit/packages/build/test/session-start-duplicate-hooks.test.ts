import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_ROOT = join(REPO_ROOT, 'plugin')
const HOOK = join(PLUGIN_ROOT, 'bin/wt-session-start-registry-hook.mjs')
const MANIFEST = readFileSync(join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'wt-double-registration-'))
  roots.push(root)
  const configDir = join(root, '.claude')
  const installedRoot = join(root, 'cache', 'workflow-toolbox', '0.182.0')
  mkdirSync(join(configDir, 'plugins'), { recursive: true })
  mkdirSync(join(installedRoot, '.claude-plugin'), { recursive: true })
  writeFileSync(join(installedRoot, '.claude-plugin/plugin.json'), MANIFEST)
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

function run(configDir: string, pluginRoot: string, root: string) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'session-double', cwd: root }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      HOME: root,
      WT_OUTBOUND_GUARD_DIR: join(root, 'outbound'),
    },
  })
}

describe('SessionStart duplicate loaded-plugin hook warning', () => {
  it('warns once from the dev root, names both roots and duplicated hooks, and gives the remedy', () => {
    const { configDir, installedRoot, root } = fixture()

    const dev = run(configDir, PLUGIN_ROOT, root)
    const marketplace = run(configDir, installedRoot, root)

    expect(dev.status).toBe(0)
    expect(dev.stdout).toContain('DUPLICATE HOOK REGISTRATION')
    expect(dev.stdout).toContain(PLUGIN_ROOT)
    expect(dev.stdout).toContain(installedRoot)
    expect(dev.stdout).toContain('PreToolUse: bin/wt-main-guard-hook.mjs')
    expect(dev.stdout).toContain('Disable one copy')
    expect(marketplace.stdout).not.toContain('DUPLICATE HOOK REGISTRATION')
  })

  it('does not warn for an installed copy disabled in settings', () => {
    const { configDir, root } = fixture(false)
    expect(run(configDir, PLUGIN_ROOT, root).stdout).not.toContain('DUPLICATE HOOK REGISTRATION')
  })
})
