import net from 'node:net'
import { join } from 'node:path'
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
}
const proxy = (await import(pathToFileURL(join(LIB, 'lane-egress-proxy.mjs')).href)) as ProxyModule
const servers: net.Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

const allow = new Set(['chatgpt.com', 'auth.openai.com'])

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
  function exchange(port: number, request: string, then?: string) {
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
    const upstream = net.createServer((c) => c.on('data', (d) => c.write(`ECHO ${d.toString()}`)))
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

    const allowed = await exchange(port, 'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n', 'hello')
    expect(allowed).toContain('HTTP/1.1 200 Connection Established')
    expect(allowed).toContain('ECHO hello')
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
