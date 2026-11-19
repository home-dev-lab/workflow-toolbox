import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { foreignNamespaceStale, pidProvesGone } from './suite-lock-liveness.mjs'
import { readHolderIn, removeTicket } from './suite-lock-queue.mjs'
import { suiteJournalEvent } from '../suite-lock-journal.mjs'

const RESIDUAL_AGE_MS = 600_000

export function cleanSuiteRecoveryFiles(directory, prefix) {
  let names
  try { names = readdirSync(directory) } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const name of names.filter((entry) => entry.startsWith(prefix))) {
    const file = path.join(directory, name)
    try {
      if (Date.now() - statSync(file).mtimeMs > RESIDUAL_AGE_MS) rmSync(file, { recursive: true, force: true })
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
  if (!renameClaim(file, claim)) return
  try {
    const content = readFileSync(claim, 'utf8')
    const record = JSON.parse(content)
    if (record.leaseId !== ticket.holder.leaseId || !provenDead(record, options)) { restoreClaim(file, content); return }
    if (readHolderIn(path.join(path.dirname(queueDir), 'lock.d'))?.leaseId === record.leaseId) return
    suiteJournalEvent(record.journal && { base: record.journal }, 'abort', { cause: 'client-gone', reapedBy: process.pid })
  } finally { rmSync(claim, { force: true }) }
}

export function journalReclaimedHolder(holder, options) {
  if (!holder?.journal) return
  const fields = { cause: 'force-release', exit: null, served: false, reclaimedBy: process.pid }
  if (!options.force) Object.assign(fields, { cause: 'reclaimed', proof: pidProvesGone(holder, options) || foreignNamespaceStale({ holder }, options) === true ? 'pid-gone' : 'age' })
  suiteJournalEvent(holder?.journal && { base: holder.journal }, 'release', fields)
}
