import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { changesetPackages } from './changeset-provenance.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(REPO_ROOT, 'plugin/bin/wt-changelog-entry.mjs')
const RELEASE_GUARD = join(REPO_ROOT, 'plugin/bin/wt-plugin-release-record-guard-hook.mjs')
const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function write(root: string, path: string, body: string) {
  const target = join(root, path)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, body)
}

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  if (result.status !== 0) throw new Error(result.stderr)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-changelog-'))
  made.push(root)
  git(root, 'init', '-q')
  git(root, 'checkout', '-q', '-b', 'card/changelog')
  write(root, 'plugin/.claude-plugin/plugin.json', '{"version":"0.1.0"}\n')
  write(root, 'plugin/CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Changed\n\n### Fixed\n')
  write(root, 'toolkit/.changeset/config.json', '{"ignore":[]}\n')
  write(root, 'toolkit/packages/public/package.json', '{"name":"@wt/public","publishConfig":{"access":"public"}}\n')
  write(root, 'toolkit/packages/public/src/index.ts', 'export const publicValue = 1\n')
  write(root, 'toolkit/packages/private/package.json', '{"name":"@wt/private","private":true,"publishConfig":{"access":"restricted"}}\n')
  write(root, 'toolkit/packages/private/src/index.ts', 'export const privateValue = 1\n')
  git(root, 'add', '.')
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'base')
  return root
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' })
}

describe('changelog skill CLI', () => {
  it('writes one Unreleased entry and a changeset for published source, accepted by both release records', () => {
    const root = fixture()
    const args = [
      '--summary', 'Add deterministic release records',
      '--section', 'Added',
      '--paths', 'plugin/bin/new.mjs,toolkit/packages/public/src/index.ts',
    ]
    expect(run(root, ...args).status).toBe(0)
    expect(run(root, ...args).status).toBe(0)

    const changelog = readFileSync(join(root, 'plugin/CHANGELOG.md'), 'utf8')
    expect(changelog.match(/- Add deterministic release records/g)).toHaveLength(1)
    expect(changelog).toMatch(/## \[Unreleased\][\s\S]*### Added\n\n- Add deterministic release records/)

    expect(readdirSync(join(root, 'toolkit/.changeset')).filter((file) => file.endsWith('.md'))).toHaveLength(1)
    const changeset = readFileSync(join(root, 'toolkit/.changeset/changelog-add-deterministic-release-records-wt-public.md'), 'utf8')
    expect(changesetPackages(changeset)).toEqual(['@wt/public'])

    git(root, 'add', '.')
    const guard = spawnSync(process.execPath, [RELEASE_GUARD], {
      cwd: root,
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: root, tool_input: { command: 'git commit -m x' } }),
      encoding: 'utf8',
    })
    expect(guard.stdout).not.toContain('hookSpecificOutput')
  })

  it('does not create a changeset for private source', () => {
    const root = fixture()
    expect(run(root, '--summary', 'Fix private implementation', '--section', 'Fixed', '--paths', 'toolkit/packages/private/src/index.ts').status).toBe(0)
    expect(readdirSync(join(root, 'toolkit/.changeset')).filter((file) => file.endsWith('.md'))).toEqual([])
  })

  it('refuses version headings on a branch with the version-bump rule wording', () => {
    const result = run(fixture(), '--summary', 'Add a release', '--section', 'Added', '--version', '1.2.3')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('versions are bumped on main only')
  })

  it('strips and reports a private tracker id', () => {
    const result = run(fixture(), '--summary', 'Fix 1859058084903650648 release records', '--section', 'Fixed', '--paths', 'plugin/bin/new.mjs')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('stripped private tracker id')
    expect(result.stdout).not.toContain('1859058084903650648')
  })
})
