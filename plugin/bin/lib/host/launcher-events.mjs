import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { laneHostStateRoot } from './lane-host-dir.mjs'
import { completeLauncherWrite, writeLauncherLine } from './launcher-event-io.mjs'
import { eventGraceElapsed } from './launcher-event-grace.mjs'
import { eventNames, eventPaths, eventReason, finishPublication, ignoredLegacy, pruneDone, publishEvent, readEvent, recoverPublications } from './launcher-maildir.mjs'
import { acknowledgeClaim, claimEvent, recoverClaims, recoverLegacyClaims } from './launcher-claims.mjs'
import { closeLauncherJournal, compactLauncherJournal, openLauncherJournal } from './launcher-journal.mjs'
import { acquireJournalWriter, releaseJournalWriter } from './launcher-reader.mjs'

export const printLauncherEvent = writeLauncherLine

export function launcherId(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('--launcher-agent / WT_LAUNCHER_AGENT must contain only letters, digits, underscore or hyphen')
  }
  return value
}

function storedEvents(paths, options) {
  const entries = []
  // Successful publications retain this private hard link throughout pending/claim/done.
  // Read that stable name so a reader's concurrent rename cannot hide a prior event.
  for (const name of readdirSync(paths.tmp)) {
    if (!/^\d+-\d+-[A-Za-z0-9-]+\.tmp$/.test(name)) continue
    const file = path.join(paths.tmp, name)
    try {
      const links = lstatSync(file).nlink
      if (!Number.isSafeInteger(links) || links < 1) throw new Error('launcher-link-count-unknown')
      if (links > 1) entries.push({ ...readEvent(file), name: `${name.slice(0, -4)}.json` })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      eventReason(options, 'launcher-event-read-failed', error)
      throw Object.assign(new Error('launcher-deduplication-incomplete'), { code: 'launcher-deduplication-incomplete' })
    }
  }
  return entries
}

export function appendLauncherEvent(id, event, options = {}) {
  try {
    launcherId(id)
    const paths = eventPaths(id, options)
    ignoredLegacy(paths, id, options); pruneDone(paths, options)
    const previous = storedEvents(paths, options).find((item) => item.key === event.key)
    if (previous) return finishPublication(paths, previous, options)
    return publishEvent(paths, { ...event, launcherAgentId: id, at: options.now ?? Date.now() }, options)
  } catch (error) { return eventReason(options, 'launcher-publish-failed', error) }
}

function closeDelivery(ready, options) {
  try { closeLauncherJournal(ready.journal) }
  finally { releaseJournalWriter(ready.writer, options) }
}

function openDelivery(paths, options) {
  const writer = acquireJournalWriter(paths, options)
  if (!writer) return null
  let journal
  try {
    journal = openLauncherJournal(paths, options)
    if (journal) {
      recoverLegacyClaims(paths, options)
      if (recoverClaims(paths, journal, options)) {
        compactLauncherJournal(journal, options)
        return { paths, journal, writer }
      }
    }
  } catch (error) { eventReason(options, 'launcher-read-failed', error) }
  closeDelivery({ journal, writer }, options)
  return null
}

function prepareClaim(id, options) {
  let ready
  try {
    launcherId(id)
    const paths = eventPaths(id, options)
    recoverPublications(paths, options); pruneDone(paths, options)
    ready = openDelivery(paths, options)
    if (!ready) return null
    for (const name of eventNames(paths.pending)) {
      if (options.name && name !== options.name) continue
      const claim = claimEvent(paths, name, ready.journal, options)
      if (claim) return { ...ready, claim }
    }
  } catch (error) { eventReason(options, 'launcher-read-failed', error) }
  if (ready) closeDelivery(ready, options)
  return null
}

export function takeLauncherEvent(id, options = {}) {
  const ready = prepareClaim(id, options)
  if (!ready) return null
  const { paths, claim, journal } = ready
  try {
    const deliver = options.deliver ?? ((event) => printLauncherEvent(event.line))
    completeLauncherWrite(deliver, claim.event)
    acknowledgeClaim(paths, claim, journal, options)
    return claim.event
  } finally { closeDelivery(ready, options) }
}

function pendingForLauncher(id, options) {
  const paths = eventPaths(id, options); recoverPublications(paths, options)
  const ready = openDelivery(paths, options)
  if (!ready) return []
  try {
    return eventNames(paths.pending).map((name) => ({ ...readEvent(path.join(paths.pending, name)), name }))
      .filter((event) => event.ownerSessionId === options.sessionId)
  } finally { closeDelivery(ready, options) }
}

export function pendingLauncherEvents(options = {}) {
  const root = path.join(path.dirname(options.stateRoot ?? laneHostStateRoot()), 'wt-launcher-events')
  const events = []
  let ids
  try { ids = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name)).map((entry) => entry.name) }
  catch (error) { if (error.code !== 'ENOENT') { eventReason(options, 'launcher-read-failed', error) } return events }
  for (const id of ids) {
    try {
      events.push(...pendingForLauncher(id, options))
    } catch (error) { if (error.code !== 'ENOENT') eventReason(options, 'launcher-read-failed', error) }
  }
  return events
}

export function launcherLiveness(id, options = {}) {
  launcherId(id)
  const root = options.livenessDir ?? (process.env.WT_LIVENESS_DIR || path.join(os.homedir(), '.local', 'state', 'wt-liveness'))
  try {
    const value = JSON.parse(readFileSync(path.join(root, `${id}.json`), 'utf8'))
    if (value.agentId !== id || typeof value.complete !== 'boolean') throw new Error('invalid launcher liveness')
    return value.complete ? 'complete' : 'present'
  } catch (error) { if (error.code === 'ENOENT') { return 'missing' } throw error }
}

export function launcherRecoveryReason(id, event, options, grace, unconsumedGrace) {
  const paths = eventPaths(id, options), live = launcherLiveness(id, options)
  const missing = eventGraceElapsed(path.join(paths.box, 'missing-since'), live === 'missing', grace, options)
  const key = createHash('sha256').update(event.key).digest('hex')
  const pending = eventGraceElapsed(path.join(paths.box, `${key}.pending-since`), true, unconsumedGrace, options)
  if (live === 'complete') return 'complete'
  if (live === 'missing' && missing > grace) return 'missing'
  return live === 'present' && pending > unconsumedGrace ? 'not-consuming' : null
}
