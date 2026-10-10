// Durable journal host operations. Directory fsync is unsupported on Windows; files still fsync.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export const read = (file) => fs.readFileSync(file, 'utf8')
export const readBytes = (file) => fs.readFileSync(file)
export const mkdir = (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
export const exists = (file) => fs.existsSync(file)
export const remove = (file) => fs.unlinkSync(file)
export const rename = (from, to) => fs.renameSync(from, to)
export const stat = (file) => fs.statSync(file)
export const home = () => os.homedir()
export const platform = () => process.platform
export const hostname = () => os.hostname()
export const nonce = () => randomBytes(8).toString('hex')
export const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function list(dir) {
  try { return fs.readdirSync(dir).sort() } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export function optionalRead(file) {
  try { return read(file) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export function json(file) {
  const value = optionalRead(file)
  return value === null ? null : JSON.parse(value)
}

export function syncDir(dir) {
  if (process.platform === 'win32') return
  const fd = fs.openSync(dir, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function writeSynced(file, data, flags) {
  const fd = fs.openSync(file, flags, 0o600)
  try {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
}

export function atomicWrite(file, data) {
  mkdir(path.dirname(file))
  const tmp = `${file}.tmp-${nonce()}`
  try {
    writeSynced(tmp, data, 'wx')
    rename(tmp, file)
    syncDir(path.dirname(file))
  } finally {
    if (exists(tmp)) remove(tmp)
  }
}

export const atomicJson = (file, value) => atomicWrite(file, `${JSON.stringify(value)}\n`)

export function append(file, data) {
  mkdir(path.dirname(file))
  writeSynced(file, data, 'a')
  syncDir(path.dirname(file))
}

export function exclusiveWrite(file, data) {
  writeSynced(file, data, 'wx')
  syncDir(path.dirname(file))
}

export function truncate(file, size) {
  const fd = fs.openSync(file, 'r+')
  try { fs.ftruncateSync(fd, size); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

// Resolve the deepest existing ancestor, so nonexistent children of symlinks are checked too.
export function canonical(file) {
  const suffix = []
  let cursor = path.resolve(file)
  for (;;) {
    try { return path.join(fs.realpathSync.native(cursor), ...suffix.reverse()) } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      const parent = path.dirname(cursor)
      if (parent === cursor) throw error
      suffix.push(path.basename(cursor))
      cursor = parent
    }
  }
}

export function insideRepository(file) {
  for (let dir = canonical(file); ; dir = path.dirname(dir)) {
    try { fs.lstatSync(path.join(dir, '.git')); return true } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
    if (path.dirname(dir) === dir) return false
  }
}

export function takeLock(dir, owner) {
  try { fs.mkdirSync(dir, { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  atomicJson(path.join(dir, 'owner.json'), owner)
  return true
}

export function releaseLock(dir, owner) {
  if (json(path.join(dir, 'owner.json'))?.nonce !== owner.nonce) throw new Error('journal lock ownership changed')
  remove(path.join(dir, 'owner.json'))
  fs.rmdirSync(dir)
  syncDir(path.dirname(dir))
}

function ownerAlive(owner) {
  if (!owner || owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return 'unknown'
  try { process.kill(owner.pid, 0); return 'live' } catch (error) {
    return error.code === 'ESRCH' ? 'dead' : 'unknown'
  }
}

function reclaimable(dir, owner) {
  return owner ? ownerAlive(owner) === 'dead' : Date.now() - stat(dir).mtimeMs > 60000
}
function takeUnlockMutex(dir) {
  const mutex = `${dir}.unlocking`
  const owner = { pid: process.pid, host: hostname(), nonce: nonce() }
  if (!takeLock(mutex, owner)) {
    if (!reclaimable(mutex, json(path.join(mutex, 'owner.json')))) throw new Error('unlock refused: another unlock is in progress')
    // Reclaim an abandoned mutex through its own mutex. The recursive path re-observes
    // ownership after serialization, so a replacement holder is never moved.
    unlockDead(mutex)
    if (!takeLock(mutex, owner)) throw new Error('unlock refused: another unlock is in progress')
  }
  return { mutex, owner }
}
function removeDeadLock(dir) {
  const observed = json(path.join(dir, 'owner.json'))
  if (!reclaimable(dir, observed)) throw new Error('unlock refused: owner is live, fresh or cannot be proven dead on this host')
  const moved = `${dir}.dead-${nonce()}`
  rename(dir, moved)
  const current = json(path.join(moved, 'owner.json'))
  if (current?.nonce !== observed?.nonce || !reclaimable(moved, current)) {
    if (!exists(dir)) rename(moved, dir)
    throw new Error(`unlock refused: owner changed; inspect ${moved}`)
  }
  fs.rmSync(moved, { recursive: true })
  syncDir(path.dirname(dir))
}
export function unlockDead(dir) {
  const { mutex, owner } = takeUnlockMutex(dir)
  try { removeDeadLock(dir) } finally { releaseLock(mutex, owner) }
}

