import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'

interface Plan {
  kind: string
  line: string
  gitHistoryHidden?: boolean
  withheldPaths?: string[]
  wrap: (command: string, args: string[]) => [string, string[]]
  dispose: () => void
  readable: string[]
  unreadable: (paths: string[][], options?: Record<string, unknown>) => Array<{ path: string }>
}
const source = process.env.WT_GIT_HISTORY_SANDBOX_MODULE ?? join(import.meta.dirname, '../../../../plugin/bin/lib/host/lane-sandbox.mjs')
const { resolveLaneSandbox } = await import(pathToFileURL(source).href) as { resolveLaneSandbox: (options: Record<string, unknown>) => Plan }
const roots: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
// These plans use real host Git paths and Linux mount syntax. Native fallback coverage lives in
// lane-sandbox.test.ts; a Windows Git path cannot be used as a synthetic Linux mount source.

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', cwd, ...args], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-tree-')))
  roots.push(root)
  const repo = join(root, 'repo'); mkdirSync(repo)
  const home = join(root, 'home'); mkdirSync(home)
  return { root, repo, home }
}
function plan(f: ReturnType<typeof fixture>, cwd = f.repo, extra = {}) {
  const fs = {
    exists: (file: string) => file.endsWith('broker.sock') || existsSync(file),
    realpath: (file: string) => { try { return realpathSync(file) } catch { return null } },
    isFile: (file: string) => { try { return statSync(file).isFile() } catch { return false } },
    isExecutable: () => true,
    isDir: (file: string) => { try { return statSync(file).isDirectory() } catch { return false } },
    readText: (file: string) => { try { return file.startsWith(f.root) ? readFileSync(file, 'utf8') : null } catch { return null } },
    ensureDir: (directory: string) => { mkdirSync(directory, { recursive: true }) }, ensureFile: () => {}, copy: () => {},
    identity: (file: string) => { const info = statSync(file); return `${info.dev}:${info.ino}` },
  }
  return resolveLaneSandbox({ profile: 'opencode', bin: process.execPath, cwd, readonlyCwd: true, hideGitHistory: true,
    platform: 'linux', bwrap: '/usr/bin/bwrap', socat: null, probe: () => ({ ok: true }),
    fs: { ...fs, exists: (file: string) => file === '/usr/bin/bwrap' || fs.exists(file) },
    env: { HOME: f.home, PATH: '/usr/bin:/bin' }, optionEnv: {}, runtimeParent: f.root,
    spawnFn: () => ({ kill: () => {}, once: () => {} }), ...extra })
}
function initialize(f: ReturnType<typeof fixture>) {
  git(f.repo, 'init')
  const object = join(f.repo, '.git/objects/placeholder')
  writeFileSync(object, 'placeholder history')
  return object
}
function masked(p: Plan, target: string) {
  const args = p.wrap('/bin/true', [])[1]
  return args.some((flag, i) => flag === '--tmpfs' && (target === args[i + 1] || target.startsWith(`${args[i + 1]}/`)) && args[i + 2] === '--remount-ro')
}

it.skipIf(process.platform !== 'linux')('holds back a normal checkout git directory and names it in the plan line', () => {
  const f = fixture(); initialize(f)
  const p = plan(f)
  try {
    expect(p.gitHistoryHidden).toBe(true)
    expect(p.withheldPaths).toContain(join(f.repo, '.git'))
    expect(masked(p, join(f.repo, '.git/objects/placeholder'))).toBe(true)
    expect(p.line).toContain(`withheld git history ${join(f.repo, '.git')}`)
  } finally { p.dispose() }
})
it.skipIf(process.platform !== 'linux')('holds back both Git-resolved linked-worktree directories and its pointer file', () => {
  const f = fixture(); initialize(f)
  git(f.repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '--allow-empty', '-m', 'fixture')
  const worktree = join(f.root, 'linked'); git(f.repo, 'worktree', 'add', '--detach', worktree)
  const gitdir = git(worktree, 'rev-parse', '--absolute-git-dir')
  const p = plan(f, worktree)
  try {
    expect(p.withheldPaths).toEqual(expect.arrayContaining([gitdir, join(f.repo, '.git'), join(worktree, '.git')]))
    expect(masked(p, gitdir)).toBe(true)
    expect(masked(p, join(f.repo, '.git/objects/placeholder'))).toBe(true)
    expect(p.readable).not.toContain(gitdir)
    expect(p.readable).not.toContain(join(f.repo, '.git'))
    expect(p.line).toContain(gitdir)
    expect(p.wrap('/bin/true', [])[1]).toContain('/dev/null')
  } finally { p.dispose() }
})
it.skipIf(process.platform !== 'linux')('keeps a non-git repository plan unchanged apart from the capability acknowledgement', () => {
  const f = fixture()
  const p = plan(f)
  try {
    expect(p.gitHistoryHidden).toBe(true)
    expect(p.withheldPaths).toEqual([])
    expect(p.line).not.toContain('withheld git history')
  } finally { p.dispose() }
})
it.skipIf(process.platform !== 'linux')('refuses when Git cannot resolve the history directories', () => {
  const f = fixture(); initialize(f)
  vi.stubEnv('PATH', join(f.root, 'missing-bin'))
  expect(() => plan(f)).toThrow('cannot resolve repository git history')
})
const bwrapWorks = process.platform === 'linux' && spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', '--', 'true'], { stdio: 'ignore' }).status === 0
it.skipIf(!bwrapWorks)('a real bubblewrap child cannot read objects or an explicitly named history file', () => {
  const f = fixture(); const object = initialize(f)
  const p = plan(f)
  try {
    const [command, args] = p.wrap('/bin/cat', [object])
    const result = spawnSync(command, args, { encoding: 'utf8' })
    expect(result.status, result.stderr).not.toBe(0)
    expect(result.stdout).not.toContain('placeholder history')
    const [probe, probeArgs] = p.wrap('/bin/cat', [join(f.repo, '.git/config')])
    expect(spawnSync(probe, probeArgs, { encoding: 'utf8' }).status).not.toBe(0)
    expect(p.unreadable([[object]])).toEqual([{ path: object, reason: null }])
    expect(p.unreadable([[object]], { exempt: [object] })).toEqual([{ path: object, reason: null }])
  } finally { p.dispose() }
})
it.skipIf(!bwrapWorks)('a real linked-worktree probe cannot read either git directory or its pointer', () => {
  const f = fixture(); const object = initialize(f)
  git(f.repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '--allow-empty', '-m', 'fixture')
  const linked = join(f.root, 'linked'); git(f.repo, 'worktree', 'add', '--detach', linked)
  const gitdir = git(linked, 'rev-parse', '--absolute-git-dir')
  const p = plan(f, linked, { paths: { readable: [f.repo] } })
  try {
    for (const file of [object, join(gitdir, 'HEAD'), join(linked, '.git')]) {
      expect(p.unreadable([[file]])).toEqual([{ path: file, reason: null }])
    }
  } finally { p.dispose() }
})
it.skipIf(!bwrapWorks)('late caller binds through an alias cannot reopen history', () => {
  const f = fixture(); initialize(f)
  const alias = join(f.root, 'history-alias'); symlinkSync(join(f.repo, '.git'), alias, 'dir')
  const p = plan(f, f.repo, { paths: { readable: [alias] } })
  try {
    expect(masked(p, join(alias, 'objects/placeholder'))).toBe(true)
    expect(p.unreadable([[join(alias, 'objects/placeholder')]])).toEqual([{ path: join(alias, 'objects/placeholder'), reason: null }])
  } finally { p.dispose() }
})
