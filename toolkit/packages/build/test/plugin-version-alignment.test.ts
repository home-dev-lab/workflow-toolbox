import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CHECKER = join(REPO_ROOT, 'plugin/bin/lib/plugin-version-alignment.mjs')
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-version-guard-hook.mjs')
const HERMETIC = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const made: string[] = []

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...HERMETIC } })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}

function write(root: string, file: string, body: string) {
  const target = join(root, file)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, body)
}

function rootPluginRepo(options: { marketplace?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wt-version-'))
  made.push(root)
  git(root, 'init', '-q')
  write(root, '.claude-plugin/plugin.json', '{"version":"1.0.0"}\n')
  write(root, 'package.json', '{"version":"1.0.0"}\n')
  if (options.marketplace) {
    write(root, '.claude-plugin/marketplace.json', '{"plugins":[{"source":".","version":"1.0.0"}]}\n')
  }
  write(root, 'bin/thing.mjs', '// one\n')
  git(root, 'add', '.')
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base')
  return root
}

function singleCarrierRepo() {
  const root = mkdtempSync(join(tmpdir(), 'wt-version-'))
  made.push(root)
  git(root, 'init', '-q')
  write(root, 'plugin/.claude-plugin/plugin.json', '{"version":"1.0.0"}\n')
  write(root, 'plugin/bin/thing.mjs', '// one\n')
  git(root, 'add', '.')
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base')
  return root
}

function runHook(cwd: string, command = 'git commit -m x', mode?: string) {
  return spawnSync(process.execPath, [HOOK], {
    cwd,
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }),
    env: { ...process.env, ...HERMETIC, ...(mode ? { WT_VERSION_GUARD_MODE: mode } : {}) },
  })
}

describe('plugin version alignment guard', () => {
  it('ships one shared checker for both hook adapters', () => {
    expect(existsSync(CHECKER), 'plugin version alignment checker must be shipped').toBe(true)
  })

  it('is silent for a non-plugin commit and an aligned root-layout pair', () => {
    const root = rootPluginRepo()
    write(root, 'README.md', 'change\n')
    git(root, 'add', 'README.md')
    expect(runHook(root).stdout).toBe('')
    git(root, 'reset', '-q')
    write(root, 'bin/thing.mjs', '// two\n')
    git(root, 'add', 'bin/thing.mjs')
    expect(runHook(root).stdout).toBe('')
  })

  it('refuses a divergent root-layout pair with both files and versions in the remedy', () => {
    const root = rootPluginRepo()
    write(root, '.claude-plugin/plugin.json', '{"version":"2.0.0"}\n')
    git(root, 'add', '.claude-plugin/plugin.json')
    const result = runHook(root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('permissionDecision')
    expect(result.stdout).toContain('.claude-plugin/plugin.json')
    expect(result.stdout).toContain('package.json')
    expect(result.stdout).toContain('2.0.0')
    expect(result.stdout).toContain('1.0.0')
  })

  it('align mode writes and stages the highest root-layout version, then allows the commit', () => {
    const root = rootPluginRepo()
    write(root, '.claude-plugin/plugin.json', '{"version":"2.0.0"}\n')
    git(root, 'add', '.claude-plugin/plugin.json')
    const result = runHook(root, 'git commit -m x', 'align')
    expect(result.stdout).toBe('')
    expect(git(root, 'show', ':package.json')).toContain('2.0.0')
  })

  it('is silent for this repository layout with one carrier', () => {
    const root = singleCarrierRepo()
    write(root, 'plugin/bin/thing.mjs', '// two\n')
    git(root, 'add', 'plugin/bin/thing.mjs')
    expect(runHook(root).stdout).toBe('')
  })

  it('refuses a divergent marketplace entry with its exact entry in the remedy', () => {
    const root = rootPluginRepo({ marketplace: true })
    write(root, '.claude-plugin/marketplace.json', '{"plugins":[{"source":".","version":"2.0.0"}]}\n')
    git(root, 'add', '.claude-plugin/marketplace.json')
    const result = runHook(root)
    expect(result.stdout).toContain('permissionDecision')
    expect(result.stdout).toContain('.claude-plugin/marketplace.json#plugins[0]')
    expect(result.stdout).toContain('2.0.0')
    expect(result.stdout).toContain('1.0.0')
  })

  it('is silent when a heredoc only mentions git commit', () => {
    const root = rootPluginRepo()
    write(root, '.claude-plugin/plugin.json', '{"version":"2.0.0"}\n')
    git(root, 'add', '.claude-plugin/plugin.json')
    expect(runHook(root, "cat <<'EOF'\ngit commit -m x\nEOF").stdout).toBe('')
  })
})

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
})
