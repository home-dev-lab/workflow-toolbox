import { spawn, spawnSync } from 'node:child_process'
import { constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Card 1871036638205838753, round 3, defect 1: the host-side egress proxy that is a sandboxed lane's
// only route out. Portable: every test runs on loopback with an injected resolver/connector, so no
// test reaches the internet and none needs bubblewrap.

const LIB = join(fileURLToPath(new URL('../../../..', import.meta.url)), 'plugin/bin/lib/host')
interface Decision { ok: boolean, host: string | null, port: number | null, reason: string }
interface ProxyModule {
  egressDecision: (line: string, allow: Set<string>) => Decision
  isForbiddenDestination: (address: string) => boolean
  createEgressProxy: (options: Record<string, unknown>) => net.Server
  readClientHello: (buffer: Buffer) => { need?: true, ok?: boolean, sni?: string, reason?: string, bytes?: number }
  egressLogWriter: (file: string, options?: Record<string, unknown>) => (record: Record<string, unknown>) => void
  loggableHost: (host: string | null) => string | null
  parentAlive: (pid: number, startTicks: number | null, deps?: Record<string, unknown>) => boolean
  processStartTicks: (pid: number) => number | null
  createEndpointRelay: (options: { host: string, port: number, connections?: Set<net.Socket> }) => net.Server
}
const proxy = (await import(pathToFileURL(join(LIB, 'lane-egress-proxy.mjs')).href)) as ProxyModule
it.skipIf(process.platform !== 'linux')('does not block opening an existing FIFO egress log', () => {
  const root = mkdtempSync(join(tmpdir(), 'egress-fifo-'))
  try {
    const fifo = join(root, 'log')
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0)
    const result = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(join(LIB, 'lane-egress-proxy.mjs')).href)}).then(m => { m.egressLogWriter(${JSON.stringify(fifo)})({ host: 'example.com' }) })`], { timeout: 2000, encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
const servers: net.Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

const allow = new Set(['chatgpt.com', 'auth.openai.com'])

// A minimal but well-formed TLS 1.2/1.3 ClientHello, built by hand so each field can be broken.
function extension(type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(4); head.writeUInt16BE(type, 0); head.writeUInt16BE(data.length, 2)
  return Buffer.concat([head, data])
}
function sniExtension(name: string): Buffer {
  const host = Buffer.from(name, 'latin1')
  const entry = Buffer.concat([Buffer.from([0, host.length >> 8, host.length & 0xff]), host])
  const list = Buffer.concat([Buffer.from([entry.length >> 8, entry.length & 0xff]), entry])
  return extension(0x0000, list)
}
function clientHello(extensions: Buffer[]): Buffer {
  const ext = Buffer.concat(extensions)
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0]), Buffer.from([0, 2, 0x13, 0x01]), Buffer.from([1, 0]), Buffer.from([ext.length >> 8, ext.length & 0xff]), ext])
  return Buffer.concat([Buffer.from([1, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff]), body])
}
function helloRecords(handshake: Buffer, size = 16_384): Buffer {
  const out: Buffer[] = []
  for (let at = 0; at < handshake.length; at += size) {
    const chunk = handshake.subarray(at, at + size)
    out.push(Buffer.from([0x16, 3, 1, chunk.length >> 8, chunk.length & 0xff]), chunk)
  }
  return Buffer.concat(out)
}

// Round 4, HIGH 1: the SNI inside the tunnel must equal the CONNECT host.
describe('TLS ClientHello reading (pure)', () => {
  it('reads the one SNI of a hello in one record or reassembled across records', () => {
    expect(proxy.readClientHello(helloRecords(clientHello([sniExtension('ChatGPT.com')])))).toMatchObject({ ok: true, sni: 'chatgpt.com' })
    expect(proxy.readClientHello(helloRecords(clientHello([extension(0x000a, Buffer.alloc(8)), sniExtension('chatgpt.com')]), 20))).toMatchObject({ ok: true, sni: 'chatgpt.com' })
  })
  it('asks for more bytes while a record is incomplete', () => {
    expect(proxy.readClientHello(helloRecords(clientHello([sniExtension('chatgpt.com')])).subarray(0, 20))).toEqual({ need: true })
  })
  it('refuses no SNI, two SNIs, ECH, a non-handshake, a malformed hello, and fragmentation past the bound', () => {
    expect(proxy.readClientHello(helloRecords(clientHello([])))).toMatchObject({ ok: false, reason: 'ClientHello carries no SNI' })
    expect(proxy.readClientHello(helloRecords(clientHello([sniExtension('chatgpt.com'), sniExtension('example.com')])))).toMatchObject({ ok: false, reason: 'ClientHello carries more than one SNI' })
    expect(proxy.readClientHello(helloRecords(clientHello([sniExtension('chatgpt.com'), extension(0xfe0d, Buffer.alloc(16))])))).toMatchObject({ ok: false, reason: 'ClientHello uses Encrypted Client Hello' })
    expect(proxy.readClientHello(Buffer.from('GET / HTTP/1.1\r\n\r\n'))).toMatchObject({ ok: false })
    const broken = helloRecords(clientHello([sniExtension('chatgpt.com')])); broken.writeUInt16BE(0xffff, 5 + 4 + 35 + 2 + 4 + 2 + 2)
    expect(proxy.readClientHello(broken)).toMatchObject({ ok: false })
    expect(proxy.readClientHello(helloRecords(clientHello([sniExtension('chatgpt.com')]), 10))).toMatchObject({ ok: false, reason: 'ClientHello fragmented over more than 4 records' })
  })
})

describe('forbidden destinations, every spelling (round 4, LOW 8)', () => {
  it('refuses multicast, reserved, broadcast, benchmark, and IPv6 forms that embed or translate IPv4', () => {
    for (const address of ['224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '198.18.0.1', '198.19.255.255', '::ffff:7f00:1', '::ffff:0a00:0001', '::127.0.0.1', '64:ff9b::0808:0808', '64:ff9b::8.8.8.8', '2002:c000:0204::1', 'fec0::1', 'ff02::1', 'ff00::']) {
      expect(proxy.isForbiddenDestination(address), address).toBe(true)
    }
    for (const address of ['8.8.8.8', '198.20.0.1', '223.255.255.255', '::ffff:8.8.8.8', '::ffff:0808:0808', '2606:4700::6810:84e5']) expect(proxy.isForbiddenDestination(address), address).toBe(false)
  })
})

describe('egress decision (pure)', () => {
  it('allows only CONNECT to port 443 of an allow-listed host, case- and trailing-dot-insensitive', () => {
    expect(proxy.egressDecision('CONNECT chatgpt.com:443 HTTP/1.1', allow)).toMatchObject({ ok: true, host: 'chatgpt.com', port: 443 })
    expect(proxy.egressDecision('CONNECT ChatGPT.com.:443 HTTP/1.1', allow)).toMatchObject({ ok: true, host: 'chatgpt.com' })
    expect(proxy.egressDecision('CONNECT example.com:443 HTTP/1.1', allow)).toMatchObject({ ok: false, reason: 'host is not in the lane egress allow-list' })
    expect(proxy.egressDecision('CONNECT chatgpt.com:80 HTTP/1.1', allow)).toMatchObject({ ok: false, reason: 'only port 443 is allowed' })
    expect(proxy.egressDecision('GET http://chatgpt.com/ HTTP/1.1', allow)).toMatchObject({ ok: false, reason: 'only HTTPS CONNECT is proxied' })
    expect(proxy.egressDecision('CONNECT 1.1.1.1:443 HTTP/1.1', allow)).toMatchObject({ ok: false })
    expect(proxy.egressDecision('CONNECT chatgpt.com.evil.test:443 HTTP/1.1', allow)).toMatchObject({ ok: false })
    expect(proxy.egressDecision('CONNECT evil.test@chatgpt.com:443 HTTP/1.1', allow)).toMatchObject({ ok: false })
  })

  it('refuses loopback, private, link-local, CGNAT and unspecified destinations, and allows a public one', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip']) {
      expect(proxy.isForbiddenDestination(address), address).toBe(true)
    }
    for (const address of ['104.18.32.47', '172.32.0.1', '2606:4700::6810:84e5']) expect(proxy.isForbiddenDestination(address), address).toBe(false)
  })
})

describe('egress proxy server (loopback, injected resolver)', () => {
  async function listen(server: net.Server) {
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as net.AddressInfo).port
  }
  function exchange(port: number, request: string, then?: Buffer) {
    return new Promise<string>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(request))
      let seen = ''
      socket.on('data', (chunk) => {
        seen += chunk.toString()
        if (then && seen.includes('200 Connection Established') && !seen.includes('ECHO')) socket.write(then)
        if (!then || seen.includes('ECHO')) socket.end()
      })
      socket.on('close', () => resolve(seen))
      socket.on('error', () => resolve(seen))
    })
  }

  it('tunnels an allowed host to the resolved public address and refuses the rest, logging hosts only', async () => {
    const received: Buffer[] = []
    const upstream = net.createServer((c) => c.on('data', (d) => { received.push(d); c.write(`ECHO ${d.length}`) }))
    const upstreamPort = await listen(upstream)
    const log: Array<Record<string, unknown>> = []
    const connected: Array<{ host: string, port: number }> = []
    const server = proxy.createEgressProxy({
      allow,
      log: (record: Record<string, unknown>) => log.push(record),
      resolve: (_host: string, _opts: unknown, cb: (e: Error | null, a?: string) => void) => cb(null, '104.18.32.47'),
      // The connector records what the proxy asked for, then reaches the local echo server instead.
      connect: (target: { host: string, port: number }, onConnect: () => void) => { connected.push(target); return net.connect(upstreamPort, '127.0.0.1', onConnect) },
    })
    const port = await listen(server)

    const allowed = await exchange(port, 'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n', helloRecords(clientHello([sniExtension('chatgpt.com')])))
    expect(allowed).toContain('HTTP/1.1 200 Connection Established')
    expect(allowed).toContain('ECHO')
    // The upstream receives the client's TLS bytes unchanged, starting with the handshake record.
    expect(Buffer.concat(received)).toEqual(helloRecords(clientHello([sniExtension('chatgpt.com')])))
    expect(connected).toEqual([{ host: '104.18.32.47', port: 443 }])

    const denied = await exchange(port, 'CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: secret\r\n\r\n')
    expect(denied).toMatch(/^HTTP\/1\.1 403 Forbidden/)
    expect(connected).toHaveLength(1)
    expect(log).toEqual([
      { host: 'chatgpt.com', port: 443, decision: 'allowed', reason: 'allowed' },
      { host: 'example.com', port: 443, decision: 'denied', reason: 'host is not in the lane egress allow-list' },
    ])
    expect(JSON.stringify(log)).not.toContain('secret')
  })

  // Found by the real-bwrap lock: socat half-closes after its stdin ends, and a socket that is not
  // half-open is closed before an ASYNCHRONOUS answer (DNS) can be written back.
  it('still answers a client that half-closes right after its request, once the resolver has answered', async () => {
    const server = proxy.createEgressProxy({ allow, resolve: (_h: string, _o: unknown, cb: (e: Error | null, a?: string) => void) => setTimeout(() => cb(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })), 50) })
    const port = await listen(server)
    const reply = await new Promise<string>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.end('CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n'))
      let seen = ''
      socket.on('data', (chunk) => { seen += chunk.toString() })
      socket.on('close', () => resolve(seen))
    })
    expect(reply).toMatch(/^HTTP\/1\.1 403 Forbidden/)
  })

  it('closes a client that ends before a complete request header (half-open never leaks a socket)', async () => {
    const log: Array<Record<string, unknown>> = []
    const port = await listen(proxy.createEgressProxy({ allow, log: (r: Record<string, unknown>) => log.push(r) }))
    const reply = await new Promise<string>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.end('CONNECT chatgpt.com:443'))
      let seen = ''
      socket.on('data', (chunk) => { seen += chunk.toString() })
      socket.on('close', () => resolve(seen))
    })
    expect(reply).toMatch(/^HTTP\/1\.1 403/)
    expect(log).toEqual([{ host: null, port: null, decision: 'denied', reason: 'request ended before its header' }])
  })

  it('refuses an allowed name that resolves to a loopback address (a host service is never reachable through it)', async () => {
    const log: Array<Record<string, unknown>> = []
    const connected: unknown[] = []
    const server = proxy.createEgressProxy({ allow, log: (r: Record<string, unknown>) => log.push(r), resolve: (_h: string, _o: unknown, cb: (e: Error | null, a?: string) => void) => cb(null, '127.0.0.1'), connect: (t: unknown) => { connected.push(t); return new net.Socket() } })
    const port = await listen(server)
    const reply = await exchange(port, 'CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n')
    expect(reply).toMatch(/^HTTP\/1\.1 403/)
    expect(connected).toEqual([])
    expect(log).toEqual([{ host: 'chatgpt.com', port: 443, decision: 'denied', reason: 'resolves to a forbidden address 127.0.0.1' }])
  })
})

// Round 4, HIGH 1 end to end on loopback: a REAL Node TLS client inside the tunnel. The upstream is a
// plain TCP server that only records what arrives; nothing reaches the internet.
describe('SNI must equal the CONNECT host (real TLS client, round 4 HIGH 1)', () => {
  async function tunnelWithServername(servername: string) {
    const received: Buffer[] = []
    const upstream = net.createServer((c) => { c.on('data', (d) => received.push(d)); c.on('error', () => {}) })
    servers.push(upstream)
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const upstreamPort = (upstream.address() as net.AddressInfo).port
    const log: Array<Record<string, unknown>> = []
    const server = proxy.createEgressProxy({
      allow, log: (r: Record<string, unknown>) => log.push(r),
      resolve: (_h: string, _o: unknown, cb: (e: Error | null, a?: string) => void) => cb(null, '104.18.32.47'),
      connect: (_t: unknown, onConnect: () => void) => net.connect(upstreamPort, '127.0.0.1', onConnect),
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    await new Promise<void>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write('CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n'))
      socket.once('data', () => {
        const client = tls.connect({ socket, servername, rejectUnauthorized: false })
        client.on('error', () => {})
        socket.on('close', () => resolve())
        setTimeout(() => { socket.destroy(); resolve() }, 1500)
      })
      socket.on('error', () => resolve())
    })
    return { received: Buffer.concat(received), log }
  }

  it('a matching SNI reaches the upstream as a TLS handshake', async () => {
    const { received, log } = await tunnelWithServername('chatgpt.com')
    expect(received[0]).toBe(0x16)
    expect(proxy.readClientHello(received)).toMatchObject({ ok: true, sni: 'chatgpt.com' })
    expect(log).toEqual([{ host: 'chatgpt.com', port: 443, decision: 'allowed', reason: 'allowed' }])
  })

  it('a mismatched SNI is refused: the tunnel closes and the upstream receives nothing', async () => {
    const { received, log } = await tunnelWithServername('attacker.workers.dev')
    expect(received.length).toBe(0)
    expect(log).toEqual([{ host: 'chatgpt.com', port: 443, decision: 'denied', reason: 'TLS SNI attacker.workers.dev does not match the CONNECT host' }])
  })
})

describe('egress log hardening (round 4, MED 2)', () => {
  it.skipIf(!constants.O_NOFOLLOW)('accepts a canonical parent reached through a directory alias without following a linked log leaf', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-egress-alias-'))
    try {
      const actual = join(root, 'actual'); mkdirSync(actual)
      const alias = join(root, 'alias'); symlinkSync(actual, alias, 'dir')
      // The launcher passes the canonical path established during validation, even when the
      // operator supplied an alias such as macOS /var -> /private/var.
      const file = join(realpathSync.native(alias), 'egress.jsonl')
      proxy.egressLogWriter(file)({ host: 'alias.example', decision: 'denied' })
      expect(readFileSync(join(actual, 'egress.jsonl'), 'utf8')).toContain('alias.example')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it.skipIf(!constants.O_NOFOLLOW)('refuses to append when a validated log parent is replaced before open', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-egress-before-open-'))
    try {
      const parent = join(root, 'validated'); const redirect = join(root, 'redirect')
      mkdirSync(parent); mkdirSync(redirect)
      const file = join(realpathSync.native(parent), 'egress.jsonl') // launch validation
      renameSync(parent, join(root, 'moved'))
      symlinkSync(redirect, parent, 'dir')
      const target = join(redirect, 'egress.jsonl')
      writeFileSync(target, 'fixture untouched\n') // only a disposable fixture can be reached
      proxy.egressLogWriter(file)({ host: 'blocked.example', decision: 'denied' })
      expect(readFileSync(target, 'utf8')).toBe('fixture untouched\n')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it.skipIf(!constants.O_NOFOLLOW)('keeps writing to its original inode after its parent is swapped', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wt-egress-parent-'))) // canonical, as the launcher passes it
    try {
      const original = join(root, 'original'); const replacement = join(root, 'replacement')
      mkdirSync(original); mkdirSync(replacement)
      const file = join(original, 'egress.jsonl')
      const write = proxy.egressLogWriter(file)
      write({ host: 'one.example', decision: 'denied' })
      renameSync(original, join(root, 'moved'))
      symlinkSync(replacement, original)
      write({ host: 'two.example', decision: 'denied' })
      expect(readFileSync(join(root, 'moved', 'egress.jsonl'), 'utf8')).toContain('two.example')
      expect(existsSync(join(replacement, 'egress.jsonl'))).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  // Runs on every host: the no-follow guarantee holds everywhere (Windows has no O_NOFOLLOW, so the
  // writer writes nothing there rather than following the link).
  it('never follows a symlink planted at the log path', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-egress-log-'))
    try {
      const victim = join(root, 'victim'); writeFileSync(victim, 'original\n')
      const link = join(root, 'egress.jsonl'); symlinkSync(victim, link)
      proxy.egressLogWriter(link)({ host: 'example.com', port: 443, decision: 'denied', reason: 'x' })
      expect(readFileSync(victim, 'utf8')).toBe('original\n')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reduces any non-DNS host to a placeholder (pure, every host)', () => {
    expect(proxy.loggableHost('chatgpt.com')).toBe('chatgpt.com')
    expect(proxy.loggableHost('$(touch /tmp/pwned)`id`<x')).toBe('<non-dns host>')
    expect(proxy.loggableHost(null)).toBe(null)
  })

  it.skipIf(!constants.O_NOFOLLOW)('writes DNS names only and stops at its size cap (skipped where O_NOFOLLOW does not exist, e.g. Windows: the writer writes nothing there)', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wt-egress-log-'))) // canonical, as the launcher passes it
    try {
      const file = join(root, 'real.jsonl')
      const write = proxy.egressLogWriter(file, { limit: 400 })
      write({ host: '$(touch /tmp/pwned)`id`<x', port: 443, decision: 'denied', reason: 'x' })
      write({ host: 'chatgpt.com', port: 443, decision: 'allowed', reason: 'allowed' })
      for (let i = 0; i < 20; i += 1) write({ host: 'example.com', port: 443, decision: 'denied', reason: 'x' })
      const text = readFileSync(file, 'utf8')
      expect(text).not.toContain("$(")
      expect(text).not.toContain("`")
      expect(text).not.toContain("touch")
      expect(text).toContain('"host":"<non-dns host>"')
      expect(text).toContain('"host":"chatgpt.com"')
      expect(text).toContain('"decision":"log-capped"')
      expect(text.length).toBeLessThan(600)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('proxy lifecycle (round 4, LOW 5 and LOW 6)', () => {
  const PROXY = join(LIB, 'lane-egress-proxy.mjs')
  it('treats a reused parent pid (different start time) as dead', () => {
    expect(proxy.parentAlive(123, 500, { kill: () => true, readStart: () => 500 })).toBe(true)
    expect(proxy.parentAlive(123, 500, { kill: () => true, readStart: () => 501 })).toBe(false)
    expect(proxy.parentAlive(123, 500, { kill: () => { throw new Error('ESRCH') }, readStart: () => 500 })).toBe(false)
  })

  // Card 1872293505129252765: a SIGKILLed launcher that its own parent has not reaped yet is a
  // zombie; kill(pid, 0) still succeeds on it, so the watchdog must read the process state too.
  it('treats a zombie parent (state Z) as dead, and an unreadable state as today', () => {
    expect(proxy.parentAlive(123, 500, { kill: () => true, readStart: () => 500, readState: () => 'Z' })).toBe(false)
    expect(proxy.parentAlive(123, 500, { kill: () => true, readStart: () => 500, readState: () => 'S' })).toBe(true)
    expect(proxy.parentAlive(123, 500, { kill: () => true, readStart: () => 500, readState: () => null })).toBe(true)
  })

  it('exits non-zero and says so when it cannot listen', () => {
    const r = spawnSync(process.execPath, [PROXY, '--socket', '/nonexistent-dir-for-egress/p.sock', '--allow', 'chatgpt.com'], { encoding: 'utf8', timeout: 10_000 })
    expect(r.status).toBe(3)
    expect(r.stderr).toContain('lane egress proxy stopped: cannot listen on its socket')
  })

  it('times out a client that never sends its request header', async () => {
    const log: Array<Record<string, unknown>> = []
    const server = proxy.createEgressProxy({ allow, log: (r: Record<string, unknown>) => log.push(r) })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    const reply = await new Promise<string>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write('CONNECT chat'))
      let seen = ''
      socket.on('data', (d) => { seen += d.toString() })
      socket.on('close', () => resolve(seen))
    })
    expect(reply).toMatch(/^HTTP\/1\.1 403/)
    expect(log).toEqual([{ host: null, port: null, decision: 'denied', reason: 'request header timed out' }])
  }, 20_000)

  it('never writes an HTTP answer into the TLS stream when the upstream fails after 200', async () => {
    let upstreamSocket: net.Socket | null = null
    const upstream = net.createServer((c) => { upstreamSocket = c; c.on('error', () => {}) })
    servers.push(upstream)
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const upstreamPort = (upstream.address() as net.AddressInfo).port
    const server = proxy.createEgressProxy({ allow, resolve: (_h: string, _o: unknown, cb: (e: Error | null, a?: string) => void) => cb(null, '104.18.32.47'), connect: (_t: unknown, on: () => void) => net.connect(upstreamPort, '127.0.0.1', on) })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as net.AddressInfo).port
    const seen = await new Promise<string>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write('CONNECT chatgpt.com:443 HTTP/1.1\r\n\r\n'))
      let text = ''
      socket.on('data', (d) => {
        text += d.toString('latin1')
        if (text.includes('200 Connection Established')) setTimeout(() => upstreamSocket?.resetAndDestroy(), 50)
      })
      socket.on('close', () => resolve(text))
      socket.on('error', () => resolve(text))
    })
    expect(seen).toBe('HTTP/1.1 200 Connection Established\r\n\r\n')
  })

  it.skipIf(process.platform !== 'linux')('does not outlive its parent when the parent is SIGKILLed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-egress-parent-'))
    try {
      const sock = join(root, 'p.sock')
      const parentScript = `
        const { spawn } = require('node:child_process'); const fs = require('node:fs')
        const stat = fs.readFileSync('/proc/' + process.pid + '/stat', 'utf8'); const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
        const p = spawn(process.execPath, [${JSON.stringify(PROXY)}, '--socket', ${JSON.stringify(sock)}, '--allow', 'chatgpt.com', '--parent', String(process.pid), '--parent-start', start], { stdio: 'ignore', detached: true })
        p.unref(); console.log(p.pid); setInterval(() => {}, 1000)`
      const parent = spawn(process.execPath, ['-e', parentScript], { stdio: ['ignore', 'pipe', 'ignore'] })
      const proxyPid = await new Promise<number>((resolve) => parent.stdout.once('data', (d) => resolve(Number(String(d).trim()))))
      const deadline = Date.now() + 5000
      while (!existsSync(sock) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      expect(existsSync(sock)).toBe(true)
      parent.kill('SIGKILL')
      const gone = Date.now() + 6000
      let alive = true
      while (alive && Date.now() < gone) {
        try { process.kill(proxyPid, 0); await new Promise((r) => setTimeout(r, 100)) } catch { alive = false }
      }
      if (alive) process.kill(proxyPid, 'SIGKILL')
      expect(alive).toBe(false)
      expect(existsSync(sock)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 20_000)
})

