// Read-only project inventory. Never follow an entry or interior symlink or mount.
import { existsSync, lstatSync, readdirSync, realpathSync } from '../host/worktree-sweep-io.mjs'
import path from 'node:path'
import { pathContains, platformCanonicalPath, sweepMounts } from '../host/sweep-evidence.mjs'
import { readGit } from './git.mjs'

const readFailure = error => error.code ?? error.message

function registryFlag(field, name) {
  return field === name || field.startsWith(`${name} `)
}

function registryPaths(platform) {
  // A mocked process reader can be Linux while fixture files still live on NTFS.
  return platform === 'win32' || path === path.win32 ? path.win32 : path.posix
}

function directRegistryChild(root, file, platform) {
  const paths = registryPaths(platform)
  const flavour = paths === path.win32 ? 'win32' : platform
  const source = platformCanonicalPath(paths.resolve(root), flavour)
  const target = platformCanonicalPath(paths.resolve(file), flavour)
  const parent = paths.dirname(target)
  return pathContains(source, target, flavour) && pathContains(source, parent, flavour) && pathContains(parent, source, flavour)
}

function parseRegistry(stdout, platform) {
  const records = []
  let current = null
  for (const field of stdout.split('\0')) {
    if (field.startsWith('worktree ')) {
      current = { path: field.slice(9), locked: false, prunable: false }
      if (!registryPaths(platform).isAbsolute(current.path)) throw new Error('invalid worktree path')
      records.push(current)
    } else if (current && registryFlag(field, 'locked')) current.locked = true
    else if (current && registryFlag(field, 'prunable')) current.prunable = true
    else if (!field) current = null
  }
  if (!records.length) throw new Error('empty worktree registry')
  return records
}

function mergeRegistration(records, record, platform, names) {
  const paths = registryPaths(platform)
  const basename = paths.basename(paths.resolve(record.path))
  const canonical = value => paths === path.win32 ? value.toLowerCase() : value
  const name = [...names, ...records.keys()].find(candidate => canonical(candidate) === canonical(basename)) ?? basename
  const previous = records.get(name)
  records.set(name, { ...record, locked: record.locked || previous?.locked, prunable: record.prunable || previous?.prunable })
}

function worktreeRegistry(project, boundary, options) {
  const records = new Map()
  const outside = new Set()
  let unknown = false
  const repositories = [project, ...boundary.names.map(name => path.join(boundary.source, name))
    .filter(file => entryBoundary(file, boundary).allowed)]
  for (const repo of repositories.filter(file => existsSync(path.join(file, '.git')))) {
    try {
      const result = readGit(repo, ['worktree', 'list', '--porcelain', '-z'], options)
      if (result.status !== 0 || result.error) throw new Error('worktree registry unavailable')
      for (const record of parseRegistry(result.stdout, options.platform)) {
        if (!directRegistryChild(boundary.source, record.path, options.platform)) {
          outside.add(record.path); continue
        }
        mergeRegistration(records, record, options.platform, boundary.names)
      }
    } catch { unknown = true }
  }
  return { records, unknown, outside: [...outside] }
}

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
    const boundary = { source, device: stat.dev, mounts: mounts.mounts, names: readdirSync(source).sort() }
    const registry = worktreeRegistry(project, boundary, options)
    return { ...boundary, registry, names: [...new Set([...boundary.names, ...registry.records.keys()])].sort() }
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
  // Another worktree can change a shared inode's link count without writing it.
  if (stat.ctimeNs > inventory.latestNs && !(stat.isFile() && stat.nlink > 1n)) inventory.latestNs = stat.ctimeNs
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

export function isIndexLock(file, node, indexLock) {
  if (!node.isFile() || !indexLock) return false
  // Git and native directory reads can disagree on Windows drive-letter case.
  const canonical = value => path === path.win32 ? path.resolve(value).toLowerCase() : path.resolve(value)
  return canonical(file) === canonical(indexLock)
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
        if (!isIndexLock(file, stat, options.indexLock)) recordNode(file, stat, inventory)
      }
    }
    return inventory
  } catch (error) { return { ...inventory, reason: `inventory-unknown: ${readFailure(error)}` } }
}

export function outsideSweep(project, source, options) {
  const paths = new Set(options.registry?.outside)
  const platform = registryPaths(options.platform) === path.win32 ? 'win32' : options.platform
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
      if (!pathContains(source, file, platform)) paths.add(file)
    }
  }
  return { count: paths.size, paths: [...paths].sort(), unreadable }
}
