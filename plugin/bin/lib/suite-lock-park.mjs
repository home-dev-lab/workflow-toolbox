import path from 'node:path'
import { displayText } from './suite-lock-display.mjs'
import { numericLevel, orderSuiteLockTickets } from './suite-lock-order.mjs'
import { readLightCounter, readP0Counter, readQueueSnapshot } from './host/suite-lock-queue.mjs'
import { readSuiteLockRankState } from './host/suite-lock-rank-state.mjs'
import { ticketIsStale } from './host/suite-lock-liveness.mjs'
import { readHostPlatform } from './host/platform.mjs'
import { takeJournalTicket } from './suite-lock-journal-lifecycle.mjs'
import { claimParkedTicket, consumeParkAsides, createParkedFile, listParkedFiles, newParkNonce, parkClaimPresent, parkEnvironment, parkFile, readParkJson, readParkRequest, recoverParkAsides, removeParkClaim, removeParkedInstance, removeParkPrivate, validateParkDirectory, watchParkWait, writeParkPrivate } from './host/suite-lock-park-files.mjs'

const PARKED_RECORD = 'parked.json'
const YIELD_FLAG = '--yield-to-parked'
const takeFlag = (flags, name) => {
  const index = flags.indexOf(name)
  if (index < 0) return undefined
  return flags.splice(index, 2)[1]
}

export function parseParkOptions(flags, env) {
  const present = ['--park-dir', '--park-s', '--park-owner-pid'].map((name) => flags.includes(name))
  const yieldIndex = flags.indexOf(YIELD_FLAG)
  if (!present.some(Boolean) && yieldIndex < 0) return undefined
  if (!present.every(Boolean)) throw new Error('--park-dir, --park-s and --park-owner-pid are required together')
  env = parkEnvironment(env)
  if (env.WT_SUITE_LOCK_BROKER?.trim()) throw new Error('--park-dir is not available inside a lane sandbox')
  const directory = takeFlag(flags, '--park-dir')
  const seconds = Number(takeFlag(flags, '--park-s'))
  const ownerPid = Number(takeFlag(flags, '--park-owner-pid'))
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 7200) throw new Error('--park-s must be whole seconds from 1 to 7200')
  if (flags.includes(YIELD_FLAG)) flags.splice(flags.indexOf(YIELD_FLAG), 1)
  return { ...validateParkDirectory(directory, ownerPid), windowMs: seconds * 1000, yieldToParked: yieldIndex >= 0 }
}

export const parkStaticRun = (context, requested) => !context && requested()
export const parkRunFields = (context) => context ? { park: context } : {}

const sameOwner = (left, right) => left?.pid === right.pid && left?.startTime === right.startTime && left?.pidNamespace === right.pidNamespace
const matchesPark = (park, context, nonce) => park?.nonce === nonce && park.keyHash === context.keyHash && sameOwner(park.owner, context.owner)
const validParkRecord = (record) => record !== null && typeof record === 'object' && !Array.isArray(record)
const validPark = (park) => typeof park?.nonce === 'string' && Number.isFinite(park.parkedAt) && Number.isFinite(park.windowMs) && park.windowMs > 0 && park.windowMs <= 7_200_000 && validParkRecord(park.record) && Number.isSafeInteger(park.owner?.pid) && park.owner.pid > 0
const resumedRecords = new WeakMap()

export function takeParkTicket(queueDir, record, options, ownerIsStale) {
  if (!options.park) return takeJournalTicket(queueDir, record)
  const entry = resumeParkedTicket(queueDir, record, options.park, options.now?.() ?? Date.now(), ownerIsStale, { now: () => options.now?.() ?? Date.now() })
  if (entry) resumedRecords.set(record, entry)
  return takeJournalTicket(queueDir, record, entry?.number)
}

export const parkQueueMetadata = (record) => ({ resumed: resumedRecords.get(record) })
export const grantParkState = (state, lease) => { state.granted = true; return lease }

export function finishParkQueue(state, context, remove) {
  restoreUngrantPark(state, context)
  if (state.resumed) removeParkClaim(state.queueDir, state.ticket, state.record)
  else remove()
}

