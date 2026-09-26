#!/usr/bin/env node
import { lookup } from 'node:dns'
import { appendFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

// Host-side egress proxy for a sandboxed lane (lane-sandbox.mjs). The lane runs in its own network
// namespace with nothing but loopback; this proxy, reached over a unix socket bridged into that
// namespace, is its ONLY route out. It tunnels HTTPS CONNECT to port 443 of an exact allow-list of
// hostnames (the model provider's own hosts) and refuses everything else: any other host, any other
// port, any plain-HTTP request, and any allowed name that resolves to a loopback, private or
// link-local address (so an allowed name cannot be pointed back at a host service).

const HEADER_LIMIT_BYTES = 8 * 1024
const CONNECT_LINE = /^CONNECT\s+(\[[^\]\s]+\]|[^\s:[\]]+):(\d{1,5})\s+HTTP\/1\.[01]$/i
const REFUSAL = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'

export function normalizeEgressHost(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.$/, '')
}

// The decision for one request line. Pure: no I/O, so it is locked directly.
export function egressDecision(requestLine, allow) {
  const match = CONNECT_LINE.exec(String(requestLine ?? '').trim())
  if (!match) return { ok: false, host: null, port: null, reason: 'only HTTPS CONNECT is proxied' }
  const host = normalizeEgressHost(match[1])
  const port = Number(match[2])
  if (port !== 443) return { ok: false, host, port, reason: 'only port 443 is allowed' }
  if (!allow.has(host)) return { ok: false, host, port, reason: 'host is not in the lane egress allow-list' }
  return { ok: true, host, port, reason: 'allowed' }
}

function forbiddenV4(address) {
  const [a, b] = address.split('.').map(Number)
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b < 128)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b < 32)
    || (a === 192 && b === 168)
}

// Loopback, private, link-local, CGNAT and unspecified destinations are never tunnelled.
export function isForbiddenDestination(address) {
  const family = net.isIP(String(address ?? ''))
  if (family === 4) return forbiddenV4(address)
  if (family !== 6) return true
  const lower = address.toLowerCase()
  if (lower.startsWith('::ffff:') && net.isIP(lower.slice(7)) === 4) return forbiddenV4(lower.slice(7))
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)
}

/**
 * Builds the proxy server. `allow` is a Set of normalized hostnames; `log` receives one record per
 * request (host, port, decision, reason) and never a header. `resolve` is dns.lookup-shaped.
 */
export function createEgressProxy({ allow, log = () => {}, resolve = lookup, connect = net.connect } = {}) {
  // Half-open: a client may shut its write side right after the request (socat does on stdin EOF);
  // the answer, which can wait on DNS, must still be written back.
  return net.createServer({ allowHalfOpen: true }, (client) => {
    let buffered = Buffer.alloc(0)
    client.on('error', () => client.destroy())
    const refuse = (decision, reason) => {
      log({ host: decision.host, port: decision.port, decision: 'denied', reason })
      client.end(REFUSAL)
    }
    const tunnel = (decision, rest) => (error, address) => {
      if (error || !address) return refuse(decision, `resolution failed (${error?.code ?? 'no address'})`)
      if (isForbiddenDestination(address)) return refuse(decision, `resolves to a forbidden address ${address}`)
      const upstream = connect({ host: address, port: decision.port }, () => {
        log({ host: decision.host, port: decision.port, decision: 'allowed', reason: 'allowed' })
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (rest.length) upstream.write(rest)
        client.pipe(upstream).pipe(client)
      })
      upstream.on('error', () => { if (!client.destroyed) refuse(decision, 'upstream connection failed') })
      client.on('close', () => upstream.destroy())
    }
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buffered.length > HEADER_LIMIT_BYTES) { client.off('data', onData); client.off('end', onEarlyEnd); refuse({ host: null, port: null }, 'request header too large') }
        return
      }
      client.off('data', onData)
      client.off('end', onEarlyEnd)
      const decision = egressDecision(buffered.subarray(0, end).toString('latin1').split('\r\n')[0], allow)
      if (!decision.ok) return refuse(decision, decision.reason)
      resolve(decision.host, { all: false }, tunnel(decision, buffered.subarray(end + 4)))
    }
    // Half-open means an ended client is not closed for us: one that ends before a full header is.
    const onEarlyEnd = () => { client.off('data', onData); refuse({ host: null, port: null }, 'request ended before its header') }
    client.on('data', onData)
    client.once('end', onEarlyEnd)
  })
}

function parseArguments(argv) {
  const options = { allow: new Set(), socket: null, log: null, parent: null }
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1]
    if (argv[index] === '--socket') options.socket = value
    else if (argv[index] === '--allow') for (const host of String(value ?? '').split(',')) { if (host.trim()) options.allow.add(normalizeEgressHost(host)) }
    else if (argv[index] === '--log') options.log = value
    else if (argv[index] === '--parent') options.parent = Number(value)
  }
  return options
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  if (!options.socket) { process.stderr.write('lane-egress-proxy: --socket is required\n'); process.exit(2) }
  const log = (record) => {
    if (!options.log) return
    try { appendFileSync(options.log, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 }) } catch { /* the log is diagnostic only */ }
  }
  const server = createEgressProxy({ allow: options.allow, log })
  server.listen(options.socket)
  // The proxy never outlives the process that started it, even when that process is SIGKILLed.
  if (Number.isSafeInteger(options.parent) && options.parent > 1) {
    setInterval(() => {
      try { process.kill(options.parent, 0) } catch {
        server.close()
        try { rmSync(options.socket, { force: true }) } catch { /* already gone */ }
        process.exit(0)
      }
    }, 2_000)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
