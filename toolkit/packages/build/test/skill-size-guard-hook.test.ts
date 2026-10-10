import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const REPO = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO, 'plugin/bin/wt-skill-size-guard-hook.mjs')
const roots: string[] = []
function fixture() {
  mkdirSync(join(REPO, '.lane'), { recursive: true })
  const root = mkdtempSync(join(REPO, '.lane/skill-size-test-'))
  roots.push(root)
  const config = join(root, 'config')
  const project = join(root, 'project')
  mkdirSync(config)
  mkdirSync(project)
  return { root, config, project }
}
function put(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
function run(f: ReturnType<typeof fixture>, skill: string, extra = {}, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [HOOK], {
    cwd: f.project, encoding: 'utf8', timeout: 1500,
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Skill', cwd: f.project, tool_input: { skill }, ...extra }),
    env: sealedPluginCliEnv(f.root, { CLAUDE_CONFIG_DIR: f.config, CLAUDE_PROJECT_DIR: f.project,
      CLAUDE_PLUGIN_ROOT: join(REPO, 'plugin'), WT_SKILL_SIZE_WARN_CHARS: undefined,
      WT_GUARD_MODE: 'enforce', WT_GUARD_JOURNAL_DIR: join(f.root, 'journal'), WT_GUARD_JOURNAL_NOW: '2026-10-10T12:00:00Z', ...env }),
  })
}
function silent(result: ReturnType<typeof run>) {
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('main-session Skill size warning', () => {
  it('warns with name, character count, compaction cost, path and both alternatives; never denies', () => {
    const f = fixture()
    const file = join(f.project, '.claude/skills/large/SKILL.md')
    put(file, 'é'.repeat(8001))
    const result = run(f, 'large')
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const output = JSON.parse(result.stdout)
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: expect.any(String) } })
    for (const text of ['WARNING', 'large', '8001 characters', 'every invoked skill', 'after each compaction', 'Read', file, 'delegate', 'sub-agent']) {
      expect(output.hookSpecificOutput.additionalContext).toContain(text)
    }
    expect(existsSync(join(f.root, 'journal'))).toBe(false)
  })
  it.each([10, 8000])('is silent at %i characters', size => {
    const f = fixture()
    put(join(f.project, '.claude/skills/small/SKILL.md'), 'x'.repeat(size))
    silent(run(f, 'small'))
  })
  it.each(['child', '', null])('never warns when agent_id is present (%s)', agent_id => {
    const f = fixture()
    put(join(f.project, '.claude/skills/large/SKILL.md'), 'x'.repeat(9000))
    silent(run(f, 'large', { agent_id }))
  })
})

describe('Skill resolution and threshold overrides', () => {
  it('silently passes an unresolvable skill without journal writes', () => {
    const f = fixture()
    silent(run(f, 'missing'))
    expect(existsSync(join(f.root, 'journal'))).toBe(false)
  })
  it('honours an override and rejects an unparsable override', () => {
    const f = fixture()
    put(join(f.config, 'skills/user/SKILL.md'), 'x'.repeat(8001))
    silent(run(f, 'user', {}, { WT_SKILL_SIZE_WARN_CHARS: '9000' }))
    expect(run(f, 'user', {}, { WT_SKILL_SIZE_WARN_CHARS: '8000oops' }).stdout).toContain('8001 characters')
    put(join(f.config, 'skills/user/SKILL.md'), 'x'.repeat(101))
    expect(run(f, 'user', {}, { WT_SKILL_SIZE_WARN_CHARS: '100' }).stdout).toContain('101 characters')
  })
  it('resolves another installed plugin and ignores a foreign project installation', () => {
    const f = fixture()
    const plugin = join(f.root, 'other-plugin')
    put(join(plugin, 'skills/reference/SKILL.md'), 'x'.repeat(9000))
    const registry = join(f.config, 'plugins/installed_plugins.json')
    put(registry, JSON.stringify({ version: 2, plugins: { 'other@market': [{ scope: 'user', installPath: plugin }] } }))
    expect(run(f, 'other:reference').stdout).toContain('9000 characters')
    put(registry, JSON.stringify({ version: 2, plugins: { 'other@market': [{ scope: 'local', projectPath: join(f.root, 'foreign'), installPath: plugin }] } }))
    silent(run(f, 'other:reference'))
  })
  it('project skill takes precedence over user skill', () => {
    const f = fixture()
    put(join(f.config, 'skills/shared/SKILL.md'), 'x'.repeat(9000))
    put(join(f.project, '.claude/skills/shared/SKILL.md'), 'small')
    silent(run(f, 'shared'))
  })
})

describe('Skill hook fail-open handling and registration', () => {
  it('fails open on an internal read error', () => {
    const f = fixture()
    put(join(f.config, 'plugins/installed_plugins.json'), '{broken')
    silent(run(f, 'other:reference'))
  })
  it('fails open on malformed stdin and ignores other tools', () => {
    const f = fixture()
    silent(run(f, 'workflow-toolbox:pilot-wave', { tool_name: 'Read' }))
    const result = spawnSync(process.execPath, [HOOK], { input: '{', encoding: 'utf8', env: sealedPluginCliEnv(f.root) })
    silent(result)
  })
  it('resolves a real bundled large skill and is wired on Skill', () => {
    const f = fixture()
    const file = join(REPO, 'plugin/skills/pilot-wave/SKILL.md')
    const size = Array.from(readFileSync(file, 'utf8')).length
    expect(size).toBeGreaterThan(8000)
    expect(run(f, 'workflow-toolbox:pilot-wave').stdout).toContain(`${size} characters`)
    const manifest = JSON.parse(readFileSync(join(REPO, 'plugin/.claude-plugin/plugin.json'), 'utf8'))
    expect(manifest.hooks.PreToolUse.filter((entry: { matcher: string }) => entry.matcher === 'Skill')
      .flatMap((entry: { hooks: { command: string }[] }) => entry.hooks)
      .some((entry: { command: string }) => entry.command.includes('wt-skill-size-guard-hook.mjs'))).toBe(true)
    expect(manifest.hooks.PreToolUse.find((entry: { matcher: string }) => entry.matcher === 'Skill').hooks[0].timeout).toBe(5)
  })
})

