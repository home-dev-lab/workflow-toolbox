import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createProcfs } from '../../plugin/bin/lib/host/procfs.mjs'

// Mutation experiments may select an isolated plugin copy. Normal checkouts use
// the installed source tree and require no lane/reference directory.
export function sweepModule(relative) {
  const root = process.env.WT_SWEEP_TEST_PLUGIN_ROOT
  return root ? pathToFileURL(join(root, relative)).href : new URL(`../../plugin/${relative}`, import.meta.url).href
}

export function fixture(gitExecutable) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-sweep-')))
  const project = join(root, 'project')
  const source = join(project, '.claude', 'worktrees')
  mkdirSync(source, { recursive: true })
  mkdirSync(join(root, 'bin'))
  const globalConfig = join(root, 'git-global.config')
  writeFileSync(globalConfig, '')
  const env = { HOME: root, CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'), SystemRoot: process.env.SystemRoot, TZ: 'UTC', LC_ALL: 'C',
    WT_WORKTREE_SWEEP_MODE: 'report',
    GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }
  // Resolve git once; application invocations can then pin PATH to this directory.
  const gitPath = gitExecutable ?? execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]
  symlinkSync(gitPath, join(root, 'bin', process.platform === 'win32' ? 'git.exe' : 'git'))
  env.PATH = join(root, 'bin')
  const procRoot = join(root, 'proc')
  mkdirSync(join(procRoot, 'self'), { recursive: true })
  writeFileSync(join(procRoot, 'self', 'mountinfo'), '1 0 0:1 / / rw - tmpfs tmpfs rw\n')
  const procfs = createProcfs({ root: procRoot, platform: 'linux' })
  env.WT_SWEEP_PROC_ROOT = procRoot
  const now = Date.UTC(2035, 0, 1)
  env.WT_SWEEP_NOW = String(now)
  const options = { project, env, now, platform: 'linux', procfs,
    hostNamespace: { status: 'known' }, uid: process.getuid?.() ?? 0 }
  return { root, project, source, env, procRoot, procfs, now, options }
}

export function git(dir, env, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function repository(f, name = 'clean') {
  const dir = join(f.source, name)
  mkdirSync(dir)
  git(dir, f.env, 'init', '-q')
  writeFileSync(join(dir, 'tracked'), 'committed\n')
  writeFileSync(join(dir, '.gitignore'), '.lane/\nignored\nnode_modules/\n')
  git(dir, f.env, 'add', '.')
  git(dir, f.env, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture')
  // Model a fetched/pushed commit without contacting a network. Tests for local-only
  // work explicitly remove or leave this ref behind before creating new commits.
  git(dir, f.env, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  return dir
}

// Includes directory and symlink metadata, so a hidden state-directory creation is observable.
export function fingerprint(root) {
  const rows = []
  function visit(file) {
    const stat = lstatSync(file, { bigint: true })
    let value = null
    if (stat.isFile()) value = createHash('sha256').update(readFileSync(file)).digest('hex')
    if (stat.isSymbolicLink()) value = readlinkSync(file)
    rows.push([file.slice(root.length), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), value])
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(join(file, name))
  }
  visit(root)
  return rows
}
