import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

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
  parentAlive: (pid: number, startTicks: number | null, deps?: Record<string, unknown>) => boolean
  processStartTicks: (pid: number) => number | null
}
const proxy = (await import(pathToFileURL(join(LIB, 'lane-egress-proxy.mjs')).href)) as ProxyModule
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
  it('never follows a symlink, logs only DNS names, and stops at its size cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-egress-log-'))
    try {
      const victim = join(root, 'victim'); writeFileSync(victim, 'original\n')
      const link = join(root, 'egress.jsonl'); symlinkSync(victim, link)
      proxy.egressLogWriter(link)({ host: 'example.com', port: 443, decision: 'denied', reason: 'x' })
      expect(readFileSync(victim, 'utf8')).toBe('original\n')

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
