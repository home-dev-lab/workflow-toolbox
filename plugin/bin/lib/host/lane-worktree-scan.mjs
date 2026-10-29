import { lstatSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const SKIPPED = new Set(['.git', 'node_modules', '.pnpm', 'dist', 'build', 'coverage', '.next'])
const unknown = (bounded = false) => ({ at: null, bounded, status: 'unknown' })

function skippedEntry(root, dir, name) {
  return SKIPPED.has(name) || (dir === path.join(root, '.lane') && /^supervision(?:-[A-Za-z0-9._-]+)?$/.test(name))
}

function recordEntry(scan, full, stat) {
  // Observe the link itself, never its target (which can be our own supervision record).
  // Directory times include excluded supervisor writes; file membership is tracked separately.
  if (stat.mtimeMs > scan.latest) { scan.latest = stat.mtimeMs; scan.latestPath = full }
  if (stat.isDirectory()) { scan.entries.push(JSON.stringify([full, 'directory'])); scan.stack.push(full); return }
  scan.entries.push(JSON.stringify([full, stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino, stat.mode]))
}

// One exact read per path gives identity and metadata together: NTFS file ids exceed 2^53, and a
// second read could observe another file than the first.
function observation(stat) {
  if (typeof stat?.ino !== 'bigint' || stat.ino <= 0n) throw new Error('filesystem identity unavailable')
  const metadata = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)
  return { identity: `${stat.dev}:${stat.ino}`, mtimeMs: Number(stat.mtimeNs) / 1e6, metadata }
}

function recordIdleEntry(scan, full, stat, readTargetStat) {
  const own = observation(stat)
  const target = stat.isSymbolicLink() ? observation(readTargetStat(full, { bigint: true })) : own
  if (scan.excluded.has(own.identity) || scan.excluded.has(target.identity)) return
  if (target.mtimeMs > scan.latest) { scan.latest = target.mtimeMs; scan.latestPath = full }
  scan.entries.push(JSON.stringify([full, own.metadata, target.metadata]))
  if (stat.isDirectory()) scan.stack.push(full)
}

function collectEntries(root, scan, maxEntries, readDirectory, readStat, record = recordEntry, skip = skippedEntry) {
  let visited = 0
  while (scan.stack.length) {
    const dir = scan.stack.pop()
    for (const entry of readDirectory(dir, { withFileTypes: true })) {
      if (++visited > maxEntries) return false
      if (skip(root, dir, entry.name)) continue
      const full = path.join(dir, entry.name)
      record(scan, full, readStat(full))
    }
  }
  return true
}

function recordIdleRoot(scan, root, readStat, record) {
  const stat = readStat(root)
  if (!stat.isDirectory()) throw new Error('worktree root is not a directory')
  record(scan, root, stat)
}

function scanResult(scan) {
  const fingerprint = createHash('sha256').update(JSON.stringify(scan.entries.sort())).digest('hex')
  return { at: scan.latest || null, path: scan.latestPath, fingerprint, bounded: false, status: 'known' }
}

// The idle consumer opts into the complete signal; legacy diagnostic callers retain their API.
export function scanIdleWorktree(root, { maxEntries = 4000, readDirectory = readdirSync, readStat = lstatSync, readTargetStat = statSync, excludedFiles = [] } = {}) {
  if (maxEntries < 0) return unknown(true)
  const scan = { stack: [], entries: [], latest: 0, latestPath: null, excluded: new Set() }
  try {
    scan.excluded = new Set(excludedFiles.map((file) => observation(readTargetStat(file, { bigint: true })).identity))
    const readExact = (file) => readStat(file, { bigint: true })
    const record = (state, full, stat) => recordIdleEntry(state, full, stat, readTargetStat)
    recordIdleRoot(scan, root, readExact, record)
    if (!collectEntries(root, scan, maxEntries, readDirectory, readExact, record, () => false)) return unknown(true)
  } catch (error) { return { ...unknown(), reason: `idle filesystem read failed: ${error.message}` } }
  return scanResult(scan)
}

function deadlineDirectoryEntries(dir) {
  try { return readdirSync(dir, { withFileTypes: true }) } catch { return null }
}

function recordDeadlineEntry(scan, full, entry) {
  try {
    const stat = statSync(full)
    if (stat.mtimeMs > scan.latest) { scan.latest = stat.mtimeMs; scan.latestPath = full }
    if (entry.isDirectory()) scan.stack.push(full)
  } catch {}
}

// Base scanner, including its failure and symlink semantics. Never feed idle-only metadata here.
export function scanDeadlineWorktree(root, { maxEntries = 4000 } = {}) {
  if (maxEntries < 0) return { at: null, bounded: true, status: 'unknown' }
  const scan = { stack: [root], latest: 0, latestPath: null }
  let visited = 0
  while (scan.stack.length) {
    const dir = scan.stack.pop()
    const entries = deadlineDirectoryEntries(dir)
    if (entries === null) continue
    for (const entry of entries) {
      if (++visited > maxEntries) return { at: null, bounded: true, status: 'unknown' }
      if (skippedEntry(root, dir, entry.name)) continue
      const full = path.join(dir, entry.name)
      recordDeadlineEntry(scan, full, entry)
    }
  }
  return { at: scan.latest || null, path: scan.latestPath, bounded: false, status: 'known' }
}

export function scanWorktree(root, { maxEntries = 4000, readDirectory = readdirSync, readStat = lstatSync } = {}) {
  if (maxEntries < 0) return unknown(true)
  const scan = { stack: [root], entries: [], latest: 0, latestPath: null }
  try {
    if (!collectEntries(root, scan, maxEntries, readDirectory, readStat)) return unknown(true)
  } catch { return unknown() }
  const fingerprint = createHash('sha256').update(JSON.stringify(scan.entries.sort())).digest('hex')
  return { at: scan.latest || null, path: scan.latestPath, fingerprint, bounded: false, status: 'known' }
}
