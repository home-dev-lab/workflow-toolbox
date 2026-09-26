import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/skills/adopt/scripts/install.mjs')
const RULE = 'wt-delegation-ladder.md'
const ENV_ROOT = join(tmpdir(), `wt-adopt-characterization-env-${process.pid}`)
const BASE_ENV = sealedPluginCliEnv(ENV_ROOT, { CLAUDE_PLUGIN_ROOT: join(REPO_ROOT, 'plugin') })
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
afterAll(() => rmSync(ENV_ROOT, { recursive: true, force: true }))

function tempDir(prefix = 'wt-adopt-characterization-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; script?: string } = {}) {
  const result = spawnSync(process.execPath, [options.script ?? SCRIPT, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? BASE_ENV,
  })
  return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') }
}

function fixturePlugin(options: { version?: unknown; copyRules?: boolean; copyAgents?: boolean } = {}) {
  const root = tempDir('wt-adopt-fixture-plugin-')
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin/plugin.json'), JSON.stringify({ version: options.version ?? '1.2.3' }))
  if (options.copyRules) cpSync(join(REPO_ROOT, 'plugin/rules'), join(root, 'rules'), { recursive: true })
  if (options.copyAgents) {
    cpSync(join(REPO_ROOT, 'plugin/agents'), join(root, 'agents'), { recursive: true })
    cpSync(join(REPO_ROOT, 'plugin/agent-templates'), join(root, 'agent-templates'), { recursive: true })
  }
  const script = join(root, 'skills/adopt/scripts/install.mjs')
  mkdirSync(join(root, 'skills/adopt/scripts'), { recursive: true })
  cpSync(SCRIPT, script)
  return { root, script }
}

describe('adopt installer characterization - settings degradation and trace state', () => {
  it.each([
    ['invalid JSON', '{'],
    ['root must be a JSON object', '[]'],
    ['env must be a JSON object when present', JSON.stringify({ env: [] })],
  ])('leaves malformed settings untouched: %s', (message, contents) => {
    const cwd = tempDir()
    const config = tempDir()
    const settings = join(config, 'settings.json')
    writeFileSync(settings, contents)
    const before = readFileSync(settings, 'utf8')

    const result = run(['--set', 'rules', '--install', '--dir', join(cwd, 'rules')], {
      cwd,
      env: { ...BASE_ENV, CLAUDE_CONFIG_DIR: config },
    })

    expect(result.status).toBe(0)
    expect(result.out).toContain(`INVALID (${message}; left untouched)`)
    expect(readFileSync(settings, 'utf8')).toBe(before)
  })

  it('creates missing settings without a backup and records then recognizes prior management', () => {
    const cwd = tempDir()
    const config = tempDir()
    const env = { ...BASE_ENV, CLAUDE_CONFIG_DIR: config }
    const settings = join(config, 'settings.json')

    const installed = run(['--set', 'rules', '--install', '--dir', join(cwd, 'rules')], { cwd, env })
    expect(installed.status).toBe(0)
    expect(installed.out).toContain('CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: WROTE')
    expect(installed.out).not.toContain('backup settings.json.workflow-toolbox.bak.')

    const value = JSON.parse(readFileSync(settings, 'utf8')) as { env: Record<string, string> }
    delete value.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH
    writeFileSync(settings, `${JSON.stringify(value, null, 2)}\n`)
    const checked = run(['--set', 'rules', '--check', '--dir', join(cwd, 'rules')], { cwd, env })
    expect(checked.out).toContain('ABSENT (previously managed here; would be re-added on --install)')

    value.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '3'
    writeFileSync(settings, `${JSON.stringify(value, null, 2)}\n`)
    expect(run(['--set', 'rules', '--check', '--dir', join(cwd, 'rules')], { cwd, env }).out).toContain(
      'PRESENT (matches the managed default; left intact)',
    )
  })
})

describe('adopt installer characterization - rejected CLI states', () => {
  it.each([
    [['--set', 'rules', '--diff', '../outside.md'], '--diff requires one managed file basename'],
    [['--set', 'rules', '--diff', 'not-managed.md'], '--diff file is not managed'],
    [['--set', 'rules', '--diff', RULE], '--diff requires a managed copy'],
    [['--set', 'all', '--diff', RULE], '--diff requires a single --set'],
    [['--audit-overlap', '--set', 'docs', '--user-dir', '.'], "unknown --set 'docs'"],
    [['--migrate', '--dry-run', '--set', 'agents'], 'only applies to the rules set'],
    [['--migrate', '--dry-run', '--dir', '.'], 'basename is not'],
    [['--migrate', '--execute', '--dir', '.'], 'basename is not'],
  ] satisfies Array<[string[], string]>)('rejects %j', (args, message) => {
    const cwd = tempDir()
    const result = run(args, { cwd })
    expect(result.status).not.toBe(0)
    expect(result.out).toContain(message)
  })
})

