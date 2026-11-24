import { closeSync, constants, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { laneHostStateRoot } from './lane-host-dir.mjs'
import { refuseEventSymlink } from './launcher-event-io.mjs'

const pause = new Int32Array(new SharedArrayBuffer(4))
const SHARING_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES'])
export const eventName = () => `${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`

export function eventReason(options, reason, error) {
  const prefix = `${reason}`
  const detail = error ? `: ${error.code ?? error.message}` : ''
  const text = (prefix + detail).replace(/[\r\n\u2028\u2029]/g, ' ')
  try { (options.reportReason ?? ((line) => process.stderr.write(`${line}\n`)))(text) } catch { /* diagnostics cannot change a caller's exit */ }
  return { ok: false, reason: text }
}

export function eventOperation(kind, from, to, options) {
  const operation = options[kind] ?? (kind === 'link' ? linkSync : renameSync)
  for (let attempt = 0; attempt < 4; attempt++) {
    try { operation(from, to); return } catch (error) {
      if ((options.platform ?? process.platform) !== 'win32' || !SHARING_ERRORS.has(error.code)) throw error
      if (attempt === 3) throw Object.assign(new Error(`windows-sharing-retry-exhausted ${kind}: ${error.code}`), { code: `windows-sharing-retry-exhausted ${error.code}` })
      Atomics.wait(pause, 0, 0, 5 * (attempt + 1))
    }
  }
}

export function privateEventDirectory(directory) {
  refuseEventSymlink(directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (!info.isDirectory()) throw new Error('launcher-storage-not-directory')
  if (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077))) throw new Error('launcher-storage-not-private')
  return directory
}

export function eventPaths(id, options) {
  const root = privateEventDirectory(path.join(path.dirname(options.stateRoot ?? laneHostStateRoot()), 'wt-launcher-events'))
  const box = privateEventDirectory(path.join(root, id))
  const pending = privateEventDirectory(path.join(box, 'pending'))
  const done = privateEventDirectory(path.join(box, 'done'))
  const tmp = privateEventDirectory(path.join(box, 'tmp'))
  const keys = privateEventDirectory(path.join(box, 'keys'))
  return { root, box, pending, done, tmp, keys }
}

export function eventNames(directory) {
  try { return readdirSync(directory).filter((name) => /^\d+-\d+-[A-Za-z0-9-]+\.json$/.test(name)).sort() }
  catch (error) { if (error.code === 'ENOENT') { return [] } throw error }
}

export function readEvent(file) {
  refuseEventSymlink(file)
  const value = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof value?.key !== 'string' || typeof value.line !== 'string' || !Number.isFinite(value.at)) throw new Error('invalid-launcher-event')
  return value
}

export function removeEventFile(file, options) {
  try { unlinkSync(file); return true } catch (error) {
    if (error.code === 'ENOENT') return true
    eventReason(options, 'launcher-cleanup-failed', error)
    return false
  }
}

function keyFile(paths, key) {
  return path.join(paths.keys, `${createHash('sha256').update(key).digest('hex')}.key`)
}

function reserveEvent(paths, stage, entry, options) {
  const file = keyFile(paths, entry.key)
  try { eventOperation('link', stage, file, options); return null }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  return readEvent(file)
}

export function finishPublication(paths, entry, options) {
  const source = path.join(paths.tmp, `${entry.name.slice(0, -5)}.ready`)
  // A single rename consumes the source. Concurrent helpers cannot recreate it,
  // even if the first reader has already claimed or acknowledged the destination.
  try { eventOperation('rename', source, path.join(paths.pending, entry.name), options) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  return entry
}

export function recoverPublications(paths, options) {
  for (const name of readdirSync(paths.tmp)) {
    if (!/^\d+-\d+-[A-Za-z0-9-]+\.ready$/.test(name)) continue
    try {
      // A ready file can still be in flight or belong to a losing publisher.
      // Only the completed source belonging to the durable reservation may move.
      const base = name.slice(0, -6)
      if (lstatSync(path.join(paths.tmp, `${base}.tmp`)).nlink < 2) continue
      const entry = readEvent(path.join(paths.tmp, name))
      if (entry.name !== `${base}.json` || readEvent(keyFile(paths, entry.key)).name !== entry.name) continue
      finishPublication(paths, entry, options)
    } catch (error) { if (error.code !== 'ENOENT') eventReason(options, 'launcher-publication-recovery-failed', error) }
  }
}

function writePublication(fd, ready, entry) {
  const text = JSON.stringify(entry)
  writeFileSync(fd, text)
  const source = openSync(ready, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try { writeFileSync(source, text) } finally { closeSync(source) }
}

function publicationBase(attempt, options) {
  return attempt === 0 ? (options.name?.() ?? eventName()) : eventName()
}

export function publishEvent(paths, entry, options) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const base = publicationBase(attempt, options)
    const stage = path.join(paths.tmp, `${base}.tmp`), name = `${base}.json`
    const ready = path.join(paths.tmp, `${base}.ready`)
    let fd, reserved = false
    try { fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600) }
    catch (error) { if (error.code === 'EEXIST') { continue } throw error }
    try {
      writePublication(fd, ready, { ...entry, name }); closeSync(fd); fd = undefined
      const previous = reserveEvent(paths, stage, entry, options)
      if (previous) {
        removeEventFile(stage, options); removeEventFile(ready, options)
        return finishPublication(paths, previous, options)
      }
      reserved = true
      // The key and retained staging link survive publication, claims and done.
      return finishPublication(paths, { ...entry, name }, options)
    } catch (error) {
      // After reservation, leave the complete source for a later sweep to finish.
      if (!reserved) { removeEventFile(stage, options); removeEventFile(ready, options) }
      throw error
    }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  throw new Error('launcher-name-collision-exhausted')
}

// Seven days exceeds the completion scan's one-day lookback. Never evict pending claims.
export function pruneDone(paths, options) {
  const cutoff = (options.now ?? Date.now()) - 7 * 24 * 60 * 60 * 1000
  for (const name of eventNames(paths.done)) {
    try {
      const file = path.join(paths.done, name)
      if (lstatSync(file).mtimeMs < cutoff) {
        const event = readEvent(file)
        if (!removeEventFile(file, options)) continue
        removeEventFile(path.join(paths.tmp, `${name.slice(0, -5)}.tmp`), options)
        removeEventFile(keyFile(paths, event.key), options)
      }
    } catch (error) { if (error.code !== 'ENOENT') eventReason(options, 'launcher-retention-failed', error) }
  }
}

export function ignoredLegacy(paths, id, options) {
  for (const name of readdirSync(paths.root)) {
    if (name.startsWith(`${id}.`) && /(?:\.jsonl|\.lock|\.claim|\.sync)(?:\.|$)/.test(name)) {
      eventReason(options, `launcher-legacy-ignored ${name}`)
    }
  }
}
