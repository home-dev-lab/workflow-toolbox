// Read-only project inventory. Never follow an entry or interior symlink or mount.
import { existsSync, lstatSync, readdirSync, realpathSync } from '../host/worktree-sweep-io.mjs'
import path from 'node:path'
import { pathContains, platformCanonicalPath, sweepMounts } from '../host/sweep-evidence.mjs'
import { sweepPathIdentity } from '../host/sweep-path-identity.mjs'
import { readGit } from './git.mjs'

const readFailure = error => error.code ?? error.message
const pathIdentity = options => options.identity ?? sweepPathIdentity(options)

function registryFlag(field, name) {
  return field === name || field.startsWith(`${name} `)
}

function registryKey(file, source, identity, names = []) {
  const { paths, fold, foldName } = identity
  const basename = foldName(paths.basename(file))
  const nearby = names.some(name => foldName(name) === basename)
    || fold(paths.parse(paths.resolve(file)).root) === fold(paths.parse(paths.resolve(source)).root)
  return nearby ? identity.key(file) : fold(file)
}

function parseRegistry(stdout, identity) {
  const records = []
  let current = null
  for (const field of stdout.split('\0')) {
    if (field.startsWith('worktree ')) {
      current = { path: field.slice(9), locked: false, prunable: false }
      if (!identity.paths.isAbsolute(current.path)) throw new Error('invalid worktree path')
      records.push(current)
    } else if (current && registryFlag(field, 'locked')) current.locked = true
    else if (current && registryFlag(field, 'prunable')) current.prunable = true
    else if (!field) current = null
  }
  if (!records.length) throw new Error('empty worktree registry')
  return records
}

function mergeRegistration(records, record, identity, names) {
  const basename = identity.paths.basename(identity.paths.resolve(record.path))
  const candidates = [...new Set([...names, ...records.keys()])]
  const matches = candidates.includes(basename) ? [basename]
    : candidates.filter(candidate => identity.foldName(candidate) === identity.foldName(basename))
  for (const name of matches.length ? matches : [basename]) {
    const previous = records.get(name)
    records.set(name, { ...record, locked: record.locked || previous?.locked, prunable: record.prunable || previous?.prunable })
  }
}

function addRegistryRecord(record, boundary, records, outside) {
  const { identity, source, names } = boundary
  const target = registryKey(record.path, source, identity, names)
  if (identity.paths.dirname(target) !== identity.key(source)) { outside.add(record.path); return }
  mergeRegistration(records, record, identity, names)
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
      for (const record of parseRegistry(result.stdout, boundary.identity)) addRegistryRecord(record, boundary, records, outside)
    } catch { unknown = true }
  }
  return { records, unknown, outside: [...outside] }
}

export function sourceBoundary(project, options) {
  const identity = pathIdentity(options)
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
    const boundary = { source, identity, device: stat.dev, mounts: mounts.mounts, names: readdirSync(source).sort() }
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

export function isIndexLock(file, node, indexLock, identity = sweepPathIdentity(), indexLockKey) {
  if (!node.isFile() || !indexLock) return false
  if (identity.foldName(identity.paths.basename(file)) !== 'index.lock') return false
  return identity.key(file) === (indexLockKey ?? identity.key(indexLock))
}

export function inventoryTree(root, supplied) {
  const options = { clock: Date.now, maxNodes: 200000, ...supplied }
  const identity = pathIdentity(options)
  const indexLockKey = options.indexLockKey ?? (options.indexLock ? identity.key(options.indexLock) : null)
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
        if (!isIndexLock(file, stat, options.indexLock, identity, indexLockKey)) recordNode(file, stat, inventory)
      }
    }
    return inventory
  } catch (error) { return { ...inventory, reason: `inventory-unknown: ${readFailure(error)}` } }
}

function outsideRegistry(project, options, identity) {
  if (options.registry) return options.registry
  if (!existsSync(path.join(project, '.git'))) return { outside: [], unknown: false }
  try {
    const result = readGit(project, ['worktree', 'list', '--porcelain', '-z'], options)
    if (result.status !== 0 || result.error) return { outside: [], unknown: true }
    return { outside: parseRegistry(result.stdout, identity).map(record => record.path), unknown: false }
  } catch { return { outside: [], unknown: true } }
}

function outsideMeasurements(paths, unreadable, registry) {
  const reason = registry.unknown ? 'worktree-registry-unavailable' : unreadable.length ? 'outside-dirs-unreadable' : null
  const complete = reason === null
  return { count: complete ? paths.size : null, paths: [...paths.values()].sort(), unreadable, complete, reason }
}

export function outsideSweep(project, source, options) {
  const identity = pathIdentity(options)
  const registry = outsideRegistry(project, options, identity)
  const paths = new Map()
  for (const file of registry.outside) {
    const key = registryKey(file, source, identity)
    if (options.registry || !identity.lexicalContains(identity.key(source), key)) paths.set(key, file)
  }
  const unreadable = []
  for (const suffix of ['.claude/scripts/.worktrees', 'worktrees', '.claude/reports', '.claude/archives']) {
    const dir = path.join(project, suffix)
    try { for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      paths.set(identity.key(file), file)
    } } catch (error) {
      if (error.code !== 'ENOENT') unreadable.push(dir)
    }
  }
  return outsideMeasurements(paths, unreadable, registry)
}
