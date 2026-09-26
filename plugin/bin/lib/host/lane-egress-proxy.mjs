#!/usr/bin/env node
import { lookup } from 'node:dns'
import { closeSync, constants, fstatSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

// Host-side egress proxy for a sandboxed lane (lane-sandbox.mjs). The lane runs in its own network
// namespace with nothing but loopback; this proxy, reached over a unix socket bridged into that
// namespace, is its only route out. It tunnels HTTPS CONNECT to port 443 of an exact allow-list of
// hostnames (the model provider's own hosts) and refuses any other host, any other port, any
// plain-HTTP request, and any allowed name that resolves to a non-public address. Inside the tunnel
// it reads the first TLS ClientHello and requires its SNI to equal the CONNECT host, so a lane
// cannot CONNECT to an allowed CDN name and then ask the CDN for another site by SNI; a hello with
// no SNI, with Encrypted Client Hello, or malformed is refused.
//
// What it does NOT stop, stated so nobody reads more into it:
// - Host-header fronting INSIDE the encrypted TLS stream (SNI = allowed host, HTTP Host = another
//   site on the same CDN) cannot be seen without terminating TLS, which this proxy does not do.
// - An account on the allowed provider is itself a place to send data: whatever the lane can send
//   to its model, it can send there.

const HEADER_LIMIT_BYTES = 8 * 1024
const HELLO_LIMIT_BYTES = 32 * 1024
const HELLO_MAX_RECORDS = 4
const PHASE_TIMEOUT_MS = 10_000
const CONNECT_LINE = /^CONNECT\s+(\[[^\]\s]+\]|[^\s:[\]]+):(\d{1,5})\s+HTTP\/1\.[01]$/i
const LOGGABLE_HOST = /^[a-z0-9.-]{1,253}$/
const REFUSAL = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
const TLS_HANDSHAKE = 0x16
const CLIENT_HELLO = 0x01
const EXTENSION_SNI = 0x0000
const EXTENSION_ECH = 0xfe0d
export const EGRESS_LOG_LIMIT_BYTES = 1024 * 1024

export function normalizeEgressHost(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.$/, '')
}

// A host goes into the log only if it is a plain DNS name; anything else is a placeholder, so a
// lane-chosen CONNECT target can never write shell syntax into the log file.
export function loggableHost(host) {
  if (host == null) return null
  return typeof host === 'string' && LOGGABLE_HOST.test(host) ? host : '<non-dns host>'
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
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b < 128)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b < 32)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
}

