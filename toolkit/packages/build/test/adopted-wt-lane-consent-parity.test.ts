import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { resolveConsent } from '../../../../plugin/bin/lib/lane-consent-check-core.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const INSTALLER = join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function fixture(transformSource?: (source: string) => string, install = true) {
  const root = mkdtempSync(join(tmpdir(), 'wt-adopted-lane-consent-'))
  roots.push(root)
  const config = join(root, 'config')
  const project = join(root, 'project')
  const pluginRoot = join(root, 'plugin')
  const bin = join(root, 'bin')
  const installed = join(root, 'scripts', 'wt-lane.mjs')
  mkdirSync(join(config, 'plugins'), { recursive: true })
  mkdirSync(join(project, '.claude'), { recursive: true })
  mkdirSync(join(pluginRoot, 'bin', 'lib'), { recursive: true })
  mkdirSync(join(pluginRoot, 'hooks'), { recursive: true })
  mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true })
  mkdirSync(join(pluginRoot, 'skills', 'adopt', 'scripts'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(bin, 'opencode'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'fixture-1\n'; exit 0; fi
if [ "$1" = "--pure" ]; then printf '[{"name":"workflow-toolbox-allowed-sentinel"}]\n'; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then printf '[]\n'; exit 0; fi
exit 0
`)
  spawnSync('chmod', ['+x', join(bin, 'opencode')])
  writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
  cpSync(INSTALLER, join(pluginRoot, 'skills', 'adopt', 'scripts', 'install.mjs'))
  for (const file of ['lane-consent-check-core.mjs', 'lane-consent-gate-core.mjs', 'wt-lane-saturation-core.mjs', 'command-invocation.mjs', 'opencode-skill-fence.mjs', 'lane-skill-allowlist.mjs', 'lane-model-allowlist.mjs', 'plugin-options.mjs', 'plugin-data-dir.mjs', 'lane-supervisor-core.mjs', 'resolved-binary.mjs']) {
    cpSync(join(REPO_ROOT, 'plugin', 'bin', 'lib', file), join(pluginRoot, 'bin', 'lib', file))
  }
  const launcher = readFileSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-lane.mjs'), 'utf8')
  writeFileSync(join(pluginRoot, 'bin', 'wt-lane.mjs'), transformSource ? transformSource(launcher) : launcher)
  cpSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-lane-wait.mjs'), join(pluginRoot, 'bin', 'wt-lane-wait.mjs'))
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'workflow-toolbox@fixture': [{ installPath: pluginRoot, version: '0.0.0' }] },
  }))
  // The launcher resolves consent solely through these fixture-owned locations. Do not
  // inherit a developer's config, home, or lane settings into the child process.
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: config, HOME: join(root, 'home'), PATH: `${bin}:/usr/bin:/bin`, XDG_STATE_HOME: join(root, 'state') }
  if (install) {
    const result = spawnSync(process.execPath, [join(pluginRoot, 'skills', 'adopt', 'scripts', 'install.mjs'), '--set', 'scripts', '--install', '--dir', join(root, 'scripts')], { encoding: 'utf8', env })
    expect(result.status, result.stderr).toBe(0)
  }
  return { root, config, project, installed, env, installer: join(pluginRoot, 'skills', 'adopt', 'scripts', 'install.mjs') }
}

function launch(f: ReturnType<typeof fixture>, model = 'openai/gpt-5.6-luna', extra: string[] = []) {
  const brief = join(f.project, 'brief.md')
  writeFileSync(brief, '# brief\n')
  return spawnSync(process.execPath, [f.installed, '--dir', f.project, '--model', model, '--brief', brief, '--allow-no-git', ...extra], { encoding: 'utf8', env: f.env })
}

describe('adopted wt-lane consent resolver', () => {
  for (const mode of ['--check', '--install']) {
    it(`${mode} refuses when the resolved plugin root is missing a launcher runtime module`, () => {
      const f = fixture(undefined, false)
      const missing = join(f.root, 'plugin', 'bin', 'lib', 'lane-model-allowlist.mjs')
      rmSync(missing)

      const result = spawnSync(
        process.execPath,
        [f.installer, '--set', 'scripts', mode, '--dir', join(f.root, 'scripts')],
        { encoding: 'utf8', env: f.env },
      )

      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toBe(
        `adopt: wt-lane.mjs runtime module is missing from the resolved plugin root: ${missing} — update or reinstall workflow-toolbox, then retry.\n`,
      )
      expect(existsSync(f.installed)).toBe(false)
    })
  }

  it('preflights the shared plugin-option resolver derived from the adopted loader', () => {
    const f = fixture(undefined, false)
    const missing = join(f.root, 'plugin', 'bin', 'lib', 'plugin-options.mjs')
    rmSync(missing)

    const result = spawnSync(
      process.execPath,
      [f.installer, '--set', 'scripts', '--install', '--dir', join(f.root, 'scripts')],
      { encoding: 'utf8', env: f.env },
    )

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toBe(
      `adopt: wt-lane.mjs runtime module is missing from the resolved plugin root: ${missing} — update or reinstall workflow-toolbox, then retry.\n`,
    )
    expect(existsSync(f.installed)).toBe(false)
  })

  it('installs and starts the adopted launcher when the resolved plugin root has every runtime module', () => {
    const f = fixture(undefined, false)
    const install = spawnSync(
      process.execPath,
      [f.installer, '--set', 'scripts', '--install', '--dir', join(f.root, 'scripts')],
      { encoding: 'utf8', env: f.env },
    )
    expect(install.status, `${install.stdout}${install.stderr}`).toBe(0)

    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const started = launch(f)
    expect(started.status, started.stderr).toBe(0)
  })

  it('preserves stale-brief refusal and acknowledgement evidence in the adopted launcher', () => {
    const f = fixture()
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const brief = join(f.project, 'brief.md')
    writeFileSync(brief, '# adopted brief\n')
    const old = new Date(Date.now() - 15 * 60_000)
    utimesSync(brief, old, old)

    const refused = spawnSync(process.execPath, [f.installed, '--dir', f.project, '--model', 'openai/gpt-5.6-luna', '--brief', brief, '--allow-no-git', '--max-brief-age', '600'], { encoding: 'utf8', env: f.env })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('--acknowledge-stale-brief')
    const acknowledged = spawnSync(process.execPath, [f.installed, '--dir', f.project, '--model', 'openai/gpt-5.6-luna', '--brief', brief, '--allow-no-git', '--max-brief-age', '600', '--acknowledge-stale-brief'], { encoding: 'utf8', env: f.env })
    expect(acknowledged.status, acknowledged.stderr).toBe(0)
    expect(acknowledged.stdout).toMatch(/brief_sha256=[0-9a-f]{64}\n/)
  })

  it('refuses an unlisted model through the plugin runtime before the adopted launcher spawns', () => {
    const f = fixture()
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const refused = launch(f, 'google/gemini-3.6-flash')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('is not in the lane model allow-list')
  })

  it('uses the plugin model option before the env fallback in the adopted launcher', () => {
    const f = fixture()
    f.env.WT_LANE_MODELS = 'env/model'
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({
      pluginConfigs: { 'workflow-toolbox@fixture': { options: { executor_lane_consent: true, lane_models: 'openai/gpt-5.6-luna' } } },
    }))
    expect(launch(f).status).toBe(0)
  })

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

  it('forces the fence in an adopted launcher child', () => {
    const f = fixture()
    const bin = join(f.root, 'bin')
    const seen = join(f.root, 'seen-fence')
    writeFileSync(join(bin, 'opencode'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'fixture-1\n'; exit 0; fi
if [ "$1" = "--pure" ]; then printf '[{"name":"workflow-toolbox-allowed-sentinel"}]\n'; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then printf '[]\n'; exit 0; fi
printf '%s\n' "$OPENCODE_DISABLE_CLAUDE_CODE_SKILLS" > ${JSON.stringify(seen)}
`)
    spawnSync('chmod', ['+x', join(bin, 'opencode')])
    f.env.PATH = `${bin}:/usr/bin:/bin`
    f.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = 'false'
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    expect(launch(f).status).toBe(0)
    const until = Date.now() + 3000
    while (!existsSync(seen) && Date.now() < until) spawnSync('sleep', ['0.05'])
    expect(readFileSync(seen, 'utf8')).toBe('true\n')
  })

  it('refuses a launcher whose consent import fragment was reworded', () => {
    const f = fixture((source) => source.replace(
      "import { resolveConsent } from './lib/lane-consent-check-core.mjs'",
      "import { resolveConsent as resolveLaneConsent } from './lib/lane-consent-check-core.mjs'",
    ), false)
    const install = spawnSync(process.execPath, [f.installer, '--set', 'scripts', '--install', '--dir', join(f.root, 'scripts')], { encoding: 'utf8', env: f.env })

    expect(install.status).not.toBe(0)
    expect(`${install.stdout}${install.stderr}`).toContain('launcher transformation expected exactly one occurrence')
    expect(`${install.stdout}${install.stderr}`).toContain('import { resolveConsent } from')
    expect(`${install.stdout}${install.stderr}`).toContain(join(f.root, 'plugin', 'bin', 'wt-lane.mjs'))
    expect(readFileSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-lane.mjs'), 'utf8')).toContain("import { resolveConsent } from './lib/lane-consent-check-core.mjs'")
  })
})
