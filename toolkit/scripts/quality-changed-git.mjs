import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function git(root, args, env = process.env) {
  return execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })
}
export function resolveBase(root, ref) {
  try {
    if (ref) return git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim()
    const base = git(root, ['merge-base', 'HEAD', 'develop']).trim()
    const parents = git(root, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ')
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
export function changedFiles(root, base, subject) {
  if (subject) return parseDiff(git(root, ['diff', '-M', '--name-status', '-z', base, subject, '--']))
  const temp = mkdtempSync(join(tmpdir(), 'wt-quality-index-'))
  try {
    const index = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim()
    mkdirSync(join(temp, 'objects'))
    const objects = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']).trim()
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index'),
      GIT_OBJECT_DIRECTORY: join(temp, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects }
    if (existsSync(index)) copyFileSync(index, env.GIT_INDEX_FILE)
    else git(root, ['read-tree', 'HEAD'], env)
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    for (const file of untracked) git(root, ['add', '--intent-to-add', '--', file], env)
    return parseDiff(git(root, ['diff', '-M', '--name-status', '-z', base, '--'], env))
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
export const readSubject = (root, ref, file) => ref ? git(root, ['show', `${ref}:${file}`]) : readFileSync(join(root, file), 'utf8')