export function suiteLeaseWithPark(state, holder, context) {
  const lease = { root: state.root, lockDir: state.lockDir, holder }
  return context ? { ...lease, queueDir: state.queueDir, ticket: state.ticket, record: state.record } : lease
}

export function liveParkedTickets(queueDir, now, ownerIsStale) {
  const live = []
  const isLive = (park) => validPark(park) && now < park.parkedAt + park.windowMs && !ownerIsStale(park.owner)
  try { recoverParkAsides(queueDir, now, ownerIsStale, isLive) } catch (error) { warnParkReclaim(error) }
  for (const entry of listParkedFiles(queueDir, now)) {
    const { park } = entry
    const stale = validPark(park) ? now >= park.parkedAt + park.windowMs || ownerIsStale(park.owner) : entry.ageMs >= 10_000
    if (stale) {
      try { removeParkedInstance(queueDir, entry.number, park?.nonce) } catch (error) { warnParkReclaim(error) }
    }
    else if (validPark(park)) live.push(entry)
  }
  return live
}

const warnedReclaims = new Set()
function warnParkReclaim(error) {
  const code = String(error?.code ?? error?.message)
  if (warnedReclaims.has(code)) return
  warnedReclaims.add(code)
  process.stderr.write(`wt-suite-lock: park reclamation failed (${code}); continuing admission\n`)
}

function removeOtherParks(queueDir, context, keep, nonce) {
  for (const entry of listParkedFiles(queueDir, Date.now())) {
    if (entry.park?.keyHash !== context.keyHash || !sameOwner(entry.park.owner, context.owner)) continue
    if (entry.number === keep && entry.park.nonce === nonce) continue
    removeParkedInstance(queueDir, entry.number, entry.park.nonce)
  }
}

function namedParkEntry(queueDir, context, now, ownerIsStale) {
  const named = readParkJson(path.join(context.directory, PARKED_RECORD))
  removeOtherParks(queueDir, context, named?.number, named?.nonce)
  const entry = liveParkedTickets(queueDir, now, ownerIsStale).find((item) => item.number === named?.number)
  if (!entry || !matchesPark(entry.park, context, named.nonce)) return null
  return entry
}

function confirmParkClaim(queueDir, entry, resumed, context, now) {
  const current = readParkJson(parkFile(queueDir, entry.number))
  if (matchesPark(current, context, entry.park.nonce) && now() < current.parkedAt + current.windowMs && removeParkedInstance(queueDir, entry.number, entry.park.nonce)) {
    consumeParkAsides(queueDir, entry.number, entry.park.nonce)
    return true
  }
  removeParkClaim(queueDir, entry.number, resumed)
  return false
}

export function resumeParkedTicket(queueDir, record, context, now, ownerIsStale, seams = {}) {
  if (!context) return null
  const entry = namedParkEntry(queueDir, context, now, ownerIsStale)
  if (!entry) return null
  const resumed = { ...entry.park.record, pid: record.pid, startTime: record.startTime, pidNamespace: record.pidNamespace, argv: record.argv, cwd: record.cwd, leaseId: record.leaseId }
  if (!claimParkedTicket(queueDir, entry.number, resumed)) return null
  try {
    seams.afterClaim?.(entry)
    if (!confirmParkClaim(queueDir, entry, resumed, context, () => seams.now?.() ?? Date.now())) return null
  } catch (error) {
    removeParkClaim(queueDir, entry.number, resumed)
    throw error
  }
  Object.assign(record, resumed)
  // Remove fresh-only fields too: the saved record owns the original priority and queue class.
  for (const key of Object.keys(record)) if (!(key in resumed)) delete record[key]
  return entry
}

export function assertParkClaim(state) {
  if (!state.resumed || parkClaimPresent(state.queueDir, state.ticket, state.record)) return
  const error = new Error('resumed suite ticket was reclaimed; retry wt-suite-lock run with a fresh ticket')
  error.code = 'WT_SUITE_LOCK_UNAVAILABLE'
  throw error
}

function restoreUngrantPark(state, context) {
  if (!state.resumed || state.granted) return
  const named = readParkJson(path.join(context.directory, PARKED_RECORD))
  if (named?.number !== state.ticket || named.nonce !== state.resumed.park.nonce) return
  try { createParkedFile(state.queueDir, state.ticket, state.resumed.park) } catch (error) { if (error?.code !== 'EEXIST') throw error }
}

