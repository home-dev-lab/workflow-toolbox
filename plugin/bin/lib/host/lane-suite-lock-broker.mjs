#!/usr/bin/env node
import net from 'node:net'
import { isInvokedDirectly } from './entry-guard.mjs'
import { parseHelperArguments, runLaneHelper } from './lane-helper-process.mjs'
import { formatSuiteLockHolder, readSuiteLock, readSuiteLockStatus } from '../suite-lock.mjs'
import { suiteLockPriority } from '../suite-lock-priority.mjs'
import { suiteLockStatusJson } from '../suite-lock-status.mjs'
import { acquireBrokerJournalLease as acquireSuiteLock, observeBrokerJournalSocket, releaseBrokerJournalLease as releaseSuiteLock } from './suite-lock-broker-journal.mjs'
import { suiteOffloadConfig } from './suite-lock-offload-config.mjs'
import { acquireOffloadRace } from './suite-lock-offload-race.mjs'
import { parseOffloadRequest } from './suite-lock-offload-request.mjs'

const REQUEST_LIMIT = 4096
const TRANSPORT_LIMIT = REQUEST_LIMIT + 32 * 1024
const REQUEST_TIMEOUT_MS = 5000
const MAX_CONNECTIONS = 16
// A rejected socket no longer holds a served slot but can linger up to REJECTION_CLOSE_MS, so open
// sockets get their own bound: past it, the server drops a new connection without accepting it.
const MAX_OPEN_SOCKETS = 2 * MAX_CONNECTIONS
const REJECTION_CLOSE_MS = 1000

function rejectConnection(socket, message) {
  if (socket.destroyed) return
  socket.end(`error ${String(message).replace(/[\r\n]/g, ' ')}\n`)
  const timer = setTimeout(() => socket.destroy(), REJECTION_CLOSE_MS)
  timer.unref?.()
  socket.once('close', () => clearTimeout(timer))
}

// The words a broker from before priority used are the exact prefix of this text: the client tells the two
// apart by the `light` this one names (see acquireBrokerSuiteLock in ../suite-lock.mjs).
export const BROKER_REFUSAL = 'argv must be an array of strings (only argv and waitS accepted, plus light as a boolean and offload as a versioned object)'
const REQUEST_FIELDS = new Set(['argv', 'waitS', 'light', 'offload'])

function requestFrom(line) {
  let request
  try { request = JSON.parse(line) } catch { throw new Error('malformed JSON') }
  validateRequestBytes(line, request)
  if (statusRequest(request)) return { status: true }
  if (!validRequestObject(request) || !validRequestArgv(request)) throw new Error(BROKER_REFUSAL)
  const waitS = requestWaitSeconds(request)
  validateRequestLight(request)
  return { argv: request.argv, waitS, light: request.light === true, offload: parseOffloadRequest(request.offload) }
}

function validateRequestBytes(line, request) {
  const base = request?.offload ? JSON.stringify(Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'offload'))) : line
  if (Buffer.byteLength(base, 'utf8') + 1 > REQUEST_LIMIT) throw new Error('request too large')
}

function validateLaneCapability(request, config) {
  if (request.offload && config && request.offload.laneToken !== config.laneToken) throw new Error('offload refused: invalid serving lane capability')
}

function statusRequest(request) {
  return request && !Array.isArray(request) && Object.keys(request).length === 1 && request.status === true
}

function requestWaitSeconds(request) {
  const waitS = request.waitS === undefined ? 2700 : request.waitS
  if (typeof waitS !== 'number' || !Number.isFinite(waitS) || waitS < 0 || waitS > 10_800) throw new Error('waitS must be a number from 0 to 10800')
  return waitS
}

function validateRequestLight(request) {
  if (request.light !== undefined && typeof request.light !== 'boolean') throw new Error('light must be a boolean')
}

function validRequestObject(request) {
  return request && typeof request === 'object' && !Array.isArray(request) && !Object.keys(request).some((key) => !REQUEST_FIELDS.has(key))
}

function validRequestArgv(request) {
  return Array.isArray(request.argv) && request.argv.every((item) => typeof item === 'string')
}

// A lane-owned hold is bounded: a lane command that can never finish (an install with no registry
// access, a hung watcher) must not keep every other session's suite waiting. 2700 s equals the lock's
// default wait; a full suite alone takes well under it. The HOST sets another bound with
// WT_LANE_SUITE_LOCK_MAX_HOLD_S (the lane cannot: the broker runs outside its sandbox).
export const DEFAULT_LANE_SUITE_LOCK_MAX_HOLD_S = 2700
export const LANE_SUITE_LOCK_MAX_HOLD_ENV = 'WT_LANE_SUITE_LOCK_MAX_HOLD_S'
// After the hold bound the lock stays held until the client closes (its command tree has stopped), and
// at most this long: a suspended or wedged client never keeps it beyond the grace.
export const DEFAULT_LANE_SUITE_LOCK_STOP_GRACE_S = 30

