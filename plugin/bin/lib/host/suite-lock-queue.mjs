import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// The file layer of the suite lock's FIFO queue (policy: ../suite-lock.mjs). Two files per ticket,
// both created with an exclusive `wx` open, which is atomic on every platform and needs no flock:
//   <n>.ticket  an allocation marker that outlives the wait, so a waiter that read the directory late
//               climbs past numbers already handed out instead of reusing a freed low one;
//   <n>.json    the waiter's holder-shaped record, whose mtime is its heartbeat.
const TICKET_DIGITS = 16
const TICKET_MARKERS_KEPT = 256
const TICKET_FILE = /^(\d{16})\.(ticket|json)$/

const ticketBase = (queueDir, number) => path.join(queueDir, String(number).padStart(TICKET_DIGITS, '0'))
const recordFile = (queueDir, number) => `${ticketBase(queueDir, number)}.json`

function listTickets(queueDir) {
  const markers = []
  const records = []
  for (const name of readdirSync(queueDir)) {
    const match = TICKET_FILE.exec(name)
    if (match) (match[2] === 'ticket' ? markers : records).push(Number(match[1]))
  }
  return { markers, records: records.sort((a, b) => a - b) }
}

function createExclusive(file, content) {
  try {
    writeFileSync(file, content, { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

/** Live ticket numbers, lowest (oldest) first. */
export function queuedTickets(queueDir) {
  return listTickets(queueDir).records
}

/**
 * Allocates the next number past every marker still on disk and publishes the record under it. The
 * number is mine only if BOTH exclusive creates succeed: a record already there (published by a waiter
 * whose marker was pruned, or seen through a stale listing) means it is someone else's, so allocate
 * again. Markers are pruned only below the lowest live record, never under a waiter still queued.
 * `seams.list` replaces the directory listing (tests reproduce a stale listing through it).
 */
export function takeTicket(queueDir, record, seams = {}) {
  const list = seams.list ?? listTickets
  mkdirSync(queueDir, { recursive: true, mode: 0o700 })
  while (true) {
    const { markers, records } = list(queueDir)
    let number = Math.max(0, ...markers, ...records) + 1
    while (!createExclusive(`${ticketBase(queueDir, number)}.ticket`, '')) number += 1
    const pruneBelow = Math.min(number - TICKET_MARKERS_KEPT + 1, ...records)
    for (const old of markers) {
      if (old < pruneBelow) rmSync(`${ticketBase(queueDir, old)}.ticket`, { force: true })
    }
    if (createExclusive(recordFile(queueDir, number), `${JSON.stringify(record)}\n`)) return number
  }
}

/** Refreshes the record's mtime; a record someone removed is put back under the same number. */
export function heartbeatTicket(queueDir, number, record) {
  const file = recordFile(queueDir, number)
  const now = new Date()
  try { utimesSync(file, now, now) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    createExclusive(file, `${JSON.stringify(record)}\n`)
  }
}

/** The ticket in the holder's shape ({ held, holder, ageMs }, age = time since its heartbeat), or null once gone. */
export function readTicket(queueDir, number) {
  const file = recordFile(queueDir, number)
  let holder = null
  try { holder = JSON.parse(readFileSync(file, 'utf8')) } catch { /* being written, or gone */ }
  try { return { held: true, holder, ageMs: Date.now() - statSync(file).mtimeMs } } catch { return null }
}

// Windows refuses to unlink an entry another process holds open for a moment (EPERM/EBUSY);
// `maxRetries` retries exactly those codes, and applies only with `recursive: true` (Node fs docs).
const REMOVE_RETRY = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }

export function removeTicket(queueDir, number) {
  rmSync(recordFile(queueDir, number), REMOVE_RETRY)
}

/** Removes a directory whose mtime is at least `ageMs` old; a missing one is not an error. */
export function removeDirectoryOlderThan(directory, ageMs) {
  try {
    if (Date.now() - statSync(directory).mtimeMs >= ageMs) rmSync(directory, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

// Reclaiming the lock directory without deleting a NEWER instance: the reclaimer renames lock.d aside
// (atomic; nobody can acquire into a renamed directory), reads the holder that actually moved, and
// deletes it only if it is the instance it judged stale. Otherwise the directory is put back.

/** Renames `lockDir` to a unique sibling; returns that path, or null when lock.d is already gone. */
export function setLockAside(lockDir) {
  const aside = `${lockDir}.reclaimed-${process.pid}-${randomUUID()}`
  try {
    renameSync(lockDir, aside)
    return aside
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** The holder recorded in a lock directory, or null when missing or unreadable. */
export function readHolderIn(lockDir) {
  try { return JSON.parse(readFileSync(path.join(lockDir, 'holder.json'), 'utf8')) } catch { return null }
}

const PUT_BACK_MAX_MS = 5000
const PUT_BACK_STEP_MS = 5

/**
 * Puts a lock directory moved aside back as `lockDir`. True when put back. False when lock.d is held by a
 * PUBLISHED holder (holder.json present): that newer holder wins and the aside copy is discarded. An obstacle
 * that is only an empty lock.d (an acquirer about to withdraw) is removed and the rename retried, bounded by
 * `maxMs`; past the bound the aside copy is left in place (and named on stderr) rather than deleting a live holder.
 * `rename` is a test seam for platforms where renaming onto an existing empty directory fails.
 */
export function putLockBack(aside, lockDir, options = {}) {
  const rename = options.rename ?? renameSync
  const blocking = ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES']
  const deadline = Date.now() + (options.maxMs ?? PUT_BACK_MAX_MS)
  const pause = new Int32Array(new SharedArrayBuffer(4))
  while (true) {
    try {
      rename(aside, lockDir)
      return true
    } catch (error) {
      if (!blocking.includes(error?.code)) throw error
      if (readHolderIn(lockDir) !== null) {
        rmSync(aside, { recursive: true, force: true })
        return false
      }
      try { rmdirSync(lockDir) } catch { /* not empty yet (an acquirer mid-publication) or already gone */ }
      if (Date.now() >= deadline) {
        process.stderr.write(`wt-suite-lock: could not put the saved lock directory back; left in place at ${aside}\n`)
        return false
      }
      Atomics.wait(pause, 0, 0, PUT_BACK_STEP_MS)
    }
  }
}

export function discardDirectory(directory) {
  rmSync(directory, REMOVE_RETRY)
}

const LIGHT_GRANTS_FILE = 'light-grants'
const lightGrantsFile = (root) => path.join(root, LIGHT_GRANTS_FILE)

/**
 * The light-grants counter: `{ generation, grants }`. `generation` is null when there is no valid counter
 * (missing, corrupt, or the plain-integer file of an earlier version): nothing recorded against a valid
 * generation can then match, so an exclusive ticket queued before a loss is never passed again.
 */
export function readLightCounter(root) {
  try {
    const parsed = JSON.parse(readFileSync(lightGrantsFile(root), 'utf8'))
    if (typeof parsed?.generation === 'string' && parsed.generation !== '' && Number.isSafeInteger(parsed.grants) && parsed.grants >= 0) {
      return { generation: parsed.generation, grants: parsed.grants }
    }
  } catch { /* missing or unreadable: no valid counter */ }
  return { generation: null, grants: 0 }
}

function writeLightCounter(root, state) {
  const temporary = path.join(root, `${LIGHT_GRANTS_FILE}.${process.pid}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  renameSync(temporary, lightGrantsFile(root))
}

/** The counter an exclusive waiter records against; creates it (new generation) when there is none. */
export function ensureLightCounter(root) {
  const current = readLightCounter(root)
  if (current.generation !== null) return current
  const fresh = { generation: randomUUID(), grants: 0 }
  try {
    writeFileSync(lightGrantsFile(root), `${JSON.stringify(fresh)}\n`, { flag: 'wx', mode: 0o600 })
    return fresh
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const raced = readLightCounter(root)
  if (raced.generation !== null) return raced
  writeLightCounter(root, fresh) // present but unreadable: replaced under a new generation
  return fresh
}

/** Counts one light grant. Called by the light holder once it is admitted: the sole holder, so no writer race. */
export function recordLightGrant(root) {
  const current = readLightCounter(root)
  writeLightCounter(root, current.generation === null ? { generation: randomUUID(), grants: 1 } : { generation: current.generation, grants: current.grants + 1 })
}

/** True while a reclaimer holds reclaim.d: no acquisition may complete then. */
export function reclaimInFlight(root) {
  try { return statSync(path.join(root, 'reclaim.d')).isDirectory() } catch { return false }
}

/** Removes a lock.d this process just created and has not published into; never removes a directory with content. */
export function abandonEmptyLockDir(lockDir) {
  try { rmdirSync(lockDir) } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') throw error
  }
}