function parkSuiteLease(lease, context, reason, now = Date.now()) {
  const safeReason = displayText(reason).slice(0, 40)
  const nonce = newParkNonce()
  removeOtherParks(lease.queueDir, context)
  const park = { record: lease.record, keyHash: context.keyHash, owner: context.owner, nonce, parkedAt: now, windowMs: context.windowMs, reason: safeReason }
  createParkedFile(lease.queueDir, lease.ticket, park)
  writeParkPrivate(context.directory, PARKED_RECORD, `${JSON.stringify({ number: lease.ticket, nonce })}\n`)
  return `parked ${lease.ticket} ${nonce} ${safeReason}\n`
}

function parkedAhead(lease, context, entries, now = Date.now()) {
  if (!context?.yieldToParked) return false
  const waiters = readQueueSnapshot(lease.queueDir, now).filter((entry) => entry.number !== lease.ticket && !ticketIsStale(entry)).map((entry) => ({ number: entry.number, record: entry.holder }))
  const numbers = new Set([lease.ticket, ...waiters.map((entry) => entry.number)])
  const parked = entries.filter((entry) => !numbers.has(entry.number)).map((entry) => ({ number: entry.number, record: entry.park.record }))
  const tickets = [...waiters, ...parked, { number: lease.ticket, record: lease.record }]
  const counter = lease.lightCounterBeforeGrant ?? readLightCounter(lease.root)
  const ordered = orderSuiteLockTickets(tickets, counter, now, readP0Counter(lease.root), readSuiteLockRankState(lease.root, tickets)).tickets
  const ahead = ordered.slice(0, ordered.findIndex((entry) => entry.number === lease.ticket))
  return ahead.some((entry) => parked.some((other) => other.number === entry.number))
}

export function shouldYieldParkLease(lease, context, read) {
  return Boolean(context?.yieldToParked) && parkedAhead(lease, context, read(lease.queueDir))
}

export function finishParkRun(lease, context, yielded = false) {
  if (!context || !lease?.record) return 'not-parked\n'
  const reason = yielded ? 'yield' : readParkRequest(context)
  if (reason !== null) return parkSuiteLease(lease, context, reason)
  removeParkPrivate(context, PARKED_RECORD)
  return 'not-parked\n'
}

export function parkStatusEntries(entries, now) {
  return entries.map(({ number, park }) => ({ number, ownerPid: park.owner.pid, level: numericLevel(park.record.level) ? park.record.level : null, reason: displayText(park.reason).slice(0, 40), parkedAt: park.parkedAt, expiresAt: park.parkedAt + park.windowMs, secondsLeft: Math.max(0, (park.parkedAt + park.windowMs - now) / 1000) }))
}

export function publishParkOutcome(context, outcome) {
  if (!context) return
  clearParkRequest(context)
  writeParkPrivate(context.directory, 'outcome', outcome)
}

export function clearParkRequest(context) {
  if (!context) return
  try { removeParkPrivate(context, 'request') } catch (error) { process.stderr.write(`wt-suite-lock: request cleanup failed (${error.code}); publishing outcome\n`) }
}

export function acquireParkCliLease(acquire, context) {
  return context ? (options) => acquireWithParkWait(acquire, options, context) : acquire
}

async function acquireWithParkWait(acquire, options, context) {
  const waiting = watchParkWait()
  try { return await acquire({ ...options, park: context, signal: waiting.signal }) } catch (error) {
    if (error?.code === 'ABORT_ERR') return waiting.exit()
    throw error
  } finally { waiting.close() }
}

export const parkChildEnvironment = (context) => context ? { WT_SUITE_LOCK_PARK_REQUEST: path.join(context.directory, 'request') } : undefined

export function spawnParkEnvironment(marker, extra, env, platform = readHostPlatform()) {
  const commandEnv = { ...env, ...extra, ...(marker ? { WT_SUITE_LEASE: marker } : {}) }
  for (const key of Object.keys(commandEnv)) {
    if ((platform === 'win32' ? key.toUpperCase() : key) === 'WT_SUITE_LOCK_SIZE') delete commandEnv[key]
  }
  return { env: commandEnv }
}