// A timer longer than 2^31 - 1 ms fires at once, so the bound stops there (about 24.8 days).
const MAX_HOLD_CEILING_S = 2_147_483

function validMaxHold(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_HOLD_CEILING_S
}

// Unset or blank → the default; anything else must read as a finite number of seconds above 0.
export function laneSuiteLockMaxHoldSeconds(env = process.env) {
  const raw = env?.[LANE_SUITE_LOCK_MAX_HOLD_ENV]
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_LANE_SUITE_LOCK_MAX_HOLD_S
  const value = Number(String(raw).trim())
  if (!validMaxHold(value)) throw new Error(`${LANE_SUITE_LOCK_MAX_HOLD_ENV} must be a finite number of seconds above 0 and at most ${MAX_HOLD_CEILING_S} (got ${JSON.stringify(String(raw))})`)
  return value
}

function hostLockOptions(env, priority) {
  const hostEnv = { ...env }
  const declared = suiteLockPriority({ priority }, hostEnv)
  if (declared === 'release') throw new Error('release priority is not available to a lane broker')
  return { env: hostEnv, priority: declared }
}

function replyStatus(socket, options, finish) {
  const snapshot = readSuiteLockStatus(options)
  socket.end(`status ${JSON.stringify({ ...suiteLockStatusJson(snapshot), capabilities: { offload: Number(Boolean(options.offload)) }, ...(snapshot.staticLane ? { staticLane: snapshot.staticLane } : {}) })}\n`)
  finish()
}

function brokerWaitCallbacks(socket) {
  return observeBrokerJournalSocket(socket, {
    onWait: (line) => { if (!socket.destroyed) socket.write(`wait ${line}\n`) },
    onProgress: ({ ahead, aheadExcludingRelease, total }) => { if (!socket.destroyed) socket.write(`progress ${aheadExcludingRelease} ${total} ${ahead}\n`) },
    onHandover: (holderId, priority) => { if (!socket.destroyed) socket.write(`handover ${holderId}${priority === 'release' ? ' release' : ''}\n`) },
    onRenew: ({ ahead, aheadExcludingRelease, total }) => { if (!socket.destroyed) socket.write(`renew ${aheadExcludingRelease} ${total} ${ahead}\n`) },
  })
}

export function createSuiteLockBroker({ label = '', maxHoldS = DEFAULT_LANE_SUITE_LOCK_MAX_HOLD_S, stopGraceS = DEFAULT_LANE_SUITE_LOCK_STOP_GRACE_S, env = process.env, priority, root } = {}) {
  if (!validMaxHold(maxHoldS)) throw new Error(`maxHoldS must be a finite number of seconds above 0 and at most ${MAX_HOLD_CEILING_S} (got ${String(maxHoldS)})`)
  if (!validMaxHold(stopGraceS)) throw new Error(`stopGraceS must be a finite number of seconds above 0 and at most ${MAX_HOLD_CEILING_S} (got ${String(stopGraceS)})`)
  const lockOptions = { ...hostLockOptions(env, priority), offload: suiteOffloadConfig(root, env) }
  const broker = { active: 0, releases: new Set(), lockOptions, label, maxHoldS, stopGraceS }
  const server = net.createServer((socket) => serveBrokerConnection(socket, broker))
  server.maxConnections = MAX_OPEN_SOCKETS
  // Releases every lock this broker holds (its lease on exit must not wait for its pid to read dead).
  server.releaseAll = () => { for (const release of [...broker.releases]) release() }
  return server
}

function serveBrokerConnection(socket, broker) {
  broker.active += 1
  const state = { socket, broker, buffer: Buffer.alloc(0), lease: null, closed: false, requested: false,
    released: false, holdTimer: null, graceTimer: null, expiredAt: null, controller: new AbortController() }
  state.release = () => releaseConnection(state)
  broker.releases.add(state.release)
  state.finish = () => finishConnection(state)
  state.error = (message) => { state.requested = true; state.finish(); rejectConnection(socket, message) }
  state.timer = setTimeout(() => state.error('request timed out'), REQUEST_TIMEOUT_MS)
  socket.on('error', state.finish)
  socket.on('close', state.finish)
  socket.on('end', state.finish)
  socket.on('data', (chunk) => handleBrokerRequest(state, chunk))
}

function releaseConnection(state) {
  if (state.released) return
  state.released = true
  state.controller.abort()
  state.broker.releases.delete(state.release)
  if (state.lease) releaseSuiteLock(state.lease)
}

function finishConnection(state) {
  if (state.closed) return
  state.closed = true; state.broker.active -= 1; clearTimeout(state.timer); clearTimeout(state.holdTimer); clearTimeout(state.graceTimer)
  if (state.expiredAt !== null && state.lease && !state.released) process.stderr.write(`workflow-toolbox: lane suite-lock broker: hold-bound lease released after its client closed, ${((Date.now() - state.expiredAt) / 1000).toFixed(1)} s after the bound\n`)
  state.release()
}

