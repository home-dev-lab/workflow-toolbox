import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { resolveConsent } from '../../../../plugin/bin/lib/lane-consent-check-core.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const INSTALLER = join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const roots: string[] = []
const CHILD_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 10_000
const CONSENT_ACCOUNTS = [
  { name: 'settings true', settings: { env: { WT_EXECUTOR_LANE_CONSENT: 'true' } } },
  { name: 'settings false', settings: { env: { WT_EXECUTOR_LANE_CONSENT: 'false' } } },
  { name: 'settings absent', settings: {} },
  { name: 'userConfig true', settings: { pluginConfigs: { 'workflow-toolbox@fixture': { options: { executor_lane_consent: true } } } } },
  { name: 'userConfig false', settings: { pluginConfigs: { 'workflow-toolbox@fixture': { options: { executor_lane_consent: false } } } } },
]
const CONSENT_PROJECTS = [
  { name: 'project absent', settings: null },
  { name: 'project permits', settings: { env: { WT_EXECUTOR_LANE_CONSENT: 'true' } } },
  { name: 'project narrows', settings: { env: { WT_EXECUTOR_LANE_CONSENT: 'false' } } },
]
const CONSENT_MATRIX_TIMEOUT_MS = CHILD_TIMEOUT_MS * CONSENT_ACCOUNTS.length * CONSENT_PROJECTS.length + 15_000
// This one test chains four real spawns (installer, launcher, its own opencode/wt-suite-lock
// children, and a final help child) plus a 3s poll loop. Run 36239956154 timed it at >20s on a
// GitHub Actions Windows runner (whole file: 278s for 19 tests) — genuinely slow spawning, not a
// hang: the vitest default testTimeout (20_000ms, see toolkit/vitest.config.mts) has no margin
// left for that many sequential child processes on that host.
const SUITE_LOCK_CHILD_TIMEOUT_MS = CHILD_TIMEOUT_MS * 3 + 15_000

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function runChild(name: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = CHILD_TIMEOUT_MS) {
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  })
  if (result.error) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/).at(-1) || '<no output>'
    const dirIndex = args.indexOf('--dir')
    const log = dirIndex >= 0 ? join(args[dirIndex + 1]!, '.lane', 'run.log') : null
    let laneTail = '<unavailable>'
    try { laneTail = readFileSync(log!, 'utf8').trim().split(/\r?\n/).slice(-8).join(' | ') || '<empty>' } catch {}
    throw new Error(`${name} failed after ${timeoutMs}ms: ${result.error.message}; last output: ${output}; lane log tail: ${laneTail}`)
  }
  return result
}

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
  writeFileSync(join(bin, 'opencode.cmd'), `@echo off\r\n@"${process.execPath}" "%~dp0opencode-fixture.mjs" %*\r\n`)
  writeFileSync(join(bin, 'opencode-fixture.mjs'), `
import fs from 'node:fs'
const args = process.argv.slice(2)
if (args[0] === '--version') process.stdout.write('fixture-1\\n')
else if (args[0] === '--pure') process.stdout.write('[{"name":"workflow-toolbox-allowed-sentinel"}]\\n')
else if (args[0] === 'debug' && args[1] === 'skill') process.stdout.write('[]\\n')
else if (process.env.WT_ADOPTED_SEEN_FENCE) fs.writeFileSync(process.env.WT_ADOPTED_SEEN_FENCE, String(process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS) + '\\n')
else if (process.env.WT_ADOPTED_SEEN_LOCK) fs.writeFileSync(process.env.WT_ADOPTED_SEEN_LOCK, String(process.env.WT_SUITE_LOCK_CMD ?? 'unset'))
`)
  chmodSync(join(bin, 'opencode'), 0o755)
  writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
  cpSync(INSTALLER, join(pluginRoot, 'skills', 'adopt', 'scripts', 'install.mjs'))
  for (const file of ['lane-consent-check-core.mjs', 'lane-consent-gate-core.mjs', 'wt-lane-saturation-core.mjs', 'command-invocation.mjs', 'external-model-env.mjs', 'opencode-skill-fence.mjs', 'lane-skill-allowlist.mjs', 'lane-model-allowlist.mjs', 'plugin-options.mjs', 'plugin-data-dir.mjs', 'lane-supervisor-core.mjs', 'lane-integrate.mjs', 'resolved-binary.mjs']) {
    cpSync(join(REPO_ROOT, 'plugin', 'bin', 'lib', file), join(pluginRoot, 'bin', 'lib', file))
  }
  cpSync(join(REPO_ROOT, 'plugin', 'bin', 'lib', 'host'), join(pluginRoot, 'bin', 'lib', 'host'), { recursive: true })
  const launcher = readFileSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-lane.mjs'), 'utf8')
  writeFileSync(join(pluginRoot, 'bin', 'wt-lane.mjs'), transformSource ? transformSource(launcher) : launcher)
  cpSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-lane-wait.mjs'), join(pluginRoot, 'bin', 'wt-lane-wait.mjs'))
  // The suite-lock runner a lane's WT_SUITE_LOCK_CMD runs, with the CLI and library it imports.
  cpSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-suite-lock.mjs'), join(pluginRoot, 'bin', 'wt-suite-lock.mjs'))
  cpSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-suite-lock.cmd'), join(pluginRoot, 'bin', 'wt-suite-lock.cmd'))
  cpSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-suite-lock-run.mjs'), join(pluginRoot, 'bin', 'wt-suite-lock-run.mjs'))
  cpSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-suite-lock-run.cmd'), join(pluginRoot, 'bin', 'wt-suite-lock-run.cmd'))
  for (const file of ['suite-lock.mjs', 'artifact-server.mjs']) cpSync(join(REPO_ROOT, 'plugin', 'bin', 'lib', file), join(pluginRoot, 'bin', 'lib', file))
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'workflow-toolbox@fixture': [{ installPath: pluginRoot, version: '0.0.0' }] },
  }))
  // The launcher resolves consent solely through these fixture-owned locations. Do not
  // inherit a developer's config, home, or lane settings into the child process.
  // Launcher mechanics are exercised with a fake opencode the lane sandbox cannot see (by design);
  // the sandbox itself is locked in lane-sandbox.test.ts.
  const env: NodeJS.ProcessEnv = { WT_LANE_SANDBOX: 'off', CLAUDE_CONFIG_DIR: config, HOME: join(root, 'home'), PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, XDG_STATE_HOME: join(root, 'state') }
  if (install) {
    const result = runChild('adopt installer', [join(pluginRoot, 'skills', 'adopt', 'scripts', 'install.mjs'), '--set', 'scripts', '--install', '--dir', join(root, 'scripts')], env)
    expect(result.status, result.stderr).toBe(0)
  }
  return { root, config, project, pluginRoot, installed, env, installer: join(pluginRoot, 'skills', 'adopt', 'scripts', 'install.mjs') }
}

