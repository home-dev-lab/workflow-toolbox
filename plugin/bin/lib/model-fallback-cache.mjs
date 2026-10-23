// Incremental targets-only analysis of a parent transcript. The answer is always the one a full
// targets-only scan would give; the cache only decides how many bytes are read to reach it.
//
// One entry per transcript: the tracker snapshot after every complete line before `offset`, plus the
// file identity (dev, ino), two hashes (the first WINDOW bytes, and the WINDOW bytes before `offset`),
// and the hash of the serialized snapshot. A call validates the entry against the current file, scans only [offset, size), and
// writes a whole new entry atomically. Anything that does not validate is a miss: a full scan from 0.
//
// Residual, by design: an in-place rewrite that keeps the inode and the size (or grows the file) and
// changes only bytes strictly between the two hash windows is not detected: the cache assumes a transcript is only ever appended to.
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { TARGET_NEEDLE, analyseTranscript, createModelTracker } from './model-fallback-core.mjs'
import { WINDOW, scanRange } from './model-fallback-scan.mjs'
import { cacheFiles, defaultCacheBase, readModuleSources, transcriptIo } from './host/model-fallback-cache-files.mjs'
import { pluginName, resolvePluginDataDir } from './plugin-data-dir.mjs'

const MAX_ENTRY_BYTES = 4 * 1024 * 1024
const PRUNE_AGE_MS = 14 * 24 * 60 * 60 * 1000
const EMPTY = Buffer.alloc(0)
// Sibling module names, resolved against this module's URL.
const LOGIC = ['model-fallback-core.mjs', 'model-fallback-state.mjs', 'model-fallback-scan.mjs', 'model-fallback-cache.mjs']

export const LOGIC_MODULES = LOGIC.map((name) => new URL(name, import.meta.url))

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
// Each module's bytes are hashed separately, so no module can be dropped or merged unnoticed.
export const versionOf = (sources) => sha256(sources.map((bytes) => sha256(bytes)).join('\n'))
let logicVersion = null
// An entry is only as valid as the code that wrote it: its version is the hash of the modules that
// decide what a snapshot means, read once per process.
export function entryVersion() {
  logicVersion ??= versionOf(readModuleSources(LOGIC_MODULES))
  return logicVersion
}

export function cacheDirectory(env = process.env) {
  if (env.WT_MODEL_FALLBACK_CACHE_DIR) return env.WT_MODEL_FALLBACK_CACHE_DIR
  return join(resolvePluginDataDir({ env, fallback: defaultCacheBase(env), pluginName: pluginName() }).dir, 'fallback-cache')
}

export const entryPathFor = (dir, file) => join(dir, `${sha256(resolve(file))}.json`)

class CorruptState extends Error {}

// JSON errors are skipped exactly as the full scan skips them. An observe() failure on a fresh tracker
// is skipped too; on a restored tracker it may come from the snapshot, so the entry is not trusted.
const lineObserver = (tracker, strict) => (line) => {
  let record
  try { record = JSON.parse(line) } catch { return }
  try { tracker.observe(record) } catch (error) { if (strict) throw new CorruptState(error.message) }
}

function readExact(io, fd, position, length) {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const count = io.read(fd, buffer, filled, length - filled, position + filled)
    if (count <= 0) throw new Error('short read')
    filled += count
  }
  return buffer
}

const sameFile = (entry, file, stat) => entry.path === resolve(file) && entry.dev === stat.dev && entry.ino === stat.ino
const offsetFits = (entry, stat) => Number.isSafeInteger(entry.offset) && entry.offset > 0 && entry.offset <= stat.size
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
// The snapshot text was written as JSON.stringify output, so parsing and re-serializing it gives the
// same bytes; any edit to it since, even one that keeps a valid shape, changes the hash.
const snapshotIntact = (entry) => typeof entry.snapshotHash === 'string' && sha256(JSON.stringify(entry.snapshot)) === entry.snapshotHash
// A missing or non-object snapshot is a miss: never a fresh tracker resumed at the stored offset.
const entryApplies = (entry, file, stat, version) => isRecord(entry) && isRecord(entry.snapshot) && entry.version === version
  && snapshotIntact(entry) && sameFile(entry, file, stat) && offsetFits(entry, stat)
// The offset must sit just after a newline; the window ending there is already in memory.
const endsLine = (recent) => recent[recent.length - 1] === 10

function miss(context, dir) {
  try { context.files.prune(dir, PRUNE_AGE_MS, context.now()) } catch { /* pruning is housekeeping */ }
  return { hit: false, offset: 0, head: EMPTY, recent: EMPTY, headHash: null, tracker: createModelTracker(null, context.env) }
}

function loadEntry(file, fd, entryPath, stat, context) {
  try {
    // An entry file larger than any entry this code writes is not read, let alone parsed.
    const entry = JSON.parse(context.files.read(entryPath, MAX_ENTRY_BYTES))
    if (!entryApplies(entry, file, stat, context.version)) return miss(context, context.dir)
    const head = readExact(context.io, fd, 0, Math.min(WINDOW, entry.offset))
    const recent = readExact(context.io, fd, Math.max(0, entry.offset - WINDOW), Math.min(WINDOW, entry.offset))
    if (sha256(head) !== entry.headHash || sha256(recent) !== entry.tailHash || !endsLine(recent)) return miss(context, context.dir)
    return { hit: true, offset: entry.offset, head, recent, headHash: entry.headHash, tracker: createModelTracker(null, context.env, entry.snapshot) }
  } catch { return miss(context, context.dir) }
}