function brokerRequestLine(state, chunk) {
  if (state.requested) return undefined
  state.buffer = Buffer.concat([state.buffer, chunk])
  if (state.buffer.length > TRANSPORT_LIMIT) { state.requested = true; state.error('request too large'); return undefined }
  const newline = state.buffer.indexOf(10)
  if (newline < 0) return undefined
  state.requested = true; clearTimeout(state.timer)
  return state.buffer.subarray(0, newline).toString('utf8')
}

function answeredBrokerRequest(state, request) {
  if (request.status) { replyStatus(state.socket, state.broker.lockOptions, state.finish); return true }
  if (state.broker.active <= MAX_CONNECTIONS) return false
  const holder = readSuiteLock(state.broker.lockOptions).holder
  state.error(`busy: ${formatSuiteLockHolder(holder)}; requested command ${JSON.stringify(request.argv)}; inspect with wt-suite-lock status`)
  return true
}

function endOffloadConnection(state) {
  state.socket.end()
  const timer = setTimeout(() => state.socket.destroy(), REJECTION_CLOSE_MS)
  timer.unref?.()
  state.socket.once('close', () => clearTimeout(timer))
  state.finish()
}

async function handleBrokerRequest(state, chunk) {
  const line = brokerRequestLine(state, chunk)
  if (line === undefined) return
  let request
  try {
    request = requestFrom(line)
    validateLaneCapability(request, state.broker.lockOptions.offload)
    if (answeredBrokerRequest(state, request)) return
    const { socket, broker, controller } = state
    const acquired = await acquireOffloadRace(acquireSuiteLock, releaseSuiteLock, {
      ...broker.lockOptions, argv: ['wt-lane-sandbox', broker.label, ...request.argv], waitS: request.waitS,
      ...(request.light ? { light: true } : {}), signal: controller.signal, ...brokerWaitCallbacks(socket),
    }, { config: broker.lockOptions.offload, request, socket, deadlineS: broker.maxHoldS, completed: () => endOffloadConnection(state) })
    if (state.closed) { releaseSuiteLock(acquired); return }
    state.lease = acquired
    socket.write(`granted ${state.lease.holder.leaseId}\n`)
    state.holdTimer = setTimeout(() => expireBrokerLease(state, request), broker.maxHoldS * 1000)
    state.holdTimer.unref?.()
  } catch (cause) { reportBrokerRequestError(state, cause, request) }
}

function reportBrokerRequestError(state, cause, request) {
  if (!state.closed && cause?.code !== 'ABORT_ERR') state.error(`${cause?.message ?? String(cause)}; requested command ${JSON.stringify(request?.argv ?? 'unavailable')}`)
}

function expireBrokerLease(state, request) {
  if (state.closed) return
  state.expiredAt = Date.now()
  const { maxHoldS, stopGraceS } = state.broker
  // Retain exclusion until the client stops its command tree, or the stop grace expires.
  const text = `hold bound: lane lease expired after ${maxHoldS} s (${LANE_SUITE_LOCK_MAX_HOLD_ENV}); command ${JSON.stringify(request.argv)} must stop; the lock is released once it has stopped, at most ${stopGraceS} s from now`
  if (!state.socket.destroyed) state.socket.write(`error ${text.replace(/[\r\n]/g, ' ')}\n`)
  process.stderr.write(`workflow-toolbox: lane suite-lock broker: ${text}\n`)
  state.graceTimer = setTimeout(() => finishBrokerGrace(state, request), stopGraceS * 1000)
  state.graceTimer.unref?.()
}

function finishBrokerGrace(state, request) {
  if (state.closed) return
  process.stderr.write(`workflow-toolbox: lane suite-lock broker: hold-bound lease released after the ${state.broker.stopGraceS} s stop grace; its client did not close; command ${JSON.stringify(request.argv)}\n`)
  state.release(); state.socket.destroy(); state.finish()
}

function main() {
  const options = { socket: null, parent: null, parentStart: null, label: '', root: null }
  parseHelperArguments(process.argv.slice(2), options, {
    '--label': (value) => { options.label = String(value ?? '') },
    '--root': (value) => { options.root = String(value ?? '') },
  })
  let maxHoldS
  try { maxHoldS = laneSuiteLockMaxHoldSeconds(process.env) } catch (error) {
    // Refused before listening: no socket, no readiness marker, so the launch refuses the lane.
    process.stderr.write(`workflow-toolbox: lane suite-lock broker refused to start: ${error.message}\n`)
    process.exit(2)
  }
  const server = createSuiteLockBroker({ label: options.label, maxHoldS, root: options.root })
  // A broker that is going away releases every lock it holds first, so the next waiter is not left
  // to wait for its pid to read dead; each lane client then sees its lease lost and stops its suite.
  runLaneHelper({ server, options, name: 'suite-lock broker', beforeExit: () => server.releaseAll() })
}

if (isInvokedDirectly(import.meta.url)) main()