describe('Skill hook stderr and nonblocking locks', () => {
  it('never emits stderr or moves legacy journal state with the journal override unset', () => {
    const f = fixture()
    const legacy = join(f.root, 'home/.local/state/wt-guard-journal/legacy.ndjson')
    put(legacy, 'legacy sentinel')
    put(join(f.config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: {
      'workflow-toolbox@market': [{ version: '999.0.0', installPath: join(REPO, 'plugin') }],
    } }))
    silent(run(f, 'missing', {}, { WT_GUARD_JOURNAL_DIR: undefined }))
    expect(existsSync(legacy)).toBe(true)
    expect(readFileSync(legacy, 'utf8')).toBe('legacy sentinel')
    put(join(f.project, '.claude/skills/large/SKILL.md'), 'x'.repeat(9000))
    const warned = run(f, 'large', {}, { WT_GUARD_JOURNAL_DIR: undefined })
    expect(warned.status).toBe(0)
    expect(warned.stderr).toBe('')
    expect(JSON.parse(warned.stdout).hookSpecificOutput.additionalContext).toContain('9000 characters')
    expect(existsSync(legacy)).toBe(true)
  })
  it.each(['secret', 'registry', 'manifest', 'settings', 'skill'])('skips a FIFO at the %s path within the timeout', (kind, context) => {
    const f = fixture()
    const paths = {
      secret: join(f.config, 'plugins/store/wt-secret-guard.json'),
      registry: join(f.config, 'plugins/installed_plugins.json'),
      manifest: join(f.root, 'loaded/.claude-plugin/plugin.json'),
      settings: join(f.config, 'settings.json'),
      skill: join(f.project, '.claude/skills/reference/SKILL.md'),
    }
    const file = paths[kind as keyof typeof paths]
    mkdirSync(dirname(file), { recursive: true })
    const fifo = spawnSync('mkfifo', [file], { encoding: 'utf8' })
    if (fifo.error || fifo.status !== 0) { context.skip('mkfifo is unavailable on this platform'); return }
    const skill = kind === 'secret' ? 'missing' : kind === 'skill' ? 'reference' : 'other:reference'
    silent(run(f, skill, {}, { CLAUDE_PLUGIN_ROOT: join(f.root, 'loaded') }))
  })
})

describe('Skill ancestor, containment and byte-size checks', () => {
  it('discovers the ancestor project skill when cwd is nested and no project env is provided', () => {
    const f = fixture()
    const nested = join(f.project, 'src/nested')
    mkdirSync(nested, { recursive: true })
    put(join(f.project, '.claude/skills/reference/SKILL.md'), 'x'.repeat(9000))
    expect(run(f, 'reference', { cwd: nested }, { CLAUDE_PROJECT_DIR: undefined }).stdout).toContain('9000 characters')
    expect(run(f, 'reference', { cwd: nested }).stdout).toContain('9000 characters')
  })
  it.each(['file', 'directory'])('rejects a symlinked skill %s escaping the real skills directory', (kind, context) => {
    const f = fixture()
    const outside = join(f.root, 'outside')
    put(join(outside, 'SKILL.md'), 'x'.repeat(9000))
    const inside = join(f.project, '.claude/skills/reference')
    mkdirSync(kind === 'file' ? inside : dirname(inside), { recursive: true })
    try { symlinkSync(kind === 'file' ? join(outside, 'SKILL.md') : outside,
      kind === 'file' ? join(inside, 'SKILL.md') : inside, kind === 'file' ? 'file' : 'dir') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('symlink creation is not permitted'); return }; throw error }
    silent(run(f, 'reference'))
  })
  it('does not read SKILL.md at or below the byte threshold', () => {
    const f = fixture()
    const file = join(f.project, '.claude/skills/small/SKILL.md')
    put(file, 'x'.repeat(8000))
    const spy = join(f.root, 'read-spy.mjs')
    put(spy, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync; fs.readFileSync = function(path, ...args) {
  if (String(path) === ${JSON.stringify(file)}) process.stdout.write('UNEXPECTED_SKILL_READ');
  return read.call(this, path, ...args);
}; syncBuiltinESMExports();`)
    silent(run(f, 'small', {}, { NODE_OPTIONS: `--import=${JSON.stringify(spy)}` }))
    expect(readFileSync(HOOK, 'utf8').includes('Array.from(')).toBe(false)
  })
})

describe('Installed Skill manifest identity', () => {
  it('rejects an installed registry entry whose readable manifest names a different plugin', () => {
    const f = fixture()
    const plugin = join(f.root, 'wrong-plugin')
    put(join(plugin, 'skills/reference/SKILL.md'), 'x'.repeat(9000))
    put(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'wrong' }))
    put(join(f.config, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: {
      'other@market': [{ scope: 'user', installPath: plugin }],
    } }))
    silent(run(f, 'other:reference'))
    put(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'other' }))
    expect(run(f, 'other:reference').stdout).toContain('9000 characters')
  })
})
