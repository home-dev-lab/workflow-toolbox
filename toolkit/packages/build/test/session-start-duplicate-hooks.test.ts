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

// The harness sets CLAUDE_PROJECT_DIR to the directory the session started in and keeps it
// there when the session later changes directory; the payload's cwd follows the directory.
function run(configDir: string, pluginRoot: string | undefined, root: string, pluginId?: string,
  { hook = HOOK, event = 'SessionStart' as string | null, cwd = projectOf(root), projectDir = projectOf(root) as string | undefined } = {}) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ ...(event ? { hook_event_name: event } : {}), session_id: 'session-double', cwd }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_PROJECT_DIR: projectDir,
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
    // Version drift says nothing about how many times a hook runs.
    expect(dev.stdout).not.toContain('Hooks run once')
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
    // The foreign project exists, so only the project comparison can reject it.
    mkdirSync(join(root, 'another-project'), { recursive: true })
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

  it('a session already running the installed root of this project is not stale beside an older user entry', () => {
    const { configDir, installedRoot, root } = fixture()
    writeRegistry(configDir, [
      { scope: 'user', installPath: installedRoot, version: '0.182.0' },
      { scope: 'local', projectPath: projectOf(root), installPath: PLUGIN_ROOT, version: JSON.parse(MANIFEST).version },
    ])
    const result = run(configDir, PLUGIN_ROOT, root, KEY)
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('STALE PLUGIN VERSION')
  })

  it('MED-1: after a cd below the project, a local entry at the running root still means not stale', () => {
    const { configDir, installedRoot, root } = fixture()
    writeRegistry(configDir, [
      { scope: 'user', installPath: installedRoot, version: '0.182.0' },
      { scope: 'local', projectPath: projectOf(root), installPath: PLUGIN_ROOT, version: JSON.parse(MANIFEST).version },
    ])
    const sub = join(projectOf(root), 'sub')
    mkdirSync(sub, { recursive: true })
    const result = run(configDir, PLUGIN_ROOT, root, KEY, { cwd: sub })
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('STALE PLUGIN VERSION')
  })

  it('MED-1: after a cd below the project, a local-only entry at another version is still stale', () => {
    const { configDir, installedRoot, root } = fixture()
    writeRegistry(configDir, [{ scope: 'local', projectPath: projectOf(root), installPath: installedRoot, version: '0.182.0' }])
    const sub = join(projectOf(root), 'sub')
    mkdirSync(sub, { recursive: true })
    const result = run(configDir, PLUGIN_ROOT, root, KEY, { cwd: sub })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('STALE PLUGIN VERSION')
    expect(result.stdout).toContain(installedRoot)
  })

  it('MED-1: without CLAUDE_PROJECT_DIR the payload cwd is the project', () => {
    const { configDir, installedRoot, root } = fixture()
    writeRegistry(configDir, [{ scope: 'local', projectPath: projectOf(root), installPath: installedRoot, version: '0.182.0' }])
    const result = run(configDir, PLUGIN_ROOT, root, KEY, { projectDir: undefined })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('STALE PLUGIN VERSION')
  })

  it('a settings command that only mentions a hook path is not a registration', () => {
    const { configDir, root } = fixture()
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'workflow-toolbox@workflow-toolbox': true },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `echo node "${HOOK}"` }] }] },
    }))
    expect(run(configDir, undefined, root, undefined, { event: null }).stdout).not.toContain('DUPLICATE HOOK REGISTRATION')
    writeFileSync(join(configDir, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'workflow-toolbox@workflow-toolbox': true },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `cd /tmp && node "${HOOK}"` }] }] },
    }))
    expect(run(configDir, undefined, root, undefined, { event: null }).stdout).toContain('DUPLICATE HOOK REGISTRATION')
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

