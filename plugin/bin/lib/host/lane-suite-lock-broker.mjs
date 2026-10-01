#!/usr/bin/env node
import net from 'node:net'
import { isInvokedDirectly } from './entry-guard.mjs'
import { parseHelperArguments, runLaneHelper } from './lane-helper-process.mjs'
import { acquireSuiteLock, formatSuiteLockHolder, readSuiteLock, releaseSuiteLock } from '../suite-lock.mjs'

const REQUEST_LIMIT = 4096
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
export const BROKER_REFUSAL = 'argv must be an array of strings (only argv and waitS accepted, plus light as a boolean)'

function requestFrom(line) {
  let request
  try { request = JSON.parse(line) } catch { throw new Error('malformed JSON') }
  if (request && !Array.isArray(request) && Object.keys(request).length === 1 && request.status === true) return { status: true }
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((key) => key !== 'argv' && key !== 'waitS' && key !== 'light') || !Array.isArray(request.argv) || !request.argv.every((item) => typeof item === 'string')) throw new Error(BROKER_REFUSAL)
  const waitS = request.waitS === undefined ? 2700 : request.waitS
  if (typeof waitS !== 'number' || !Number.isFinite(waitS) || waitS < 0 || waitS > 10_800) throw new Error('waitS must be a number from 0 to 10800')
  if (request.light !== undefined && typeof request.light !== 'boolean') throw new Error('light must be a boolean')
  return { argv: request.argv, waitS, light: request.light === true }
}

// A lane-owned hold is bounded: a lane command that can never finish (an install with no registry
// access, a hung watcher) must not keep every other session's suite waiting. 2700 s equals the lock's
// default wait; a full suite alone takes well under it. The HOST sets another bound with
// WT_LANE_SUITE_LOCK_MAX_HOLD_S (the lane cannot: the broker runs outside its sandbox).
export const DEFAULT_LANE_SUITE_LOCK_MAX_HOLD_S = 2700
export const LANE_SUITE_LOCK_MAX_HOLD_ENV = 'WT_LANE_SUITE_LOCK_MAX_HOLD_S'

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

export function createSuiteLockBroker({ label = '', maxHoldS = DEFAULT_LANE_SUITE_LOCK_MAX_HOLD_S } = {}) {
  if (!validMaxHold(maxHoldS)) throw new Error(`maxHoldS must be a finite number of seconds above 0 and at most ${MAX_HOLD_CEILING_S} (got ${String(maxHoldS)})`)
  let active = 0
  const releases = new Set()
  const server = net.createServer((socket) => {
    active += 1
    let buffer = Buffer.alloc(0)
    let lease = null
    let closed = false
    let requested = false
    let released = false
    let holdTimer = null
    const controller = new AbortController()
    const release = () => {
      if (released) return
      released = true
      controller.abort()
      releases.delete(release)
      if (lease) releaseSuiteLock(lease)
    }
    releases.add(release)
    const finish = () => {
      if (closed) return
      closed = true; active -= 1; clearTimeout(timer); clearTimeout(holdTimer); release()
    }
    // The answer is final, so the served slot is freed now, not when the rejected client goes away.
    const error = (message) => { requested = true; finish(); rejectConnection(socket, message) }
    const timer = setTimeout(() => error('request timed out'), REQUEST_TIMEOUT_MS)
    socket.on('error', finish)
    socket.on('close', finish)
    socket.on('end', finish)
    socket.on('data', async (chunk) => {
      if (requested) return
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > REQUEST_LIMIT) { requested = true; error('request too large'); return }
      const newline = buffer.indexOf(10)
      if (newline < 0) return
      requested = true; clearTimeout(timer)
      let request
      try {
        request = requestFrom(buffer.subarray(0, newline).toString('utf8'))
        if (request.status) {
          const lock = readSuiteLock()
          socket.end(`status ${JSON.stringify({ held: lock.held, holder: lock.holder })}\n`)
          finish()
          return
        }
        if (active > MAX_CONNECTIONS) {
          const holder = readSuiteLock().holder
          error(`busy: ${formatSuiteLockHolder(holder)}; requested command ${JSON.stringify(request.argv)}; inspect with wt-suite-lock status`)
          return
        }
        const acquired = await acquireSuiteLock({
          argv: ['wt-lane-sandbox', label, ...request.argv],
          waitS: request.waitS,
          ...(request.light ? { light: true } : {}),
          signal: controller.signal,
          onWait: (line) => { if (!socket.destroyed) socket.write(`wait ${line}\n`) },
        })
        if (closed) { releaseSuiteLock(acquired); return }
        lease = acquired
        socket.write(`granted ${lease.holder.leaseId}\n`)
        holdTimer = setTimeout(() => {
          if (closed) return
          const text = `hold bound: lane lease released after ${maxHoldS} s (${LANE_SUITE_LOCK_MAX_HOLD_ENV}); command ${JSON.stringify(request.argv)} stopped`
          if (!socket.destroyed) socket.write(`error ${text.replace(/[\r\n]/g, ' ')}\n`)
          release()
          if (!socket.destroyed) socket.end()
          process.stderr.write(`workflow-toolbox: lane suite-lock broker: ${text}\n`)
          finish()
        }, maxHoldS * 1000)
        holdTimer.unref?.()
      } catch (cause) {
        if (!closed && cause?.code !== 'ABORT_ERR') error(`${cause?.message ?? String(cause)}; requested command ${JSON.stringify(request?.argv ?? 'unavailable')}`)
      }
    })
  })
  server.maxConnections = MAX_OPEN_SOCKETS
  // Releases every lock this broker holds (its lease on exit must not wait for its pid to read dead).
  server.releaseAll = () => { for (const release of [...releases]) release() }
  return server
}

function main() {
  const options = { socket: null, parent: null, parentStart: null, label: '' }
  parseHelperArguments(process.argv.slice(2), options, {
    '--label': (value) => { options.label = String(value ?? '') },
  })
  let maxHoldS
  try { maxHoldS = laneSuiteLockMaxHoldSeconds(process.env) } catch (error) {
    // Refused before listening: no socket, no readiness marker, so the launch refuses the lane.
    process.stderr.write(`workflow-toolbox: lane suite-lock broker refused to start: ${error.message}\n`)
    process.exit(2)
  }
  const server = createSuiteLockBroker({ label: options.label, maxHoldS })
  // A broker that is going away releases every lock it holds first, so the next waiter is not left
  // to wait for its pid to read dead; each lane client then sees its lease lost and stops its suite.
  runLaneHelper({ server, options, name: 'suite-lock broker', beforeExit: () => server.releaseAll() })
}

if (isInvokedDirectly(import.meta.url)) main()