// Card 1872293505129252765 (L2b): a loopback model endpoint is reached through a Node relay of this
// module instead of a host socat, so the relay shares the parent watchdog and dies with its launcher.
// Relay mode is launched only by the Linux lane sandbox plan: sandboxAvailability returns { none }
// on every other platform (plugin/bin/lib/host/lane-sandbox.mjs:491). These tests relay through a
// unix-socket path under tmpdir, which Windows runners do not serve (all three timed out there).
describe.skipIf(process.platform === 'win32')('endpoint relay mode (card 1872293505129252765) [requires unix-domain sockets; relay is Linux-sandbox-only]', () => {
  async function relayFixture(onUpstream: (socket: net.Socket) => void) {
    const root = mkdtempSync(join(tmpdir(), 'wt-endpoint-relay-'))
    const upstream = net.createServer({ allowHalfOpen: true }, onUpstream)
    servers.push(upstream)
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const connections = new Set<net.Socket>()
    const relay = proxy.createEndpointRelay({ host: '127.0.0.1', port: (upstream.address() as net.AddressInfo).port, connections })
    servers.push(relay)
    const sock = join(root, 'ep.sock')
    await new Promise<void>((r) => relay.listen(sock, r))
    return { root, sock, connections }
  }

  it('keeps the reply path open after the client half-closes (the upstream answers 200 ms later)', async () => {
    const { root, sock } = await relayFixture((c) => {
      let seen = ''
      c.on('data', (d) => { seen += String(d) })
      c.on('end', () => setTimeout(() => c.end(`reply:${seen}`), 200))
    })
    try {
      const reply = await new Promise<string>((resolve) => {
        const client = net.connect(sock, () => client.end('ping'))
        let text = ''
        client.on('data', (d) => { text += String(d) })
        client.on('close', () => resolve(text))
        client.on('error', () => resolve(`error:${text}`))
      })
      expect(reply).toBe('reply:ping')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('tracks every live relayed connection, so destroying them closes a held client', async () => {
    let upstreamReady!: () => void
    const upstreamConnected = new Promise<void>((resolve) => { upstreamReady = resolve })
    const { root, sock, connections } = await relayFixture((c) => { c.on('error', () => {}); upstreamReady() })
    try {
      let tracked = -1
      await new Promise<void>((resolve) => {
        const client = net.connect(sock, () => {
          client.write('held')
          void upstreamConnected.then(() => { tracked = connections.size; for (const s of connections) s.destroy() })
        })
        client.on('error', () => {})
        client.on('close', () => resolve())
      })
      expect(tracked).toBe(2)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('closes the client, and forgets both sockets, when the upstream refuses the connection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-endpoint-relay-'))
    const probe = net.createServer(); servers.push(probe)
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const deadPort = (probe.address() as net.AddressInfo).port
    await new Promise<void>((r) => probe.close(() => r()))
    const connections = new Set<net.Socket>()
    const relay = proxy.createEndpointRelay({ host: '127.0.0.1', port: deadPort, connections }); servers.push(relay)
    const sock = join(root, 'ep.sock')
    try {
      await new Promise<void>((r) => relay.listen(sock, r))
      await new Promise<void>((resolve) => {
        const client = net.connect(sock, () => client.write('x'))
        client.on('error', () => {})
        client.on('close', () => resolve())
      })
      await vi.waitFor(() => expect(connections.size).toBe(0), { timeout: 15_000 })
      expect(connections.size).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('refuses --relay together with --allow, and a relay target without a port', () => {
    const PROXY = join(LIB, 'lane-egress-proxy.mjs')
    const both = spawnSync(process.execPath, [PROXY, '--socket', '/nonexistent-dir-for-egress/r.sock', '--relay', '127.0.0.1:1', '--allow', 'chatgpt.com'], { encoding: 'utf8', timeout: 15_000 })
    expect(both.status).toBe(3)
    expect(both.stderr).toContain('--relay and --allow are mutually exclusive')
    const bad = spawnSync(process.execPath, [PROXY, '--socket', '/nonexistent-dir-for-egress/r.sock', '--relay', '127.0.0.1'], { encoding: 'utf8', timeout: 15_000 })
    expect(bad.status).toBe(3)
    expect(bad.stderr).toContain('--relay needs <host>:<port>')
  })
})
