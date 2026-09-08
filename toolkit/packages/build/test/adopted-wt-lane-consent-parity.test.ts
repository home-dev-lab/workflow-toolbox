import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { resolveConsent } from '../../../../plugin/bin/lib/lane-consent-check-core.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const INSTALLER = join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-adopted-lane-consent-'))
  roots.push(root)
  const config = join(root, 'config')
  const project = join(root, 'project')
  const pluginRoot = join(root, 'plugin')
  const installed = join(root, 'scripts', 'wt-lane.mjs')
  mkdirSync(join(config, 'plugins'), { recursive: true })
  mkdirSync(join(project, '.claude'), { recursive: true })
  mkdirSync(join(pluginRoot, 'bin', 'lib'), { recursive: true })
  for (const file of ['lane-consent-check-core.mjs', 'lane-consent-gate-core.mjs', 'wt-lane-saturation-core.mjs', 'command-invocation.mjs']) {
    cpSync(join(REPO_ROOT, 'plugin', 'bin', 'lib', file), join(pluginRoot, 'bin', 'lib', file))
  }
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'workflow-toolbox@fixture': [{ installPath: pluginRoot, version: '0.0.0' }] },
  }))
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: config, HOME: join(root, 'home') }
  delete env.CLAUDE_PLUGIN_ROOT
  delete env.WT_PLUGIN_ROOT
  const install = spawnSync(process.execPath, [INSTALLER, '--set', 'scripts', '--install', '--dir', join(root, 'scripts')], { encoding: 'utf8', env })
  expect(install.status, install.stderr).toBe(0)
  return { config, project, installed, env }
}

function launch(f: ReturnType<typeof fixture>) {
  const brief = join(f.project, 'brief.md')
  writeFileSync(brief, '# brief\n')
  return spawnSync(process.execPath, [f.installed, '--dir', f.project, '--model', 'test/model', '--brief', brief], { encoding: 'utf8', env: f.env })
}

describe('adopted wt-lane consent resolver', () => {
  it('uses the real resolver for account and project consent fixtures', () => {
    const accounts = [
      { name: 'settings true', settings: { env: { WT_EXECUTOR_LANE_CONSENT: 'true' } } },
      { name: 'settings false', settings: { env: { WT_EXECUTOR_LANE_CONSENT: 'false' } } },
      { name: 'settings absent', settings: {} },
      { name: 'userConfig true', settings: { pluginConfigs: { 'workflow-toolbox@fixture': { options: { executor_lane_consent: true } } } } },
      { name: 'userConfig false', settings: { pluginConfigs: { 'workflow-toolbox@fixture': { options: { executor_lane_consent: false } } } } },
    ]
    const projects = [
      { name: 'project absent', settings: null },
      { name: 'project permits', settings: { env: { WT_EXECUTOR_LANE_CONSENT: 'true' } } },
      { name: 'project narrows', settings: { env: { WT_EXECUTOR_LANE_CONSENT: 'false' } } },
    ]

    for (const account of accounts) {
      for (const project of projects) {
        const f = fixture()
        writeFileSync(join(f.config, 'settings.json'), JSON.stringify(account.settings))
        if (project.settings) writeFileSync(join(f.project, '.claude', 'settings.local.json'), JSON.stringify(project.settings))
        const expected = resolveConsent(f.project, f.env).outcome
        const actual = launch(f)
        expect(actual.status, `${account.name}; ${project.name}: ${actual.stderr}`).toBe(expected === 'true' ? 0 : 1)
      }
    }
  })

  it('refuses when no installed plugin root can provide the real resolver', () => {
    const f = fixture()
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    rmSync(join(f.config, 'plugins', 'installed_plugins.json'))
    const actual = launch(f)
    expect(actual.status).toBe(1)
    expect(actual.stderr).toBe('wt-lane: Refused: could not locate workflow-toolbox plugin root via CLAUDE_PLUGIN_ROOT, WT_PLUGIN_ROOT, or plugins/installed_plugins.json; refusing to launch.\n')
  })

  it('prints help without an installed plugin', () => {
    const f = fixture()
    rmSync(join(f.config, 'plugins', 'installed_plugins.json'))
    const actual = spawnSync(process.execPath, [f.installed, '--help'], { encoding: 'utf8', env: f.env })
    expect(actual.status, actual.stderr).toBe(0)
    expect(actual.stdout).toContain('Usage: node wt-lane.mjs')
  })
})
