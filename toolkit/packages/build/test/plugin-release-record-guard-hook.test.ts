// The plugin's half of an invariant the published PACKAGES already enforce: a change under
// `plugin/` must carry its version bump and changelog entry, or adopters receive nothing.
//
// Measured 2026-08-27: a plugin hook fix was merged to main and pushed with neither. The version
// gates what adopters get, so the fix reached `main` and reached no one — found hours later, by
// accident. The same omission on a package would have gone red at commit time via changeset-gate.
//
// Every case below builds a REAL throwaway git repository and stages real files, because the
// guard's whole job is reading the staged set — a fixture that stubbed git would test the mock.
//
// ⚠ Hermetic by construction: `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` so no
// machine-level setting reaches these repos, `commit.gpgSign` included. Without that, a signer
// that becomes unreachable turns this suite red for a reason that has nothing to do with the code
// (measured on this machine, and it cost an evening).

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-plugin-release-record-guard-hook.mjs')

const HERMETIC = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...HERMETIC },
  })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
  return res.stdout
}

function write(root: string, rel: string, body: string) {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
}

/** A repo that OWNS a plugin manifest, i.e. one the guard is scoped to. */
function pluginRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'wt-relrec-'))
  made.push(root)
  git(root, 'init', '-q')
  write(root, 'plugin/.claude-plugin/plugin.json', JSON.stringify({ version: '0.1.0' }))
  write(root, 'plugin/CHANGELOG.md', '# Changelog\n')
  write(root, 'plugin/bin/thing.mjs', '// v1\n')
  git(root, 'add', '.')
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base')
  return root
}

function run(cwd: string, command = 'git commit -m x') {
  const res = spawnSync(process.execPath, [HOOK], {
    cwd,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd,
      tool_input: { command },
    }),
    encoding: 'utf8',
    env: { ...process.env, ...HERMETIC },
  })
  return {
    // WARN-ONLY by design: this guard must never emit a deny decision.
    warned: res.stdout.includes('hookSpecificOutput'),
    denied: res.stdout.includes('"deny"'),
    stdout: res.stdout,
    status: res.status,
  }
}

describe('wt-plugin-release-record-guard-hook', () => {
  // THE case. A broken guard most plausibly fails by staying silent here, so this is the row that
  // has to be red under mutation for any of the others to mean anything.
  it('warns when a plugin change is staged with neither the version nor the changelog', () => {
    const root = pluginRepo()
    write(root, 'plugin/bin/thing.mjs', '// v2\n')
    git(root, 'add', 'plugin/bin/thing.mjs')
    const r = run(root)
    expect(r.warned, 'a plugin change with no release record must warn').toBe(true)
    expect(r.denied, 'this guard is warn-only and must never deny').toBe(false)
  })

  it('is silent when the version bump is staged alongside', () => {
    const root = pluginRepo()
    write(root, 'plugin/bin/thing.mjs', '// v2\n')
    write(root, 'plugin/.claude-plugin/plugin.json', JSON.stringify({ version: '0.2.0' }))
    git(root, 'add', 'plugin/bin/thing.mjs', 'plugin/.claude-plugin/plugin.json')
    expect(run(root).warned).toBe(false)
  })

  it('is silent when the changelog entry is staged alongside', () => {
    const root = pluginRepo()
    write(root, 'plugin/bin/thing.mjs', '// v2\n')
    write(root, 'plugin/CHANGELOG.md', '# Changelog\n\n## [0.2.0]\n')
    git(root, 'add', 'plugin/bin/thing.mjs', 'plugin/CHANGELOG.md')
    expect(run(root).warned).toBe(false)
  })

  it('is silent when nothing under plugin/ is staged', () => {
    const root = pluginRepo()
    write(root, 'README.md', 'hello\n')
    git(root, 'add', 'README.md')
    expect(run(root).warned).toBe(false)
  })

  // Scope. Without this the guard would fire in every unrelated project on the machine that
  // happens to have a `plugin/` directory.
  it('is silent in a repository that owns no plugin manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-relrec-bare-'))
    made.push(root)
    git(root, 'init', '-q')
    write(root, 'plugin/bin/thing.mjs', '// v1\n')
    git(root, 'add', '.')
    expect(run(root).warned).toBe(false)
  })

  it('is silent for a command that is not a git commit', () => {
    const root = pluginRepo()
    write(root, 'plugin/bin/thing.mjs', '// v2\n')
    git(root, 'add', 'plugin/bin/thing.mjs')
    expect(run(root, 'ls -la plugin/').warned).toBe(false)
  })

  // Fail-open is the contract for every guard here: a hook that throws must not block the tool.
  it('exits zero even when handed input it cannot use', () => {
    const root = pluginRepo()
    const res = spawnSync(process.execPath, [HOOK], { cwd: root, input: 'not json', encoding: 'utf8' })
    expect(res.status).toBe(0)
  })
})