describe('settings command and installed-copy evidence', () => {
  it.each([
    ['adjacent semicolon', `node "${HOOK}";next`, true],
    ['leading whitespace', `  node "${HOOK}"`, true],
    ['newline separator', `true\nnode "${HOOK}"`, true],
    ['absolute node executable', `/usr/bin/node "${HOOK}"`, true],
    ['env assignment prefix', `env X=1 node "${HOOK}"`, true],
    ['conditional OR branch', `true || node "${HOOK}"`, false],
    ['conditional OR group', `true || (node "${HOOK}"; node "${HOOK}" )`, false],
    ['stderr redirection', `node "${HOOK}" 2>/dev/null`, true],
    ['stdout and stderr redirection', `node "${HOOK}" > /dev/null 2>&1`, true],
    ['input redirection before the command', `</dev/null node "${HOOK}"`, true],
    ['expansion in a later command', `node "${HOOK}"; echo "$HOME"`, true],
    ['quoted expansion argument', `node "${HOOK}" "$HOME"`, true],
    ['expansion in an argument', `node "${HOOK}" $ARG \`date\``, true],
    ['command substitution argument', `node "${HOOK}" $(date; true)`, true],
    ['expanded executable', `$DIR/node "${HOOK}"`, false],
    ['expanded script path', `node "$DIR${HOOK}"`, false],
    ['backslash-newline continuation', `node "${HOOK}" \\\n; true`, true],
    ['quoted assignment is a command name', `"X=1" node "${HOOK}"`, false],
    ['directory path in command position', `node/ "${HOOK}"`, false],
    ['unbalanced group', `node "${HOOK}"; (`, false],
    ['AND after an OR branch stays conditional', `false || true && node "${HOOK}"`, false],
    ['heredoc body is text', `cat <<'EOF'\nnode "${HOOK}"\nEOF`, false],
    ['quoted assignment after env', `env "X=1" node "${HOOK}"`, true],
    ['separator inside a parameter expansion', `echo \${X:-abc;node "${HOOK}" }`, false],
    ['parenthesis inside a parameter expansion', `node "${HOOK}"; echo \${X:-)}`, true],
    ['directory path for env', `env/ node "${HOOK}"`, false],
    ['missing redirection target', `node "${HOOK}" >`, false],
    ['quoted brace inside a parameter expansion', `node "${HOOK}" \${X:-'}'}`, true],
    ['process substitution target', `echo > >(node "${HOOK}" )`, true],
    ['command substitution inside an argument list', `echo $(true) node "${HOOK}"`, false],
    ['nested parameter expansion', `echo \${X:-\${Y:-abc};node "${HOOK}" }`, false],
    ['newline after an OR operator', `true ||\nnode "${HOOK}"`, false],
    ['consecutive redirections', `node "${HOOK}" > > /dev/null`, false],
    ['node inside a command substitution', `echo $(node "${HOOK}")`, true],
    ['single-quoted substitution is text', `echo '$(node "${HOOK}")'`, false],
    ['node inside backticks', `echo \`node "${HOOK}"\``, true],
    ['continuation between words', `node \\\n "${HOOK}"`, true],
    ['unmatched closing parenthesis', `node "${HOOK}" )`, false],
    ['quoted parenthesis is text', `echo ")"; node "${HOOK}"`, true],
    ['literal brace in a parameter default', `node "${HOOK}" ; echo \${X:-{}`, true],
    ['command substitution inside a parameter default', `node "${HOOK}" ; echo \${X:-$(echo {})}`, true],
    ['backticks inside a parameter default', `node "${HOOK}" ; echo \${X:-\`echo {}\`}`, true],
    ['escaped dollar inside a parameter default', `echo \${X:-\\\${}; node "${HOOK}"`, true],
  ])('settings parser handles %s', (_label, command, duplicate) => {
    const { configDir, root } = fixture()
    writeJson(join(configDir, 'settings.json'), {
      enabledPlugins: { [KEY]: true },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] },
    })
    const result = run(configDir, undefined, root, undefined, { event: null })
    expect(result.status).toBe(0)
    expect(result.stdout.includes('DUPLICATE HOOK REGISTRATION')).toBe(duplicate)
  })
  it('a deeply nested command gives no evidence without hiding another entry', () => {
    const { configDir, root } = fixture()
    const deep = `echo ${'$('.repeat(50_000)}true${')'.repeat(50_000)}`
    writeJson(join(configDir, 'settings.json'), {
      enabledPlugins: { [KEY]: true },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: deep }, { type: 'command', command: `node "${HOOK}"` }] }] },
    })
    const result = run(configDir, undefined, root, undefined, { event: null })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DUPLICATE HOOK REGISTRATION')
  })
  it('collects a very wide command substitution without overflowing the stack', () => {
    const { configDir, root } = fixture()
    writeJson(join(configDir, 'settings.json'), {
      enabledPlugins: { [KEY]: true },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `echo $(${`node "${HOOK}" ;`.repeat(150_000)})` }] }] },
    })
    const result = run(configDir, undefined, root, undefined, { event: null })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DUPLICATE HOOK REGISTRATION')
  })
  it('collects a very wide backtick substitution without overflowing the stack', () => {
    const { configDir, root } = fixture()
    writeJson(join(configDir, 'settings.json'), {
      enabledPlugins: { [KEY]: true },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `echo \`${`node "${HOOK}" ;`.repeat(150_000)}\`` }] }] },
    })
    const result = run(configDir, undefined, root, undefined, { event: null })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DUPLICATE HOOK REGISTRATION')
  })
  it('reads a long run of unterminated expansions in linear time', () => {
    const { configDir, root } = fixture()
    writeJson(join(configDir, 'settings.json'), {
      enabledPlugins: { [KEY]: true },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `echo ${'${'.repeat(200_000)}` }] }] },
    })
    const started = performance.now()
    const result = run(configDir, undefined, root, undefined, { event: null })
    // A quadratic scan of this input takes tens of seconds; a linear one well under a second.
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('DUPLICATE HOOK REGISTRATION')
  })
  it.each([false, true])('does not attribute an ambiguous installed key to registry order (reverse=%s)', (reverse) => {
    const { configDir, installedRoot, root } = fixture()
    const other = installCopy(root, 'other', JSON.parse(MANIFEST).version)
    const entries = [
      { scope: 'user', installPath: installedRoot, version: '0.182.0' },
      { scope: 'local', projectPath: projectOf(root), installPath: other, version: JSON.parse(MANIFEST).version },
    ]
    writeRegistry(configDir, reverse ? entries.reverse() : entries)
    const result = run(configDir, PLUGIN_ROOT, root, KEY)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('cannot tell which installed copy')
    expect(result.stdout).not.toContain(installedRoot)
    expect(result.stdout).not.toContain(other)
    expect(result.stdout).not.toContain('STALE PLUGIN VERSION')
  })
  it('stays silent when every applicable installed copy matches the running version', () => {
    const { configDir, root } = fixture()
    const version = JSON.parse(MANIFEST).version
    writeRegistry(configDir, [
      { scope: 'user', installPath: installCopy(root, 'same-a', version), version },
      { scope: 'local', projectPath: projectOf(root), installPath: installCopy(root, 'same-b', version), version },
    ])
    const result = run(configDir, PLUGIN_ROOT, root, KEY)
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('cannot tell which installed copy')
    expect(result.stdout).not.toContain('PLUGIN VERSION')
  })
})
