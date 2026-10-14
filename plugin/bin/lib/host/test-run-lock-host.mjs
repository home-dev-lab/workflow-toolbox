// Host reads for the concurrent-test guard's lock-coverage decision.
//
// Cross-platform verdict, per dependency:
// - readText: portable; a missing or unreadable file is null (the caller treats it as absent).
// - lockParticipants: portable; reads the suite lock's holder.json and queue tickets from the lock
//   directory the lock itself derives (readSuiteLock). Foreign pid-namespace and stale records
//   are skipped. On macOS and Windows namespace reads null. An unreadable queue returns null
//   participants, never an empty set; an unreadable holder adds no pid (positive evidence only) and
//   the lock still reads held.
// - lock in use: the lock root exists (created at first use and kept), read through the same path.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { holderIsStale, readSuiteLock } from '../suite-lock.mjs'
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

function addQueuedParticipants(lock, add) {
  try {
    const queueDir = path.join(lock.root, 'queue.d')
    for (const number of queuedTickets(queueDir)) add(readTicket(queueDir, number))
  } catch (error) {
    if (error?.code !== 'ENOENT') return false
  }
  return true
}

/**
 * @returns {{ state: 'held'|'free'|'unknown', inUse: boolean, participants: Set<number>|null }}
 */
export function lockParticipants(env = process.env, probes = {}) {
  let lock
  try { lock = readSuiteLock({ env }) } catch { return { state: 'unknown', inUse: false, participants: null } }
  let inUse = false
  try { inUse = statSync(lock.root).isDirectory() } catch { /* never used on this machine */ }
  const namespace = probes.namespace === undefined ? currentPidNamespace() : probes.namespace
  const participants = new Set()
  const add = (record) => {
    // The guard reads the broker's host-side records; judge host PIDs even when invoked in a lane.
    if (record && !holderIsStale(record, { insideSandbox: false, ...probes.stale }) && Number.isSafeInteger(record.holder?.pid) && record.holder.pid > 0 && sameNamespace(record.holder, namespace)) participants.add(record.holder.pid)
  }
  if (lock.held) add(lock)
  if (!addQueuedParticipants(lock, add)) return { state: 'unknown', inUse, participants: null }
  return { state: lock.held ? 'held' : 'free', inUse, participants }
}
