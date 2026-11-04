import { existsSync, spawnSync } from '../host/worktree-sweep-io.mjs'
import { hardenedGitArgs } from '../host/hardened-git.mjs'
import path from 'node:path'

const SAFE_CONFIG_ENV = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'])

function readOnlyGitEnv(env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_') || SAFE_CONFIG_ENV.has(key)))
  return { ...clean, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: '',
    GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0' }
}

export function readGit(dir, args, { env = process.env, gitRun = spawnSync, timeout = 60000, input } = {}) {
  return gitRun('git', hardenedGitArgs(['--no-optional-locks', '-c', 'core.untrackedCache=false', '-C', dir, ...args]), {
    env: readOnlyGitEnv(env),
    encoding: 'utf8', timeout, input, maxBuffer: 64 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
}

const INDEX_UNAVAILABLE = 'git index unavailable for read-only status'
const ATTRIBUTES_UNAVAILABLE = 'git attributes unavailable for read-only status'
const gitFailed = result => result.status !== 0 || result.error

function statusPaths(file, options) {
  const index = readGit(file, ['ls-files', '--stage', '-z'], options)
  if (gitFailed(index)) return { reason: INDEX_UNAVAILABLE }
  const rows = index.stdout.split('\0').filter(Boolean)
  if (rows.some(row => !/^\d{6} [0-9a-f]+ [0-3]\t/.test(row))) return { reason: INDEX_UNAVAILABLE }
  if (rows.some(row => row.startsWith('160000 '))) return { reason: 'submodule status is not executed in report mode' }
  const untracked = readGit(file, ['ls-files', '--others', '--exclude-standard', '-z'], options)
  if (gitFailed(untracked)) return { reason: INDEX_UNAVAILABLE }
  const names = [...rows.map(row => row.slice(row.indexOf('\t') + 1)), ...untracked.stdout.split('\0').filter(Boolean)]
  if (names.some(name => name.includes('\ufffd'))) return { reason: 'git paths cannot be decoded for read-only status' }
  return { names }
}

function filterRisk(stdout, count) {
  const cells = stdout.split('\0')
  if (cells.pop() !== '' || cells.length !== count * 3) return ATTRIBUTES_UNAVAILABLE
  for (let i = 0; i < cells.length; i += 3) {
    if (cells[i + 1] !== 'filter') return ATTRIBUTES_UNAVAILABLE
    if (!['unspecified', 'unset'].includes(cells[i + 2])) return 'external git filters are not executed in report mode'
  }
  return null
}

function statusRisk(file, options) {
  const paths = statusPaths(file, options)
  if (paths.reason) return paths.reason
  if (!paths.names.length) return null
  const attributes = readGit(file, ['check-attr', '-z', '--stdin', 'filter'], { ...options, input: `${paths.names.join('\0')}\0` })
  return gitFailed(attributes) ? ATTRIBUTES_UNAVAILABLE : filterRisk(attributes.stdout, paths.names.length)
}

export function resolveSweepProject(project, env = process.env) {
  const selected = project || env.CLAUDE_PROJECT_DIR
  if (selected) return path.resolve(selected)
  const root = readGit(process.cwd(), ['rev-parse', '--show-toplevel'], { env, timeout: 1000 })
  if (root.status !== 0 || !root.stdout?.trim()) throw new Error('worktree sweep: project unavailable; use --project <dir>')
  return path.resolve(root.stdout.trim())
}

function changedCount(porcelain) {
  const records = porcelain.split('\0').filter(Boolean)
  let count = 0
  for (let i = 0; i < records.length; i++) {
    count++
    if (/^[RC]|^.[RC]/.test(records[i])) i++
  }
  return count
}

function branchFor(file, options) {
  return readGit(file, ['symbolic-ref', '--short', 'HEAD'], options).stdout?.trim() || '(detached)'
}

const BASE_REFS = new Set(['refs/heads/develop', 'refs/heads/main', 'refs/heads/master'])

function headPreserved(file, options) {
  const own = readGit(file, ['symbolic-ref', '-q', 'HEAD'], options)
  if (own.error || ![0, 1].includes(own.status)) return false
  const refs = readGit(file, ['for-each-ref', '--contains=HEAD', '--format=%(refname) %(symref)',
    'refs/remotes/', ...BASE_REFS], options)
  if (gitFailed(refs)) return false
  // Neither this worktree's own branch nor a symbolic alias proves an
  // independent preserving ref. --contains tests full commit ancestry.
  return refs.stdout.split('\n').some(line => {
    const [ref, symbolic] = line.trim().split(' ')
    return !symbolic && ref !== own.stdout.trim() && (ref.startsWith('refs/remotes/') || BASE_REFS.has(ref))
  })
}

export function gitIndexLock(file, options) {
  if (!existsSync(path.join(file, '.git'))) return null
  const dir = readGit(file, ['rev-parse', '--absolute-git-dir'], options)
  return gitFailed(dir) || !dir.stdout?.trim() ? null : path.join(dir.stdout.trim(), 'index.lock')
}

export function gitVerdict(file, options) {
  // Status can execute clean/process filters, or recurse into independently
  // configured submodules. Preflight attributes/index using non-executing git
  // readers; an unsupported context is KEEP, never a side-effectful status call.
  const risk = statusRisk(file, options)
  if (risk) return { reason: 'git-status-failed', detail: risk }
  const result = readGit(file, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], options)
  if (result.status !== 0 || result.error) return { reason: 'git-status-failed' }
  const branch = branchFor(file, options)
  if (result.stdout.length) return { reason: 'uncommitted', branch, changedFiles: changedCount(result.stdout) }
  const dir = readGit(file, ['rev-parse', '--absolute-git-dir'], options)
  if (dir.status !== 0 || !dir.stdout?.trim()) return { reason: 'git-status-failed', branch }
  const busy = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']
    .some(name => existsSync(path.join(dir.stdout.trim(), name)))
  if (busy) return { branch, reason: 'operation-in-progress' }
  if (!headPreserved(file, options)) return { branch, reason: 'commits not preserved elsewhere' }
  return { branch }
}

export function reachableObjects(repositories, options) {
  const objects = new Set()
  const seen = new Set()
  for (const dir of repositories) {
    const common = readGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], options)
    if (common.status !== 0 || seen.has(common.stdout.trim())) continue
    seen.add(common.stdout.trim())
    const result = readGit(dir, ['rev-list', '--objects', '--all'], options)
    if (result.status !== 0) continue
    for (const line of result.stdout.split('\n')) if (/^[0-9a-f]{40,64}(?: |$)/.test(line)) objects.add(line.split(' ')[0])
  }
  return objects
}

export function baseProven(file, inventory, objects, options) {
  if (inventory.special || inventory.reason || !inventory.files.length) return false
  for (const node of inventory.files) {
    if (options.budget.bytes + node.size > 5 * 1024 ** 3) return false
    options.budget.bytes += node.size
    const result = readGit(file, ['hash-object', '--no-filters', '--', node.path], options)
    if (result.status !== 0 || !objects.has(result.stdout.trim())) return false
  }
  return true
}

export function archiveLimit(file, inventory, options) {
  const files = inventory.files.filter(node => !node.path.slice(file.length + 1).split(path.sep).some(part => ['.git', 'node_modules'].includes(part)))
  if (inventory.special || files.reduce((sum, node) => sum + node.size, 0) > 2 * 1024 ** 3) return true
  const large = files.filter(node => node.size > 100 * 1024 ** 2).map(node => node.path)
  if (!large.length) return false
  const result = readGit(file, ['check-ignore', '-z', '--stdin'], { ...options, gitRun: options.gitRun ?? ((cmd, args, opts) => spawnSync(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'], input: `${large.join('\0')}\0` })) })
  return result.status !== 1 // error/timeout is not proof that large files are safe
}