function launch(f: ReturnType<typeof fixture>, model = 'openai/gpt-5.6-luna', extra: string[] = []) {
  const brief = join(f.project, 'brief.md')
  writeFileSync(brief, '# brief\n')
  return runChild('adopted wt-lane launcher', [f.installed, '--dir', f.project, '--model', model, '--brief', brief, '--allow-no-git', ...extra], f.env)
}

describe('adopted wt-lane consent resolver', () => {
  it('names a timed-out child and includes its last output line', () => {
    expect(() => runChild(
      'fixture hanging child',
      ['--input-type=module', '--eval', "process.stdout.write('waiting\\n'); setTimeout(() => {}, 30_000)"],
      {},
      // Long enough for a cold node start on a loaded Windows runner to print its line (100 ms raced it:
      // run 36223779031 saw `<no output>`), still far below the child's own 30 s hang.
      5000,
    )).toThrow(/fixture hanging child failed after 5000ms:.*last output: waiting/)
  })

  it('includes the durable lane log tail when a launcher times out', () => {
    const project = mkdtempSync(join(tmpdir(), 'wt-adopted-timeout-')); roots.push(project)
    mkdirSync(join(project, '.lane'))
    writeFileSync(join(project, '.lane', 'run.log'), 'first\n2026-09-17T00:00:00.000Z stage=inspect-launcher-start\n')
    expect(() => runChild(
      'fixture launcher',
      ['--input-type=module', '--eval', 'setTimeout(() => {}, 30_000)', '--', '--dir', project],
      {},
      100,
    )).toThrow(/lane log tail: first \| 2026-09-17T00:00:00.000Z stage=inspect-launcher-start/)
  })

  for (const mode of ['--check', '--install']) {
    it(`${mode} refuses when the resolved plugin root is missing a launcher runtime module`, () => {
      const f = fixture(undefined, false)
      const missing = join(f.root, 'plugin', 'bin', 'lib', 'lane-model-allowlist.mjs')
      rmSync(missing)

      const result = runChild('adopt installer missing-module check', [f.installer, '--set', 'scripts', mode, '--dir', join(f.root, 'scripts')], f.env)

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

    const result = runChild('adopt installer preflight', [f.installer, '--set', 'scripts', '--install', '--dir', join(f.root, 'scripts')], f.env)

    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toBe(
      `adopt: wt-lane.mjs runtime module is missing from the resolved plugin root: ${missing} — update or reinstall workflow-toolbox, then retry.\n`,
    )
    expect(existsSync(f.installed)).toBe(false)
  })

  it('loads the same installed supervisor provider as the shipped launcher', () => {
    const f = fixture()
    const adopted = readFileSync(f.installed, 'utf8')
    expect(adopted).toContain("const supervisor = path.join(root, 'bin', 'lib', 'lane-supervisor-core.mjs')")
    expect(adopted).toContain('supervisorModule.inspectProcess')
    expect(adopted).toContain("const launcher = path.join(root, 'bin', 'wt-lane.mjs')")
    expect(adopted).toContain("const host = path.join(root, 'bin', 'lib', 'host', 'adapter.mjs')")
    expect(adopted).toContain('hostAdapter: hostModule.hostAdapter')
    expect(adopted).toContain('launcherModule.inspectStartedProcess')
    expect(adopted).not.toContain("from './lib/lane-supervisor-core.mjs'")
  })

  it('installs and starts the adopted launcher when the resolved plugin root has every runtime module', () => {
    const f = fixture(undefined, false)
    const install = runChild('adopt installer', [f.installer, '--set', 'scripts', '--install', '--dir', join(f.root, 'scripts')], f.env)
    expect(install.status, `${install.stdout}${install.stderr}`).toBe(0)

    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const started = launch(f)
    expect(started.status, started.stderr).toBe(0)
  })

  it.each([
    ['hostAdapter export', 'export const unrelated = {}\n'],
    ['readAvailableMemory capability', 'export const hostAdapter = {}\n'],
  ])('refuses an installed host adapter without the required %s', (_name, source) => {
    const f = fixture()
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    writeFileSync(join(f.pluginRoot, 'bin', 'lib', 'host', 'adapter.mjs'), source)

    const result = launch(f)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/installed workflow-toolbox plugin is (?:too old for this adopted launcher|older or incompatible)/)
    expect(result.stderr).not.toContain('is not a function')
  })

  it('preserves stale-brief refusal and acknowledgement evidence in the adopted launcher', () => {
    const f = fixture()
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    const brief = join(f.project, 'brief.md')
    writeFileSync(brief, '# adopted brief\n')
    const old = new Date(Date.now() - 15 * 60_000)
    utimesSync(brief, old, old)

    const refused = runChild('adopted wt-lane stale-brief refusal', [f.installed, '--dir', f.project, '--model', 'openai/gpt-5.6-luna', '--brief', brief, '--allow-no-git', '--max-brief-age', '600'], f.env)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('--acknowledge-stale-brief')
    const acknowledged = runChild('adopted wt-lane stale-brief acknowledgement', [f.installed, '--dir', f.project, '--model', 'openai/gpt-5.6-luna', '--brief', brief, '--allow-no-git', '--max-brief-age', '600', '--acknowledge-stale-brief'], f.env)
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
    for (const account of CONSENT_ACCOUNTS) {
      for (const project of CONSENT_PROJECTS) {
        const f = fixture()
        writeFileSync(join(f.config, 'settings.json'), JSON.stringify(account.settings))
        if (project.settings) writeFileSync(join(f.project, '.claude', 'settings.local.json'), JSON.stringify(project.settings))
        const expected = resolveConsent(f.project, f.env).outcome
        const actual = launch(f)
        expect(actual.status, `${account.name}; ${project.name}: ${actual.stderr}`).toBe(expected === 'true' ? 0 : 1)
      }
    }
  }, CONSENT_MATRIX_TIMEOUT_MS)

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
    const actual = runChild('adopted wt-lane help', [f.installed, '--help'], f.env)
    expect(actual.status, actual.stderr).toBe(0)
    expect(actual.stdout).toContain('Usage: node wt-lane.mjs')
  })

  it('forces the fence in an adopted launcher child', () => {
    const f = fixture()
    const bin = join(f.root, 'bin')
    const seen = join(f.root, 'seen-fence')
    if (process.platform !== 'win32') writeFileSync(join(bin, 'opencode'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'fixture-1\n'; exit 0; fi
if [ "$1" = "--pure" ]; then printf '[{"name":"workflow-toolbox-allowed-sentinel"}]\n'; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then printf '[]\n'; exit 0; fi
printf '%s\n' "$OPENCODE_DISABLE_CLAUDE_CODE_SKILLS" > ${JSON.stringify(seen)}
`)
    chmodSync(join(bin, 'opencode'), 0o755)
    f.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
    f.env.WT_ADOPTED_SEEN_FENCE = seen
    f.env.WT_EXTERNAL_MODEL_ENV_ALLOW = 'WT_ADOPTED_SEEN_FENCE'
    f.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = 'false'
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    expect(launch(f).status).toBe(0)
    const until = Date.now() + 3000
    while (!existsSync(seen) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    expect(readFileSync(seen, 'utf8')).toBe('true\n')
  })

  it('hands the adopted lane child an executable WT_SUITE_LOCK_CMD for the installed plugin suite-lock runner', () => {
    const f = fixture()
    const bin = join(f.root, 'bin')
    const seen = join(f.root, 'seen-lock')
    if (process.platform !== 'win32') writeFileSync(join(bin, 'opencode'), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'fixture-1\\n'; exit 0; fi
if [ "$1" = "--pure" ]; then printf '[{"name":"workflow-toolbox-allowed-sentinel"}]\\n'; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then printf '[]\\n'; exit 0; fi
printf '%s' "\${WT_SUITE_LOCK_CMD-unset}" > ${JSON.stringify(seen)}
`)
    chmodSync(join(bin, 'opencode'), 0o755)
    f.env.WT_ADOPTED_SEEN_LOCK = seen
    f.env.WT_EXTERNAL_MODEL_ENV_ALLOW = 'WT_ADOPTED_SEEN_LOCK'
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    expect(launch(f).status).toBe(0)
    const until = Date.now() + 3000
    while (!existsSync(seen) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    // Node resolves a module URL through symlinks, so the launcher reports the REAL path (macOS tmpdir is
    // /var -> /private/var); the expectation compares against the same real path.
    const cli = realpathSync(join(f.pluginRoot, 'bin', process.platform === 'win32' ? 'wt-suite-lock-run.cmd' : 'wt-suite-lock-run.mjs'))
    expect(readFileSync(seen, 'utf8')).toBe(cli)
    expect(existsSync(cli)).toBe(true)
  }, SUITE_LOCK_CHILD_TIMEOUT_MS)

  it('refuses to launch when the installed plugin root lacks the suite-lock CLI', () => {
    const f = fixture()
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
    rmSync(join(f.pluginRoot, 'bin', process.platform === 'win32' ? 'wt-suite-lock-run.cmd' : 'wt-suite-lock-run.mjs'))

    const result = launch(f)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('wt-lane: Refused: the installed workflow-toolbox plugin is older or incompatible')
  })

  it('refuses a launcher whose consent import fragment was reworded', () => {
    const f = fixture((source) => source.replace(
      "import { resolveConsent } from './lib/lane-consent-check-core.mjs'",
      "import { resolveConsent as resolveLaneConsent } from './lib/lane-consent-check-core.mjs'",
    ), false)
    const install = runChild('adopt installer transformed-source refusal', [f.installer, '--set', 'scripts', '--install', '--dir', join(f.root, 'scripts')], f.env)

    expect(install.status).not.toBe(0)
    expect(`${install.stdout}${install.stderr}`).toContain('launcher transformation expected exactly one occurrence')
    expect(`${install.stdout}${install.stderr}`).toContain('import { resolveConsent } from')
    expect(`${install.stdout}${install.stderr}`).toContain(join(f.root, 'plugin', 'bin', 'wt-lane.mjs'))
    expect(readFileSync(join(REPO_ROOT, 'plugin', 'bin', 'wt-lane.mjs'), 'utf8')).toContain("import { resolveConsent } from './lib/lane-consent-check-core.mjs'")
  })
})
