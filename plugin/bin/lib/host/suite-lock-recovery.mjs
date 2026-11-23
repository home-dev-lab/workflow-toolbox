import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { foreignNamespaceStale, pidProvesGone } from './suite-lock-liveness.mjs'
import { readHolderIn, removeTicket } from './suite-lock-queue.mjs'
import { suiteJournalEvent } from '../suite-lock-journal.mjs'
import { claimSuiteSection } from './suite-lock-section.mjs'
import { abandonedElapsed } from './suite-lock-rank-state.mjs'
export { reapSuiteTerminals } from './suite-lock-terminal-repair.mjs'

const RESIDUAL_AGE_MS = 600_000

function recoveryOwnerGone(name, prefix) {
  const match = /^(\d+)-.+$/.exec(name.slice(prefix.length))
  if (!match) return true
  const pid = Number(match[1])
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  // A reused PID only delays cleanup. EPERM and other failures are unknown,
  // never evidence that the claimant died (including on Windows).
  try { process.kill(pid, 0); return false } catch (error) { return error?.code === 'ESRCH' }
}

export function cleanSuiteRecoveryFiles(directory, prefix) {
  let names
  try { names = readdirSync(directory) } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const name of names.filter((entry) => entry.startsWith(prefix))) {
    const file = path.join(directory, name)
    try {
      if (Date.now() - statSync(file).mtimeMs > RESIDUAL_AGE_MS && recoveryOwnerGone(name, prefix)) rmSync(file, { recursive: true, force: true })
    } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}

const provenDead = (holder, options) => holder && foreignNamespaceStale({ holder }, options) === null && pidProvesGone(holder, options)

function restoreClaim(file, content) {
  try { writeFileSync(file, content, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
}

function renameClaim(file, claim) {
  try { renameSync(file, claim); return true } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export function reapSuiteTicket(queueDir, ticket, options = {}) {
  if (!provenDead(ticket.holder, options)) { removeTicket(queueDir, ticket.number); return }
  const file = path.join(queueDir, `${String(ticket.number).padStart(16, '0')}.json`)
  const claim = path.join(queueDir, `.reaped-${process.pid}-${randomUUID()}`)
  options.beforeTicketClaim?.(ticket)
  // Claim inside the section too: a busy reaper leaves its ticket untouched,
  // and cannot resurrect a claim that a holder's sweep has already consumed.
  claimSuiteSection(path.dirname(queueDir), () => {
    if (!renameClaim(file, claim)) return
    try {
      const content = readFileSync(claim, 'utf8')
      const record = JSON.parse(content)
      if (record.leaseId !== ticket.holder.leaseId || !provenDead(record, options)) { restoreClaim(file, content); return }
      if (readHolderIn(path.join(path.dirname(queueDir), 'lock.d'))?.leaseId === record.leaseId) return
      suiteJournalEvent(recoveryJournal(record), 'abort', { cause: 'client-gone', reapedBy: process.pid })
    } finally { rmSync(claim, { force: true }) }
  })
}

function reclaimedHeldSeconds(holder, options, elapsedMs) {
  try {
    const elapsed = elapsedMs === undefined ? abandonedElapsed(holder, options, NaN) : elapsedMs
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed / 1000 : null
  } catch { return null }
}

export function journalReclaimedHolder(holder, options, elapsedMs) {
  if (!recoveryJournal(holder)) return
  const fields = { cause: 'force-release', exit: null, served: false, reclaimedBy: process.pid, heldS: reclaimedHeldSeconds(holder, options, elapsedMs), result: 'unknown' }
  if (!options.force) Object.assign(fields, { cause: 'reclaimed', proof: pidProvesGone(holder, options) || foreignNamespaceStale({ holder }, options) === true ? 'pid-gone' : 'age' })
  suiteJournalEvent(recoveryJournal(holder), 'release', fields)
}

const recoveryJournal = (record) => record?.leaseId && record.journal?.leaseId === record.leaseId ? { base: record.journal } : undefined

// Called only inside reclaim.d, before a holder's sole terminal is written.
// A reaper that lost its claimed file to this sweep must not restore or append.
export function removeLeaseTickets(root, leaseId) {
  if (!leaseId) return
  const directory = path.join(root, 'queue.d')
  let names
  try { names = readdirSync(directory) } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const name of names.filter((entry) => /^\d+\.json$/.test(entry) || entry.startsWith('.reaped-'))) {
    const file = path.join(directory, name)
    let record
    try { record = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
    if (record?.leaseId === leaseId) rmSync(file, { recursive: true, force: true })
  }
}