describe('adopt installer characterization - incomplete plugin bundles', () => {
  it('rejects a malformed plugin version at the resolved manifest', () => {
    const fixture = fixturePlugin({ version: 'next', copyRules: true })
    const result = run(['--check', '--dir', tempDir()], { script: fixture.script })
    expect(result.status).not.toBe(0)
    expect(result.out).toContain('plugin.json version is missing or malformed')
  })

  it('fails when no plugin manifest exists above the standalone script', () => {
    const root = tempDir()
    const script = join(root, 'install.mjs')
    cpSync(SCRIPT, script)
    const result = run(['--check', '--dir', tempDir()], { script })
    expect(result.status).not.toBe(0)
    expect(result.out).toContain('could not locate the plugin manifest')
  })

  it('treats an absent discoverable rule directory as an empty set', () => {
    const fixture = fixturePlugin()
    const rules = run(['--set', 'rules', '--check', '--dir', tempDir()], { script: fixture.script })
    expect(rules.status).toBe(0)
    expect(rules.out).toContain('CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: ABSENT')
    expect(rules.out).not.toMatch(/^  .+\.md:/m)
  })

  it('names a missing fixed-set source instead of partially installing', () => {
    const fixture = fixturePlugin()
    const result = run(['--set', 'agents', '--install', '--dir', tempDir()], { script: fixture.script })
    expect(result.status).not.toBe(0)
    expect(result.out).toContain('agents source not found:')
  })
})

describe('adopt installer characterization - declaration validation', () => {
  it.each([
    ['{', 'invalid JSON'],
    ['{}', 'root must be a JSON array'],
    ['[null]', 'entry 0 must be an object'],
    ['[{"user":"","status":"private"}]', "field 'user' must be a non-empty string"],
    ['[{"user":"local.md","status":"other"}]', "field 'status' must be one of"],
    ['[{"user":"local.md","status":"shipped-as"}]', "field 'target' must be a non-empty string"],
    ['[{"user":"local.md","status":"private","target":"x.md"}]', "field 'target' is allowed only"],
  ])('rejects malformed ship declarations: %s', (contents, message) => {
    const userDir = tempDir()
    const declarations = join(userDir, 'declarations.json')
    writeFileSync(declarations, contents)
    const result = run([
      '--audit-overlap',
      '--set',
      'rules',
      '--user-dir',
      userDir,
      '--declarations-file',
      declarations,
    ])
    expect(result.status).not.toBe(0)
    expect(result.out).toContain(message)
  })

  it('rejects a declaration colliding with either side of a known pair', () => {
    const userDir = tempDir()
    const declarations = join(userDir, 'declarations.json')
    writeFileSync(declarations, JSON.stringify([{ user: RULE, status: 'private' }]))
    const result = run([
      '--audit-overlap',
      '--set',
      'rules',
      '--user-dir',
      userDir,
      '--declarations-file',
      declarations,
    ])
    expect(result.status).not.toBe(0)
    expect(result.out).toContain('collides with a declared pair')
  })
})

describe('adopt installer characterization - read-only fallbacks and agent shadows', () => {
  it('uses the explicit unavailable marker when a managed copy predates the adoption journal', () => {
    const target = tempDir()
    const body = readFileSync(join(REPO_ROOT, 'plugin/rules', RULE), 'utf8')
    const fingerprint = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12)
    writeFileSync(
      join(target, RULE),
      `<!-- installed from workflow-toolbox v0.0.1 · content sha256:${fingerprint} by the adopt skill -->\n\n${body}`,
    )
    const result = run(['--set', 'rules', '--diff', RULE, '--dir', target])
    expect(result.status).toBe(0)
    expect(result.out).toContain('[unavailable: this copy predates the adoption journal]')
  })

  it('classifies matching, body-diverged, and frontmatter-only registered-agent shadows', () => {
    const config = tempDir()
    const userAgents = join(config, 'agents')
    mkdirSync(userAgents)
    const shippedNames = ['leaf-readonly', 'leaf', 'lean']
    const shipped = shippedNames.map((name) => readFileSync(join(REPO_ROOT, 'plugin/agents', `${name}.md`), 'utf8'))
    writeFileSync(join(userAgents, `${shippedNames[0]}.md`), shipped[0]!)
    writeFileSync(join(userAgents, `${shippedNames[1]}.md`), `${shipped[1]!}\nlocal body edit\n`)
    writeFileSync(
      join(userAgents, `${shippedNames[2]}.md`),
      shipped[2]!.replace(/^(description:.*)$/m, '$1\nmodel: sonnet'),
    )

    const result = run(['--set', 'agents', '--check', '--dir', tempDir()], {
      env: { ...BASE_ENV, CLAUDE_CONFIG_DIR: config },
    })
    expect(result.status).toBe(0)
    expect(result.out).toContain('(matches the plugin copy)')
    expect(result.out).toContain('(DIVERGED;')
    expect(result.out).toContain('; body differs)')
    expect(result.out).toContain('; frontmatter-only: model)')
  })
})