// Hashes come only from bytes this call already read: the validation windows and the scanned range.
function headHash(prior, scan) {
  if (prior.offset >= WINDOW) return prior.headHash
  return sha256(Buffer.concat([prior.head, scan.head]).subarray(0, Math.min(WINDOW, scan.committedEnd)))
}

function saveEntry(file, stat, prior, scan, committed, context) {
  if (scan.committedEnd === prior.offset) return false
  const identity = { version: context.version, path: resolve(file), dev: stat.dev, ino: stat.ino, offset: scan.committedEnd, headHash: headHash(prior, scan), tailHash: sha256(scan.window), snapshotHash: sha256(committed) }
  const text = `${JSON.stringify(identity).slice(0, -1)},"snapshot":${committed}}`
  try {
    // An oversized entry would be re-read on every call: keep none, so the next call scans from 0.
    if (Buffer.byteLength(text) > MAX_ENTRY_BYTES) context.files.remove(context.entryPath)
    else context.files.writeAtomic(context.entryPath, text)
    return Buffer.byteLength(text) <= MAX_ENTRY_BYTES
  } catch { return false }
}

// The unterminated last line belongs to this call's answer only: it is observed on a copy rebuilt
// from the already-serialized snapshot, so it can never leak into the saved entry.
function answerTracker(tracker, committed, tail, env) {
  if (tail === null) return tracker
  const copy = createModelTracker(null, env, JSON.parse(committed))
  lineObserver(copy, tracker.restored)(tail)
  return copy
}

function scanFrom(fd, prior, stat, context) {
  return scanRange({ io: context.io, fd, needle: TARGET_NEEDLE, start: prior.offset, end: stat.size, chunkSize: context.chunkSize, onLine: lineObserver(prior.tracker, prior.tracker.restored), recent: prior.recent })
}

function analyseOpen(file, fd, context) {
  const stat = context.io.fstat(fd)
  const prior = loadEntry(file, fd, context.entryPath, stat, context)
  let scan
  try { scan = scanFrom(fd, prior, stat, context) } catch (error) {
    if (error instanceof CorruptState) throw error
    // A transcript read failure: the plain full scan answers (unknown only if it fails too); no entry.
    return { result: plainScan(file, context), stats: { hit: prior.hit, start: prior.offset, readError: true, written: false } }
  }
  // The file ended before the size this call measured (truncated meanwhile): nothing cached is trusted.
  if (scan.end < stat.size) return { result: plainScan(file, context), stats: { hit: prior.hit, start: prior.offset, shortRead: true, written: false } }
  const committed = JSON.stringify(prior.tracker.snapshot())
  const result = answerTracker(prior.tracker, committed, scan.tail, context.env).result()
  const written = saveEntry(file, stat, prior, scan, committed, context)
  return { result, stats: { hit: prior.hit, start: prior.offset, end: scan.end, committedEnd: scan.committedEnd, written } }
}

const plainScan = (file, context) => analyseTranscript(file, { targetsOnly: true, env: context.env, io: context.io, chunkSize: context.chunkSize })

function analyseWithEntry(file, context) {
  let fd
  try { fd = context.io.open(file) } catch { return { result: plainScan(file, context), stats: { hit: false, openError: true } } }
  try { return analyseOpen(file, fd, context) } catch (error) {
    if (error instanceof CorruptState) try { context.files.remove(context.entryPath) } catch { /* the next call misses anyway */ }
    return { result: plainScan(file, context), stats: { hit: false, fallback: true } }
  } finally { context.io.close(fd) }
}

function createContext(file, options) {
  const env = options.env ?? process.env
  const dir = options.stateDir ?? cacheDirectory(env)
  return {
    env, dir, entryPath: entryPathFor(dir, file), version: options.version ?? entryVersion(),
    io: options.io ?? transcriptIo, files: options.files ?? cacheFiles, now: options.now ?? Date.now, chunkSize: options.chunkSize,
  }
}

/**
 * Same result as analyseTranscript(file, { targetsOnly: true, env }), reading only what changed since
 * the last call when a valid entry exists. Any cache-layer failure falls back to that plain scan.
 * options: stateDir, env, io (transcript reads), files (entry files), version, now, chunkSize, onStats.
 */
export function cachedTargets(file, options = {}) {
  let outcome
  try { outcome = analyseWithEntry(file, createContext(file, options)) } catch {
    outcome = { result: analyseTranscript(file, { targetsOnly: true, env: options.env ?? process.env, io: options.io, chunkSize: options.chunkSize }), stats: { hit: false, fallback: true } }
  }
  try { options.onStats?.({ ...outcome.stats, fallbacks: outcome.result.fallbacks.length }) } catch { /* a reporting callback never changes the answer */ }
  return outcome.result
}
