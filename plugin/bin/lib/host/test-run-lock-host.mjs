// Host reads for the concurrent-test guard's lock-coverage decision.
//
// Cross-platform verdict, per dependency:
// - readText: portable; a missing or unreadable file is null (the caller treats it as absent).
// - lockParticipants: portable; reads the suite lock's holder.json and queue tickets from the lock
//   directory the lock itself derives (readSuiteLock). A record from ANOTHER pid namespace (a lane
//   sandbox) is skipped, because its pid names a different process here: its runners then count as
//   outside the lock and the guard warns. On macOS and Windows the namespace reads null on both
//   sides and every record is kept. An unreadable lock returns null, never an empty set.
// - lock in use: the lock root exists (created at first use and kept), read through the same path.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { readSuiteLock } from '../suite-lock.mjs'
import { currentPidNamespace } from './pid-namespace.mjs'
import { queuedTickets, readTicket } from './suite-lock-queue.mjs'

export function readText(file) {
  try { return readFileSync(file, 'utf8') } catch { return null }
}

export function homeDirectory() {
  try { return homedir() } catch { return null }
}

function sameNamespace(record, namespace) {
  return !record?.pidNamespace || !namespace || record.pidNamespace === namespace
}

/**
 * @returns {{ state: 'held'|'free'|'unknown', inUse: boolean, participants: Set<number>|null }}
 */
export function lockParticipants(env = process.env) {
  let lock
  try { lock = readSuiteLock({ env }) } catch { return { state: 'unknown', inUse: false, participants: null } }
  let inUse = false
  try { inUse = statSync(lock.root).isDirectory() } catch { /* never used on this machine */ }
  const namespace = currentPidNamespace()
  const participants = new Set()
  const add = (record) => {
    if (Number.isSafeInteger(record?.pid) && record.pid > 0 && sameNamespace(record, namespace)) participants.add(record.pid)
  }
  if (lock.held) add(lock.holder)
  try {
    const queueDir = path.join(lock.root, 'queue.d')
    for (const number of queuedTickets(queueDir)) add(readTicket(queueDir, number)?.holder)
  } catch (error) {
    if (error?.code !== 'ENOENT') return { state: 'unknown', inUse, participants: null }
  }
  return { state: lock.held ? 'held' : 'free', inUse, participants }
}
