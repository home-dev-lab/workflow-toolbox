#!/usr/bin/env node
import { rmSync } from 'node:fs'
import net from 'node:net'
import { isInvokedDirectly } from './entry-guard.mjs'
import { parentAlive } from './lane-egress-proxy.mjs'
import { acquireSuiteLock, releaseSuiteLock } from '../suite-lock.mjs'

const REQUEST_LIMIT = 4096
const REQUEST_TIMEOUT_MS = 5000
const MAX_CONNECTIONS = 16

function parseArguments(argv) {
  const options = { socket: null, parent: null, parentStart: null, label: '' }
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1]
    if (argv[index] === '--socket') options.socket = value
    else if (argv[index] === '--parent') options.parent = Number(value)
    else if (argv[index] === '--parent-start') options.parentStart = Number.isFinite(Number(value)) ? Number(value) : null
    else if (argv[index] === '--label') options.label = String(value ?? '')
  }
  return options
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
  return net.createServer((socket) => {
    if (active >= MAX_CONNECTIONS) { socket.end('error busy\n'); return }
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
      if (lease) releaseSuiteLock(lease)
    }
    const finish = () => {
      if (closed) return
      closed = true; active -= 1; clearTimeout(timer); release()
    }
    const error = (message) => { if (!socket.destroyed) socket.end(`error ${String(message).replace(/[\r\n]/g, ' ')}\n`) }
    const timer = setTimeout(() => { error('request timed out'); socket.destroy() }, REQUEST_TIMEOUT_MS)
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
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const fatal = (message) => {
    process.stderr.write(`workflow-toolbox: lane suite-lock broker stopped: ${message}\n`)
    try { rmSync(options.socket, { force: true }) } catch { /* nothing to remove */ }
    process.exit(3)
  }
  if (!options.socket) fatal('--socket is required')
  process.on('uncaughtException', (error) => fatal(error?.message ?? String(error)))
  const server = createSuiteLockBroker({ label: options.label })
  let listening = false
  server.on('error', (error) => { if (!listening) fatal(`cannot listen on its socket (${error.code ?? error.message})`) })
  server.listen(options.socket, () => { listening = true })
  if (Number.isSafeInteger(options.parent) && options.parent > 1) {
    setInterval(() => {
      if (parentAlive(options.parent, options.parentStart)) return
      server.close()
      try { rmSync(options.socket, { force: true }) } catch { /* already gone */ }
      process.exit(0)
    }, 2000)
  }
}

if (isInvokedDirectly(import.meta.url)) main()
