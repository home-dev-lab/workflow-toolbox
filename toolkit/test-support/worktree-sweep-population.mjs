// Executable fixture specification: four of each shape plus the owning repository.
import { chmodSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, repository } from './worktree-sweep-fixture.mjs'

const UNKNOWN = 'liveness unknown: not in the host PID namespace'
export const populationShapes = [
  ['clean-linked', UNKNOWN], ['dirty-tracked', 'uncommitted'], ['untracked', 'uncommitted'],
  ['staged', 'uncommitted'], ['mid-merge', 'operation-in-progress'], ['detached', UNKNOWN],
  ['clean-export', UNKNOWN], ['dirty-export', 'uncommitted'], ['proven.base', UNKNOWN],
  ['foreign.base', 'base-unproven'], ['no-git', 'no-git'], ['lane-files', UNKNOWN],
  ['modules-link', UNKNOWN], ['read-only', UNKNOWN], ['symlink', 'not-an-entry'], ['recent', 'recent'],
]

function linked(f, main, name, detached = false) {
  const dir = join(f.source, name)
  const flag = detached ? ['--detach'] : ['-b', name]
  git(main, f.env, 'worktree', 'add', '-q', ...flag, dir)
  return dir
}

function editShape(f, entry, shape) {
  if (shape.startsWith('dirty') || shape === 'staged') writeFileSync(join(entry, 'tracked'), 'local edit\n')
  if (shape === 'staged') git(entry, f.env, 'add', 'tracked')
  if (shape === 'untracked') writeFileSync(join(entry, 'new-file'), 'local addition\n')
  if (shape === 'mid-merge') {
    const gitDir = git(entry, f.env, 'rev-parse', '--absolute-git-dir').trim()
    writeFileSync(join(gitDir, 'MERGE_HEAD'), git(entry, f.env, 'rev-parse', 'HEAD'))
  }
  if (shape === 'recent') utimesSync(join(entry, 'tracked'), f.now / 1000, f.now / 1000)
}

function ignoredShape(f, entry, shape, restore) {
  if (shape === 'lane-files') {
    mkdirSync(join(entry, '.lane'))
    for (const file of ['report.md', 'gate.log', 'review.diff']) writeFileSync(join(entry, '.lane', file), `keep ${file}\n`)
  }
  if (shape === 'modules-link') { mkdirSync(join(entry, 'node_modules')); symlinkSync(f.root, join(entry, 'node_modules', 'outside')) }
  if (shape === 'read-only') {
    const locked = join(entry, 'ignored'); mkdirSync(locked); writeFileSync(join(locked, 'file'), 'keep\n')
    chmodSync(locked, 0o555); restore.push(() => chmodSync(locked, 0o755))
  }
}

function buildShape(f, main, shape, name, restore) {
  const dir = join(f.source, name)
  if (shape === 'symlink') { symlinkSync(main, dir); return }
  if (shape.endsWith('.base') || shape === 'no-git') {
    mkdirSync(dir)
    writeFileSync(join(dir, 'tracked'), shape === 'proven.base' ? 'committed\n' : 'foreign bytes\n')
    return
  }
  const entry = shape.endsWith('export') ? repository(f, name) : linked(f, main, name, shape === 'detached')
  editShape(f, entry, shape)
  ignoredShape(f, entry, shape, restore)
}

export function populate(f) {
  const main = repository(f, 'main')
  const expected = { main: UNKNOWN }
  const restore = []
  for (let round = 0; round < 3; round++) {
    for (const [shape, reason] of populationShapes) {
      const name = shape.endsWith('.base') ? `${shape.slice(0, -5)}-${round}.base` : `${shape}-${round}`
      buildShape(f, main, shape, name, restore)
      expected[name] = reason
    }
  }
  return { expected, restore: () => { for (const reset of restore) reset() } }
}
