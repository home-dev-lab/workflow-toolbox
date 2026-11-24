import { closeSync, constants, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
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
  return { root, box, pending, done, tmp }
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
  try { unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') eventReason(options, 'launcher-cleanup-failed', error) }
}

export function publishEvent(paths, entry, options) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const base = attempt === 0 ? (options.name?.() ?? eventName()) : eventName()
    const stage = path.join(paths.tmp, `${base}.tmp`), name = `${base}.json`
    let fd
    try { fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600) }
    catch (error) { if (error.code === 'EEXIST') { continue } throw error }
    try {
      writeFileSync(fd, JSON.stringify(entry)); closeSync(fd); fd = undefined
      eventOperation('link', stage, path.join(paths.pending, name), options)
      // Retain the temporary hard link as an exclusive name reservation until retention.
      return { ...entry, name }
    } catch (error) { removeEventFile(stage, options); throw error }
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
        removeEventFile(file, options)
        removeEventFile(path.join(paths.tmp, `${name.slice(0, -5)}.tmp`), options)
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
