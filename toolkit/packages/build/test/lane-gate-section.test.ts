import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error runtime .mjs launcher
import { BRIEF_GATE_RUNNABLES, briefEvidenceLines, briefGateSectionRefusal, parse } from '../../../../plugin/bin/wt-lane.mjs'
// @ts-expect-error runtime .mjs host-state helper
import { laneHostDir } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'

const launcher = fileURLToPath(new URL('./fixtures/launcher-counter/wt-lane.mjs', import.meta.url))
// Mutation proofs may point at an isolated copy; normal checkouts import the installed launcher and spawn it
// through the counter fixture, like every other CLI test here.
const verifyDepsModule = process.env.WT_LANE_VERIFY_DEPS_MODULE
const verifyDepsLauncher = verifyDepsModule ?? launcher
const { laneWorkerEnv } = await import(pathToFileURL(verifyDepsModule ?? fileURLToPath(new URL('../../../../plugin/bin/wt-lane.mjs', import.meta.url))).href)
const roots: { root: string, dir: string }[] = []
afterEach(() => {
  for (const { root, dir } of roots.splice(0)) {
    rmSync(laneHostDir(dir), { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

describe('brief gate section: missing and runnable', () => {
  it.each([
    '# Brief\npnpm test',
    '## Gates\nRemember to check things.',
    '## Gates pnpm test\nNo runnable line below the heading.',
    '### Gates\npnpm test',
    '## Running gates: never in the foreground\ngate-chain.sh typecheck lint quality test',
    '## Gates\nNo command here.\n## Implementation\npnpm test',
    '## Gates\n## Other\n### Gates\npnpm test',
  ])('refuses missing or empty level-two sections: %s', (text) => {
    expect(briefGateSectionRefusal(text)).toContain('has no gate section')
  })

  it.each(BRIEF_GATE_RUNNABLES as readonly string[])('accepts the declared runnable %s', (command: string) => {
    expect(briefGateSectionRefusal(`## Gates\nRun ${command}\n`)).toBeNull()
  })

  it.each(
    (BRIEF_GATE_RUNNABLES as readonly string[]).filter((command) => /^pnpm [a-z]/.test(command) && !command.startsWith('pnpm exec ')),
  )('accepts the pnpm run form of %s', (command: string) => {
    const runForm = command.replace(/^pnpm /, 'pnpm run ')
    expect(briefGateSectionRefusal(`## Gates\nRun ${runForm}\n`)).toBeNull()
    expect(briefGateSectionRefusal(`## Gates\nRun \`${runForm.replace(' run ', '  run\t')}\`\n`)).toBeNull()
  })

  it.each([
    'pnpm run quality:static',
    'pnpm run typecheck',
    'pnpm exec vitest run tests/mcp-capture',
    'pnpm\texec  vitest\trun tests/mcp-capture',
  ])('accepts the context-mode rule gate line %j on its own', (line) => {
    expect(briefGateSectionRefusal(`## Gates\n- ${line}\n`)).toBeNull()
  })
})

describe('brief gate section: pnpm forms and spelling', () => {
  it('accepts the reported brief whose Gates list only pnpm run and pnpm exec vitest forms', () => {
    const brief = '# Brief\n\n## Gates\nRun by exit code each:\n- pnpm run quality:static\n- pnpm run typecheck\n- pnpm exec vitest run tests/mcp-capture\n'
    expect(briefGateSectionRefusal(brief, { brief: 'brief.md' })).toBeNull()
  })

  it.each([
    '## Gates\npnpm run build',
    '## Gates\npnpm run',
    '## Gates\npnpm exec tsc --noEmit',
    '## Gates\npnpm runtypecheck',
    '## Notes\npnpm run typecheck\n## Gates\nNothing runnable.',
    '## Notes\npnpm exec vitest run x\n## Gates\nNothing runnable.',
    '## Gates\npnpm run exec vitest run tests/mcp-capture',
    '## Gates\npnpm exec vitest --help',
    '## Gates\npnpm exec vitest --version',
    '## Gates\npnpm exec vitest-not-a-runner',
  ])('still refuses a Gates section with no recognised runnable: %j', (text) => {
    expect(briefGateSectionRefusal(text)).toContain('has no gate section')
  })

  it.each(['## gAtEs — queue', '##\tGates', '## Gates — keep the lock queue short'])('accepts heading spelling %s', (heading) => {
    expect(briefGateSectionRefusal(`${heading}\r\n### Checks\r\npnpm test\r\n`)).toBeNull()
  })

  it('accepts a later valid Gates section after an empty one', () => {
    expect(briefGateSectionRefusal('## Gates\nEmpty.\n## Notes\nText.\n## Gates\npnpm test')).toBeNull()
  })

  it('accepts Gates after another section', () => {
    expect(briefGateSectionRefusal('## Implementation\nWrite code.\n## Gates\npnpm test')).toBeNull()
  })
})

describe('brief gate section: exemptions and refusal text', () => {
  it.each([{ owner: 'pilot' }, { role: 'critic' }, { role: 'review' }, { role: 'refutation' }, { noGateSectionReason: 'research only' }])('exempts %j', (options) => {
    expect(briefGateSectionRefusal('# Read only', options)).toBeNull()
  })

  it.each([{ owner: 'session' }, { role: 'code' }, { role: 'pilot' }, { noGateSectionReason: '' }, { noGateSectionReason: ' \t' }])('does not exempt %j', (options) => {
    expect(briefGateSectionRefusal('# Work', options)).toContain('has no gate section')
  })

  it('provides a pasteable command and the shared runnable list without echoing content', () => {
    const refusal = briefGateSectionRefusal('private brief body', { brief: 'brief.md' })
    expect(refusal).toMatch(/^wt-lane: Refused: brief brief.md has no gate section/)
    expect(refusal).toContain('## Gates\nRun detached, by exit code each:')
    for (const command of BRIEF_GATE_RUNNABLES) expect(refusal).toContain(command)
    expect(refusal).toContain('each pnpm script also as pnpm run <script>')
    expect(refusal).toContain('--owner pilot; --role critic|review|refutation; --no-gate-section <reason>')
    expect(refusal).not.toContain('private brief body')
  })
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lane-gate-section-')))
  const dir = join(root, 'worktree')
  mkdirSync(dir)
  roots.push({ root, dir })
  const brief = join(dir, 'brief.md')
  writeFileSync(brief, '# Work\nWrite the feature.\n')
  return { root, dir, brief, args: ['--dir', dir, '--brief', brief, '--model', 'openai/example', '--allow-no-git'] }
}

describe('lane pnpm dependency verification', () => {
  it('defaults the environment handed to the worker without mutating the caller', () => {
    const env = { PATH: 'tools', npm_config_verify_deps_before_run: 'false' }
    expect(laneWorkerEnv(env, null).pnpm_config_verify_deps_before_run).toBe('false')
    expect(env).not.toHaveProperty('pnpm_config_verify_deps_before_run')
    expect(laneWorkerEnv({ PATH: 'tools' }, null)).toEqual({ PATH: 'tools', pnpm_config_verify_deps_before_run: 'false', WT_SUITE_LOCK_CONTEXT: 'lane', WT_SUITE_LOCK_PRIORITY: 'P2' })
  })

  it.each(['true', 'false', ''])('preserves explicit caller value %j in the worker environment', (value) => {
    const env = { pnpm_config_verify_deps_before_run: value }
    expect(laneWorkerEnv(env, 'P0')).toMatchObject({ ...env, WT_SUITE_LOCK_PRIORITY: 'P0' })
  })

  it.each([['pnpm_config_verify_deps_before_run'], ['PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN']])('adds no default beside a caller %s', (name) => {
    for (const value of ['true', '']) expect(laneWorkerEnv({ PATH: 'tools', [name]: value }, null)).toEqual({ PATH: 'tools', [name]: value, WT_SUITE_LOCK_CONTEXT: 'lane', WT_SUITE_LOCK_PRIORITY: 'P2' })
  })

  it.each([
    ['export npm_config_verify_deps_before_run=false', true],
    ['export NPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false', true],
    ['export npm_config_verify_deps_before_run=false\nexport PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false', false],
    ['`npm_config_verify_deps_before_run` is disabled.', true],
    ['export pnpm_config_verify_deps_before_run=false', false],
    ['npm_config_verify_deps_before_run=false\npnpm_config_verify_deps_before_run=true', false],
    ['No dependency configuration.', false],
    ['other_npm_config_verify_deps_before_run=false', false],
  ])('warns only for an npm-only brief at launch: %s', (text, warn) => {
    const f = fixture()
    writeFileSync(f.brief, `# Work\n${text}\n## Gates\npnpm typecheck\n`)
    const env = sealedPluginCliEnv(f.root, { WT_LANE_MIN_AVAILABLE_MIB: '0', WT_LANE_FIXTURE_HOME: join(f.root, 'home') })
    const result = spawnSync(process.execPath, [verifyDepsLauncher, ...f.args], { encoding: 'utf8', env })
    expect(result.error).toBeUndefined()
    expect(result.status, 'warn-only: still reaches the sealed-environment stop').toBe(1)
    const warning = result.stderr.split('\n').find((line) => line.startsWith('wt-lane: Warning:'))
    if (warn) {
      expect(warning).toContain('use pnpm_config_verify_deps_before_run=false')
      expect(warning).toContain('npm_config_verify_deps_before_run')
    } else expect(warning).toBeUndefined()
    expect(readFileSync(join(laneHostDir(f.dir, { env, home: env.WT_LANE_FIXTURE_HOME }), 'run.log'), 'utf8')).toContain('BRIEF_SHA256=')
  })
})

it('refuses at the CLI before creating any lane state', () => {
  const f = fixture()
  const result = spawnSync(process.execPath, [launcher, ...f.args], { encoding: 'utf8' })
  expect(result.error).toBeUndefined()
  expect(result.status, 'a brief without Gates must exit 2 before launch').toBe(2)
  expect(result.stderr).toContain(`wt-lane: Refused: brief ${f.brief} has no gate section`)
  expect(existsSync(join(f.dir, '.lane'))).toBe(false)
  expect(existsSync(join(f.dir, '.lane', 'brief-snapshots'))).toBe(false)
  expect(existsSync(laneHostDir(f.dir))).toBe(false)
})

it('admits at the CLI a brief whose Gates use only pnpm run and pnpm exec vitest', () => {
  const f = fixture()
  writeFileSync(f.brief, '# Work\n## Gates\n- pnpm run quality:static\n- pnpm run typecheck\n- pnpm exec vitest run tests/mcp-capture\n')
  const env = sealedPluginCliEnv(f.root, { WT_LANE_MIN_AVAILABLE_MIB: '0', WT_LANE_FIXTURE_HOME: join(f.root, 'home') })
  const result = spawnSync(process.execPath, [launcher, ...f.args], { encoding: 'utf8', env })
  expect(result.error).toBeUndefined()
  expect(result.status, 'admitted past the gate check, then stopped by the sealed environment').toBe(1)
  expect(result.stderr).not.toContain('has no gate section')
  expect(readFileSync(join(laneHostDir(f.dir, { env, home: env.WT_LANE_FIXTURE_HOME }), 'run.log'), 'utf8')).toMatch(/BRIEF_SHA256=[a-f0-9]{64}\n/)
})

it.each(['', ' \t ', undefined])('rejects an empty opt-out reason at argument parsing: %j', (reason) => {
  const f = fixture()
  const args = [...f.args, '--no-gate-section', ...(reason === undefined ? [] : [reason])]
  expect(parse(args).error).toContain('--no-gate-section requires a non-empty reason')
  const result = spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8' })
  expect(result.status).toBe(2)
  expect(result.stderr).toContain('--no-gate-section requires a non-empty reason')
})

it('records the opt-out reason beside the brief sha in the run header', () => {
  const f = fixture()
  const options = parse([...f.args, '--no-gate-section', '  research only  '])
  expect(options.error).toBeUndefined()
  expect(options.noGateSectionReason).toBe('research only')
  const receipt = { path: f.brief, age: '0s', heading: '# Work', sha256: 'a'.repeat(64) }
  const lines = briefEvidenceLines(receipt, true, options.noGateSectionReason)
  expect(lines.slice(-2)).toEqual([`BRIEF_SHA256=${receipt.sha256}`, 'NO_GATE_SECTION_REASON="research only"'])
  const env = sealedPluginCliEnv(f.root, { WT_LANE_MIN_AVAILABLE_MIB: '0', WT_LANE_FIXTURE_HOME: join(f.root, 'home') })
  const result = spawnSync(process.execPath, [launcher, ...f.args, '--no-gate-section', '  research only  '], { encoding: 'utf8', env })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stderr).not.toContain('has no gate section')
  expect(readFileSync(join(laneHostDir(f.dir, { env, home: env.WT_LANE_FIXTURE_HOME }), 'run.log'), 'utf8')).toMatch(/BRIEF_SHA256=[a-f0-9]{64}\nNO_GATE_SECTION_REASON="research only"\n/)
})

it('documents the explicit reason and all exemptions on one usage line', () => {
  const result = spawnSync(process.execPath, [launcher, '--help'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(result.stdout.split('\n').some((line) => line.includes('--owner pilot') && line.includes('--role critic|review|refutation') && line.includes('--no-gate-section <reason>'))).toBe(true)
})

it('refuses an opt-out flag followed by another option instead of a reason', () => {
  const f = fixture()
  expect(parse([...f.args, '--no-gate-section', '--allow-no-git']).error).toContain('--no-gate-section requires a non-empty reason')
})