// Eight 16-bit groups, or null. Accepts an embedded dotted IPv4 tail.
function ipv6Groups(address) {
  let text = address.toLowerCase()
  const lastField = text.slice(text.lastIndexOf(':') + 1)
  if (net.isIP(lastField) === 4) {
    const [a, b, c, d] = lastField.split('.').map(Number)
    text = `${text.slice(0, -lastField.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail = null, extra] = text.split('::')
  if (extra !== undefined) return null
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const missing = 8 - left.length - right.length
  if (tail === null ? left.length !== 8 : missing < 1) return null
  const groups = [...left, ...Array(tail === null ? 0 : missing).fill('0'), ...right].map((group) => Number.parseInt(group, 16))
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null
}

function forbiddenV6(address) {
  const g = ipv6Groups(address)
  if (!g) return true
  const embeddedV4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return forbiddenV4(embeddedV4) // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return true // ::, ::1, IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return true // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (g[0] === 0x2002) return true // 6to4
  const top = g[0] >> 8
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || top === 0xff
}

// Loopback, private, link-local, CGNAT, benchmark, multicast, reserved, broadcast and unspecified
// destinations are never tunnelled, in any IPv6 spelling that embeds one.
export function isForbiddenDestination(address) {
  const family = net.isIP(String(address ?? ''))
  if (family === 4) return forbiddenV4(address)
  if (family === 6) return forbiddenV6(address)
  return true
}

/**
 * Parses the TLS records at the start of a client stream. Returns { need: true } while more bytes
 * are required, { ok: true, sni, bytes } for a ClientHello carrying exactly one host_name, and
 * { ok: false, reason } otherwise (no SNI, ECH, malformed, or fragmented beyond the bound).
 */
export function readClientHello(buffer) {
  let offset = 0
  let handshake = Buffer.alloc(0)
  for (let records = 0; records < HELLO_MAX_RECORDS; records += 1) {
    if (buffer.length < offset + 5) return buffer.length > HELLO_LIMIT_BYTES ? { ok: false, reason: 'TLS hello exceeds the size bound' } : { need: true }
    if (buffer[offset] !== TLS_HANDSHAKE) return { ok: false, reason: 'first bytes in the tunnel are not a TLS handshake' }
    const length = buffer.readUInt16BE(offset + 3)
    if (length === 0 || length > 16_384) return { ok: false, reason: 'malformed TLS record length' }
    if (buffer.length < offset + 5 + length) return offset + 5 + length > HELLO_LIMIT_BYTES ? { ok: false, reason: 'TLS hello exceeds the size bound' } : { need: true }
    handshake = Buffer.concat([handshake, buffer.subarray(offset + 5, offset + 5 + length)])
    offset += 5 + length
    if (handshake.length >= 4) {
      if (handshake[0] !== CLIENT_HELLO) return { ok: false, reason: 'first handshake message is not a ClientHello' }
      const bodyLength = handshake.readUIntBE(1, 3)
      if (handshake.length >= 4 + bodyLength) {
        const parsed = parseHelloBody(handshake.subarray(4, 4 + bodyLength))
        return parsed.ok ? { ...parsed, bytes: offset } : parsed
      }
    }
  }
  return { ok: false, reason: `ClientHello fragmented over more than ${HELLO_MAX_RECORDS} records` }
}

function parseHelloBody(body) {
  const malformed = { ok: false, reason: 'malformed ClientHello' }
  let at = 34 // legacy_version + random
  if (body.length < at + 1) return malformed
  at += 1 + body[at] // session id
  if (body.length < at + 2) return malformed
  at += 2 + body.readUInt16BE(at) // cipher suites
  if (body.length < at + 1) return malformed
  at += 1 + body[at] // compression methods
  if (body.length < at + 2) return { ok: false, reason: 'ClientHello carries no SNI' }
  const end = at + 2 + body.readUInt16BE(at)
  if (end > body.length) return malformed
  at += 2
  const names = []
  while (at + 4 <= end) {
    const type = body.readUInt16BE(at)
    const length = body.readUInt16BE(at + 2)
    const data = body.subarray(at + 4, at + 4 + length)
    if (at + 4 + length > end) return malformed
    if (type === EXTENSION_ECH) return { ok: false, reason: 'ClientHello uses Encrypted Client Hello' }
    if (type === EXTENSION_SNI) {
      const sni = parseServerName(data)
      if (!sni) return malformed
      names.push(sni)
    }
    at += 4 + length
  }
  if (at !== end) return malformed
  if (names.length !== 1) return { ok: false, reason: names.length ? 'ClientHello carries more than one SNI' : 'ClientHello carries no SNI' }
  return { ok: true, sni: normalizeEgressHost(names[0]) }
}

function parseServerName(data) {
  if (data.length < 5 || data.readUInt16BE(0) !== data.length - 2) return null
  if (data[2] !== 0) return null // host_name
  const length = data.readUInt16BE(3)
  if (length === 0 || 5 + length !== data.length) return null
  return data.subarray(5).toString('latin1')
}

function tunnelClient({ client, decision, rest, address, log, connect, refuse }) {
  let upstream = null
  let established = false
  let hello = rest
  const fail = (reason) => {
    log({ host: decision.host, port: decision.port, decision: 'denied', reason })
    // Once 200 was sent the stream is TLS: never write an HTTP answer into it, only close it.
    if (established) client.destroy()
    else refuse(decision, reason)
    upstream?.destroy()
  }
  const timer = setTimeout(() => fail(established ? 'no TLS ClientHello in time' : 'upstream connect timed out'), PHASE_TIMEOUT_MS)
  client.on('close', () => { clearTimeout(timer); upstream?.destroy() })
  const onHello = (chunk) => {
    hello = Buffer.concat([hello, chunk])
    const parsed = readClientHello(hello)
    if (parsed.need) return
    client.off('data', onHello)
    clearTimeout(timer)
    if (!parsed.ok) return fail(parsed.reason)
    if (parsed.sni !== decision.host) return fail(`TLS SNI ${loggableHost(parsed.sni)} does not match the CONNECT host`)
    log({ host: decision.host, port: decision.port, decision: 'allowed', reason: 'allowed' })
    upstream.write(hello)
    upstream.resume()
    client.pipe(upstream).pipe(client)
  }
  upstream = connect({ host: address, port: decision.port }, () => {
    established = true
    upstream.pause()
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    client.on('data', onHello)
    if (hello.length) onHello(Buffer.alloc(0))
  })
  upstream.on('error', () => fail('upstream connection failed'))
  upstream.on('close', () => { if (established) client.destroy() })
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
    let settled = false
    client.on('error', () => client.destroy())
    const refuse = (decision, reason) => {
      if (settled) return
      settled = true
      log({ host: decision.host, port: decision.port, decision: 'denied', reason })
      client.end(REFUSAL)
    }
    const headerTimer = setTimeout(() => refuse({ host: null, port: null }, 'request header timed out'), PHASE_TIMEOUT_MS)
    client.on('close', () => clearTimeout(headerTimer))
    const resolved = (decision, rest) => {
      const dnsTimer = setTimeout(() => refuse(decision, 'resolution timed out'), PHASE_TIMEOUT_MS)
      return (error, address) => {
        clearTimeout(dnsTimer)
        if (settled || client.destroyed) return
        if (error || !address) return refuse(decision, `resolution failed (${error?.code ?? 'no address'})`)
        if (isForbiddenDestination(address)) return refuse(decision, `resolves to a forbidden address ${address}`)
        settled = true
        tunnelClient({ client, decision, rest, address, log, connect, refuse: (d, reason) => { settled = false; refuse(d, reason) } })
      }
    }
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buffered.length > HEADER_LIMIT_BYTES) { detach(); refuse({ host: null, port: null }, 'request header too large') }
        return
      }
      detach()
      const decision = egressDecision(buffered.subarray(0, end).toString('latin1').split('\r\n')[0], allow)
      if (!decision.ok) return refuse(decision, decision.reason)
      resolve(decision.host, { all: false }, resolved(decision, buffered.subarray(end + 4)))
    }
    // Half-open means an ended client is not closed for us: one that ends before a full header is.
    const onEarlyEnd = () => { detach(); refuse({ host: null, port: null }, 'request ended before its header') }
    const detach = () => { clearTimeout(headerTimer); client.off('data', onData); client.off('end', onEarlyEnd) }
    client.on('data', onData)
    client.once('end', onEarlyEnd)
  })
}

/**
 * Appends one JSON line per record to `file`. The final path component is opened with O_NOFOLLOW
 * (a symlink planted there is refused, never followed), hosts are reduced to plain DNS names, and
 * the file stops growing at `limit` bytes.
 */
export function egressLogWriter(file, { limit = EGRESS_LOG_LIMIT_BYTES, now = () => new Date() } = {}) {
  let capped = false
  return (record) => {
    if (!file || capped) return
    let fd
    try {
      fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
      const line = `${JSON.stringify({ at: now().toISOString(), ...record, host: loggableHost(record.host) })}\n`
      if (fstatSync(fd).size + line.length > limit) {
        capped = true
        const reason = `egress log reached ${limit} bytes; later requests are not logged`
        writeSync(fd, `${JSON.stringify({ at: now().toISOString(), decision: 'log-capped', reason })}\n`)
      } else writeSync(fd, line)
    } catch { /* the log is diagnostic only: a refused open (symlink, permissions) writes nothing */ } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}

// /proc/<pid>/stat field 22: a pid whose start time changed is a DIFFERENT process (pid reuse).
export function processStartTicks(pid, readFile = (file) => readFileSync(file, 'utf8')) {
  try {
    const stat = readFile(`/proc/${pid}/stat`)
    const start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
    return Number.isFinite(start) ? start : null
  } catch { return null }
}

export function parentAlive(pid, startTicks, { kill = process.kill, readStart = processStartTicks } = {}) {
  try { kill(pid, 0) } catch { return false }
  return startTicks === null || readStart(pid) === startTicks
}

function parseArguments(argv) {
  const options = { allow: new Set(), socket: null, log: null, parent: null, parentStart: null }
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1]
    if (argv[index] === '--socket') options.socket = value
    else if (argv[index] === '--allow') for (const host of String(value ?? '').split(',')) { if (host.trim()) options.allow.add(normalizeEgressHost(host)) }
    else if (argv[index] === '--log') options.log = value
    else if (argv[index] === '--parent') options.parent = Number(value)
    else if (argv[index] === '--parent-start') options.parentStart = Number.isFinite(Number(value)) ? Number(value) : null
  }
  return options
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const fatal = (message) => {
    process.stderr.write(`workflow-toolbox: lane egress proxy stopped: ${message}; the sandboxed lane has no egress\n`)
    try { rmSync(options.socket, { force: true }) } catch { /* nothing to remove */ }
    process.exit(3)
  }
  if (!options.socket) fatal('--socket is required')
  process.on('uncaughtException', (error) => fatal(error?.message ?? String(error)))
  const server = createEgressProxy({ allow: options.allow, log: egressLogWriter(options.log) })
  // A listen failure is fatal (the launch then refuses: its socket never appears). An accept error
  // (EMFILE) is transient: the proxy keeps serving and says so once.
  let listening = false
  let acceptErrorReported = false
  server.on('error', (error) => {
    if (!listening) fatal(`cannot listen on its socket (${error.code ?? error.message})`)
    if (!acceptErrorReported) process.stderr.write(`workflow-toolbox: lane egress proxy accept error (${error.code ?? error.message}); still serving\n`)
    acceptErrorReported = true
  })
  server.listen(options.socket, () => { listening = true })
  // The proxy exits within one poll (2 s) of its parent's death, SIGKILL included: the parent pid
  // AND its start time are checked, so a reused pid does not keep it alive.
  if (Number.isSafeInteger(options.parent) && options.parent > 1) {
    setInterval(() => {
      if (parentAlive(options.parent, options.parentStart)) return
      server.close()
      try { rmSync(options.socket, { force: true }) } catch { /* already gone */ }
      process.exit(0)
    }, 2_000)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
