import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync, readFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function git(root, args, env = process.env, execute = execFileSync) {
  return execute('git', ['-C', root, ...args], { env: { ...env, GIT_NO_LAZY_FETCH: '1' },
    timeout: 120000, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })
}
export function resolveCommit(root, ref) {
  if (ref.startsWith('-')) throw new Error('revision must not start with a dash')
  return git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim()
}
export function resolveBase(root, ref) {
  try {
    if (ref) return resolveCommit(root, ref)
    const head = resolveCommit(root, 'HEAD'), develop = resolveCommit(root, 'develop')
    const base = git(root, ['merge-base', head, develop]).trim()
    if (git(root, ['branch', '--show-current']).trim() !== 'develop') return base
    const parents = git(root, ['rev-list', '--parents', '-n', '1', head, '--']).trim().split(' ')
    return base === parents[0] && parents.length > 2 ? parents[1] : base
  } catch { throw new Error('cannot resolve base; pass --base <ref> or WT_QUALITY_BASE (fetch develop history)') }
}
export function inScope(file) {
  return /\.(mjs|js|ts|mts|cts)$/.test(file)
    && !/(^|\/)(dist|node_modules|fixtures)\//.test(file)
    && file !== 'plugin/bin/lib/vendor/yaml.mjs'
}
function parseDiff(text) {
  const fields = text.split('\0').filter(Boolean), files = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i++], old = fields[i++]
    const file = status.startsWith('R') ? fields[i++] : old
    if (!'DAMRT'.includes(status[0])) throw new Error(`unsupported diff status ${status}`)
    if (status[0] !== 'D' && inScope(file)) files.push({ path: file, source: old, added: 'AT'.includes(status[0]) || !inScope(old) })
  }
  return files
}
function clearIndexFlags(root, env) {
  const flagged = git(root, ['ls-files', '-v', '-z'], env).split('\0')
    .filter((entry) => /^[a-zS]/.test(entry)).map((entry) => entry.slice(2))
  if (!flagged.length) return
  // update-index applies one flag action per invocation.
  for (const flag of ['--no-assume-unchanged', '--no-skip-worktree']) {
    git(root, ['update-index', flag, '--', ...flagged], env)
  }
}
export function changedFiles(root, base, subject) {
  if (subject) return parseDiff(git(root, ['diff', '-M', '--name-status', '-z', base, subject, '--']))
  const temp = mkdtempSync(join(tmpdir(), 'wt-quality-index-'))
  try {
    const index = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim()
    mkdirSync(join(temp, 'objects'))
    const objects = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']).trim()
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index'),
      GIT_OBJECT_DIRECTORY: join(temp, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objects) }
    if (existsSync(index)) copyFileSync(index, env.GIT_INDEX_FILE)
    else git(root, ['read-tree', 'HEAD'], env)
    clearIndexFlags(root, env)
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(inScope)
    if (untracked.length) git(root, ['add', '--intent-to-add', '--', ...untracked], env)
    return parseDiff(git(root, ['diff', '-M', '--name-status', '-z', base, '--'], env))
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
export function isCodeSubject(root, ref, file) {
  if (ref) return !git(root, ['ls-tree', '-z', ref, '--', file]).startsWith('120000 ')
  const stat = lstatSync(join(root, file))
  if (stat.isSymbolicLink()) return false
  if (!stat.isFile()) throw new Error(`unsupported non-regular code file: ${file}`)
  return true
}
export const readSubject = (root, ref, file) => ref ? git(root, ['show', `${ref}:${file}`]) : readFileSync(join(root, file), 'utf8')
