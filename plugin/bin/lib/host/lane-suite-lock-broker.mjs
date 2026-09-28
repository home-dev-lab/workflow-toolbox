#!/usr/bin/env node
import net from 'node:net'
import { isInvokedDirectly } from './entry-guard.mjs'
import { parseHelperArguments, runLaneHelper } from './lane-helper-process.mjs'
import { acquireSuiteLock, releaseSuiteLock } from '../suite-lock.mjs'

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

function requestFrom(line) {
  let request
  try { request = JSON.parse(line) } catch { throw new Error('malformed JSON') }
  if (!request || typeof request !== 'object' || !Array.isArray(request.argv) || !request.argv.every((item) => typeof item === 'string')) throw new Error('argv must be an array of strings')
  const waitS = request.waitS === undefined ? 2700 : request.waitS
  if (typeof waitS !== 'number' || !Number.isFinite(waitS) || waitS < 0 || waitS > 10_800) throw new Error('waitS must be a number from 0 to 10800')
  return { argv: request.argv, waitS }
}

export function createSuiteLockBroker({ label = '' } = {}) {
  let active = 0
  const releases = new Set()
  const server = net.createServer((socket) => {
    if (active >= MAX_CONNECTIONS) { socket.on('error', () => {}); rejectConnection(socket, 'busy'); return }
    active += 1
    let buffer = Buffer.alloc(0)
    let lease = null
    let closed = false
    let requested = false
    let released = false
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
      closed = true; active -= 1; clearTimeout(timer); release()
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
      try {
        const request = requestFrom(buffer.subarray(0, newline).toString('utf8'))
        const acquired = await acquireSuiteLock({
          argv: ['wt-lane-sandbox', label, ...request.argv.slice(0, 2)],
          waitS: request.waitS,
          signal: controller.signal,
          onWait: (line) => { if (!socket.destroyed) socket.write(`wait ${line}\n`) },
        })
        if (closed) { releaseSuiteLock(acquired); return }
        lease = acquired
        socket.write(`granted ${lease.holder.leaseId}\n`)
      } catch (cause) {
        if (!closed && cause?.code !== 'ABORT_ERR') error(cause?.message ?? String(cause))
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
  const server = createSuiteLockBroker({ label: options.label })
  // A broker that is going away releases every lock it holds first, so the next waiter is not left
  // to wait for its pid to read dead; each lane client then sees its lease lost and stops its suite.
  runLaneHelper({ server, options, name: 'suite-lock broker', beforeExit: () => server.releaseAll() })
}

if (isInvokedDirectly(import.meta.url)) main()
