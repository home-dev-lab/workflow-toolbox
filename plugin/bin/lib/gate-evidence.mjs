// Shared gate-record format and tree signature. A record is useful only for the exact tree it ran on.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { defaultGuardJournalDir } from './guard-journal-read.mjs'

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

export function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim()
}

/** null when the repository declares no gates — the guard is opt-in by that file, and an absent file
 *  must read as "not declared", never as a fail-open trace on every commit in every other repository. */
export function readGateDeclaration(root) {
  const file = path.join(root, '.wt-gates.json')
  if (!fs.existsSync(file)) return null
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed?.gates) || !Array.isArray(parsed?.paths)) throw new Error('invalid .wt-gates.json')
  return parsed
}

export function treeSignature(root) {
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .sort()
    .join('\0')
  const hash = createHash('sha256')
  for (const value of [git(root, ['rev-parse', 'HEAD']), git(root, ['diff', '--cached']), git(root, ['diff']), untracked]) {
    hash.update(value)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function recordPath(root, name) {
  const repoId = createHash('sha256').update(root).digest('hex')
  return path.join(defaultGuardJournalDir(), 'wt-gate-records', repoId, `${name}.json`)
}

export function writeGateRecord(root, record) {
  const target = recordPath(root, record.name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(record)}\n`)
  return target
}

export function readGateRecord(root, name) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(root, name), 'utf8'))
  } catch {
    return null
  }
}

export function stagedPaths(root) {
  return git(root, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean)
}

export function touchesDeclaredPath(paths, declaredPaths) {
  return paths.some((file) => declaredPaths.some((prefix) => file.startsWith(prefix)))
}

export function recordIsFresh(root, record, signature, paths) {
  if (!record || record.exit !== 0 || record.tree !== signature) return false
  const finishedAt = Date.parse(record.finishedAt)
  if (!Number.isFinite(finishedAt)) return false
  return paths.every((file) => {
    try {
      return fs.statSync(path.join(root, file)).mtimeMs <= finishedAt
    } catch {
      return false
    }
  })
}
