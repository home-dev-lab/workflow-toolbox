// Read-only project inventory. Never follow an entry or interior symlink or mount.
import { lstatSync, readdirSync, realpathSync } from '../host/worktree-sweep-io.mjs'
import path from 'node:path'
import { pathContains, platformCanonicalPath, sweepMounts } from '../host/sweep-evidence.mjs'
import { readGit } from './git.mjs'

const readFailure = error => error.code ?? error.message

export function sourceBoundary(project, options) {
  const source = path.join(project, '.claude', 'worktrees')
  const mounts = options.mounts ? { status: 'known', mounts: options.mounts } : sweepMounts(options)
  try {
    const stat = lstatSync(source, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { source, reason: 'source-not-canonical' }
    if (platformCanonicalPath(realpathSync(source), options.platform) !== platformCanonicalPath(source, options.platform)) return { source, reason: 'source-not-canonical' }
    if (lstatSync(project, { bigint: true }).dev !== stat.dev || lstatSync(path.dirname(source), { bigint: true }).dev !== stat.dev) return { source, reason: 'source-mount-boundary' }
    if (mounts.status !== 'known') return { source, reason: mounts.reason }
    const crosses = mounts.mounts.some(mount => mount !== project && pathContains(project, mount) && pathContains(mount, source))
    if (crosses) return { source, reason: 'source-mount-boundary' }
    return { source, device: stat.dev, mounts: mounts.mounts, names: readdirSync(source).sort() }
  } catch (error) { return { source, reason: `source-unavailable: ${readFailure(error)}` } }
}

export function entryBoundary(file, boundary) {
  try {
    const stat = lstatSync(file, { bigint: true })
    const allowed = stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === boundary.device && !boundary.mounts.includes(file)
    return { allowed, stat }
  } catch { return { allowed: false } }
}

function recordNode(file, stat, inventory) {
  if (stat.mtimeNs > inventory.latestNs) inventory.latestNs = stat.mtimeNs
  if (stat.ctimeNs > inventory.latestNs) inventory.latestNs = stat.ctimeNs
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) { inventory.stack.push(file); return }
  if (!stat.isFile()) { inventory.special = true; return }
  const size = Number(stat.size)
  if (!Number.isSafeInteger(size)) throw new Error('file-size-unrepresentable')
  inventory.bytes += size
  inventory.files.push({ path: file, size })
}

function scanExceeded(visited, options) {
  return visited > options.maxNodes || options.clock() > options.deadline
}

export function inventoryTree(root, supplied) {
  const options = { clock: Date.now, maxNodes: 200000, ...supplied }
  const { device, mounts } = options
  const inventory = { bytes: 0, latestNs: 0n, files: [], stack: [], special: false }
  let visited = 0
  try {
    recordNode(root, lstatSync(root, { bigint: true }), inventory)
    while (inventory.stack.length) {
      const dir = inventory.stack.pop()
      for (const name of readdirSync(dir)) {
        if (scanExceeded(++visited, options)) throw new Error('scan-budget')
        const file = path.join(dir, name)
        const stat = lstatSync(file, { bigint: true })
        if (stat.dev !== device || mounts.includes(file)) throw new Error('interior-mount')
        if (name !== 'index.lock') recordNode(file, stat, inventory)
      }
    }
    return inventory
  } catch (error) { return { ...inventory, reason: `inventory-unknown: ${readFailure(error)}` } }
}

export function outsideSweep(project, source, options) {
  const paths = new Set()
  const unreadable = []
  for (const suffix of ['.claude/scripts/.worktrees', 'worktrees', '.claude/reports', '.claude/archives']) {
    const dir = path.join(project, suffix)
    try { for (const name of readdirSync(dir)) paths.add(path.join(dir, name)) } catch (error) {
      if (error.code !== 'ENOENT') unreadable.push(dir)
    }
  }
  const worktrees = readGit(project, ['worktree', 'list', '--porcelain', '-z'], options)
  if (worktrees.status === 0) {
    for (const record of worktrees.stdout.split('\0').filter(value => value.startsWith('worktree '))) {
      const file = record.slice(9)
      if (!pathContains(source, file, options.platform)) paths.add(file)
    }
  }
  return { count: paths.size, paths: [...paths].sort(), unreadable }
}
