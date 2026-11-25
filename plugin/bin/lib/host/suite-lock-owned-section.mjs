import { mkdirSync, rmSync, readFileSync, writeFileSync, renameSync, statSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { currentPidNamespace, processStartTime } from './pid-namespace.mjs'
import { ticketIsStale } from './suite-lock-liveness.mjs'
import { claimSuiteSection, RECLAIM_BUSY } from './suite-lock-section.mjs'

export const OWNED_SECTION_STALE_MS = 10_000
// Recursive removal retries Windows delete-pending errors for a short interval.
const REMOVE_WITH_RETRY = { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }

export function claimOwnedSuiteSection(root, name, critical) {
  if (name === 'reclaim.d') throw new Error('owned protocol cannot claim reclaim.d')
  return withSectionIntent(root, name, () => enterOwnedSection(root, name, critical))
}

function enterOwnedSection(root, name, critical) {
  const directory = path.join(root, name)
  if (!makeSection(directory)) return RECLAIM_BUSY
  try {
    writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid,
      startTime: processStartTime(process.pid), pidNamespace: currentPidNamespace() }), { mode: 0o600 })
    return critical()
  } finally { rmSync(directory, REMOVE_WITH_RETRY) }
}

// A unique immutable publication cannot be mistaken for a replacement owner.
// Keep it through the critical section so an old directory snapshot never
// authorizes renaming a newly created live section (the rename ABA race).
function withSectionIntent(root, name, critical) {
  const prefix = `.${name}.intent-`
  const file = path.join(root, `${prefix}${randomUUID()}.owner.json`)
  const temporary = `${file}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid),
      pidNamespace: currentPidNamespace() }), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
    if (competingSectionIntent(root, prefix, file)) return RECLAIM_BUSY
    return critical()
  } finally {
    rmSync(file, { force: true })
    rmSync(temporary, { force: true })
  }
}

function competingSectionIntent(root, prefix, own) {
  for (const name of readdirSync(root).filter((entry) => entry.startsWith(prefix) && entry.endsWith('.owner.json'))) {
    const file = path.join(root, name)
    if (file === own) continue
    const owner = intentOwner(file)
    if (!owner) continue // Concurrent owner completed and unlinked its immutable record.
    if (!ticketIsStale({ holder: owner, ageMs: 0 })) return true
    rmSync(file, { force: true })
  }
  return false
}

function intentOwner(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function makeSection(directory) {
  try { mkdirSync(directory, { mode: 0o700 }); return true } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  if (!reclaimSection(directory)) return false
  try { mkdirSync(directory, { mode: 0o700 }); return true } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return false
  }
}

function sectionOwner(directory) {
  try {
    const owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'))
    return Number.isSafeInteger(owner?.pid) && owner.pid > 0 ? owner : null
  } catch { return null }
}

function reclaimSection(directory) {
  try {
    const before = statSync(directory)
    const owner = sectionOwner(directory)
    if (owner ? !ticketIsStale({ holder: owner, ageMs: 0 }) : Date.now() - before.mtimeMs <= OWNED_SECTION_STALE_MS) return false
    const confirmed = statSync(directory)
    if (before.ino !== confirmed.ino || before.dev !== confirmed.dev) return false
    const tombstone = `${directory}.${randomUUID()}.dead`
    renameSync(directory, tombstone)
    rmSync(tombstone, REMOVE_WITH_RETRY)
    return true
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) return false
    throw error
  }
}

// Synchronous callers retry briefly. At the bound nothing is removed: the
// caller gets false and can retry; a dead client's holder remains recoverable.
export function retryReservationSection(root, critical, { timeoutMs = 3000, maxPauseMs = 20, retryErrors = false } = {}) {
  const deadline = performance.now() + timeoutMs
  const pause = new Int32Array(new SharedArrayBuffer(4))
  let delay = 20
  while (true) {
    let result
    try { result = claimSuiteSection(root, critical) } catch (error) {
      if (!retryErrors) throw error
      result = RECLAIM_BUSY
    }
    if (result !== RECLAIM_BUSY) return result
    if (performance.now() >= deadline) {
      process.stderr.write(`wt-suite-lock: release section busy after ${timeoutMs / 1000} s; holder retained for dead-launcher reconciliation\n`)
      return false
    }
    Atomics.wait(pause, 0, 0, Math.min(delay, Math.max(0, deadline - performance.now())))
    delay = Math.min(maxPauseMs, delay * 1.5)
  }
}
