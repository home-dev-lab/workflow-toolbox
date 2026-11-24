import { lstatSync, readdirSync, utimesSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { eventNames, eventOperation, eventReason, readEvent } from './launcher-maildir.mjs'
import { appendJournalRecord, syncJournalDirectory } from './launcher-journal.mjs'
import { readerDead } from './launcher-reader.mjs'

export { readerDead } from './launcher-reader.mjs'

export function recoverLegacyClaims(paths, options) {
  for (const name of readdirSync(paths.box)) {
    if (!name.startsWith('claimed-')) continue
    const directory = path.join(paths.box, name)
    try {
      if (lstatSync(directory).isSymbolicLink() || !readerDead(directory, options)) continue
      for (const event of eventNames(directory)) {
        // Old partial/unknown markers are never journal evidence. Replay is safer
        // than acknowledging an unprinted event during an upgrade.
        eventOperation('rename', path.join(directory, event), path.join(paths.pending, event), options)
      }
    } catch (error) { eventReason(options, 'launcher-legacy-recovery-failed', error) }
  }
}

function record(journal, transaction, type, options) {
  appendJournalRecord(journal, { v: 1, type, name: transaction.name, token: transaction.token, at: options.now ?? Date.now() }, options)
}

function confirmMissingSource(source, error) {
  if (error.code !== 'ENOENT') throw error
  try { lstatSync(source) }
  catch (lookup) { if (lookup.code === 'ENOENT') return; throw lookup }
  // A missing destination directory or a transient rename lookup says nothing
  // about the source. Retain the journal evidence instead of reclaiming it.
  throw error
}

function projectDone(paths, transaction, options) {
  const source = path.join(paths.pending, transaction.name), target = path.join(paths.done, transaction.name)
  try {
    const now = new Date(options.now ?? Date.now())
    utimesSync(source, now, now)
    eventOperation('rename', source, target, options)
  } catch (error) { confirmMissingSource(source, error) }
  syncJournalDirectory(paths.done, options); syncJournalDirectory(paths.pending, options)
  transaction.projected = true
}

export function recoverClaims(paths, journal, options) {
  for (const transaction of journal.transactions) {
    if (!transaction.printed) continue
    try {
      if (!transaction.done) record(journal, transaction, 'done', options)
      projectDone(paths, transaction, options)
    } catch (error) { eventReason(options, 'launcher-recovery-failed', error); return false }
  }
  return true
}

export function claimEvent(paths, name, journal, options) {
  const event = readEvent(path.join(paths.pending, name))
  let transaction = journal.transactions.at(-1)
  if (transaction?.done) transaction = null
  if (transaction && transaction.name !== name) return null
  if (!transaction) {
    record(journal, { name, token: randomUUID() }, 'claim', options)
    transaction = journal.transactions.at(-1)
  }
  return { name, event, transaction }
}

export function acknowledgeClaim(paths, claim, journal, options) {
  record(journal, claim.transaction, 'printed', options)
  try {
    record(journal, claim.transaction, 'done', options)
    projectDone(paths, claim.transaction, options)
  } catch (error) { eventReason(options, 'launcher-acknowledge-failed', error) }
}
