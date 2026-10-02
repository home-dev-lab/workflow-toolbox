import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { acquireSuiteLock, releaseSuiteLock } from '../../../../plugin/bin/lib/suite-lock.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createSuiteLockBroker, DEFAULT_LANE_SUITE_LOCK_MAX_HOLD_S, DEFAULT_LANE_SUITE_LOCK_STOP_GRACE_S, laneSuiteLockMaxHoldSeconds } from '../../../../plugin/bin/lib/host/lane-suite-lock-broker.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const BROKER = join(ROOT, 'plugin/bin/lib/host/lane-suite-lock-broker.mjs')
const CLI = join(ROOT, 'plugin/bin/wt-suite-lock.mjs')
const GLOBAL_SETUP = join(ROOT, 'toolkit/test-support/suite-lease.global-setup.mjs')
const roots: string[] = []
const children: Array<ReturnType<typeof spawn>> = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// A child's exit, or a named failure once the wall-clock bound passes.
function exitWithin(child: ReturnType<typeof spawn>, timeoutMs: number) {
  return new Promise<number | null>((resolve, reject) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return }
    const timer = setTimeout(() => reject(new Error(`process ${child.pid} still running after ${timeoutMs}ms`)), timeoutMs)
    child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
}

function processGone(pid: number) {
  try { process.kill(pid, 0); return false } catch { return true }
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for fixture state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function startBroker(parent = process.pid, env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lock-broker-')); roots.push(root)
  const socket = join(root, 'broker.sock')
  const child = spawn(process.execPath, [BROKER, '--socket', socket, '--parent', String(parent), '--label', 'test-lane'], { env: sealedPluginCliEnv(root, { WT_SUITE_LOCK_DIR: join(root, 'locks'), WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', ...env }), stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  await waitFor(() => existsSync(`${socket}.ready`))
  return { root, socket, child, lock: join(root, 'locks', 'lock.d', 'holder.json') }
}

function connect(socketPath: string, request?: unknown, allowHalfOpen = false) {
  const socket = net.connect({ path: socketPath, allowHalfOpen })
  let text = ''
  socket.on('data', (chunk) => { text += String(chunk) })
  if (request !== undefined) socket.write(`${typeof request === 'string' ? request : JSON.stringify(request)}\n`)
  // Patience above the census short-deadline bound; tests that use it run on a 20 s timeout so this wait, not the test, reports.
  const waitForReply = (predicate: (received: string) => boolean, timeoutMs = 15_000) => new Promise<string>((resolve, reject) => {
    const deadline = AbortSignal.timeout(timeoutMs)
    const cleanup = () => {
      socket.off('data', check)
      socket.off('close', closed)
      socket.off('error', failed)
      deadline.removeEventListener('abort', timedOut)
    }
    const fail = (reason: string) => { cleanup(); reject(new Error(`broker reply ${reason}; received ${JSON.stringify(text)}`)) }
    const check = () => { if (predicate(text)) { cleanup(); resolve(text) } }
    const closed = () => fail('socket closed before expected text')
    const failed = (cause: Error) => fail(`socket error: ${String(cause)}`)
    const timedOut = () => fail(`timed out after ${timeoutMs}ms before expected text`)
    socket.on('data', check)
    socket.once('close', closed)
    socket.once('error', failed)
    deadline.addEventListener('abort', timedOut, { once: true })
    check() // The reply may have arrived before this wait began.
    if (socket.destroyed && !predicate(text)) closed()
  })
  return { socket, text: () => text, waitForReply }
}

const granted = (text: string) => /(?:^|\n)granted [^\n]+\n/.test(text)
const errorReply = (text: string) => /^error [^\n]*\n/.test(text)

async function localBroker(options: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lock-local-broker-')); roots.push(root)
  const address = join(root, 'broker.sock')
  const previous = process.env.WT_SUITE_LOCK_DIR
  const previousBroker = process.env.WT_SUITE_LOCK_BROKER
  const previousLease = process.env.WT_SUITE_LEASE
  process.env.WT_SUITE_LOCK_DIR = join(root, 'locks')
  process.env.WT_SUITE_LOCK_BROKER = ''
  delete process.env.WT_SUITE_LEASE
  const server = createSuiteLockBroker(options) as net.Server
  await new Promise<void>((resolve) => server.listen(address, resolve))
  return { address, server, restore: () => {
    if (previous === undefined) delete process.env.WT_SUITE_LOCK_DIR; else process.env.WT_SUITE_LOCK_DIR = previous
    if (previousBroker === undefined) delete process.env.WT_SUITE_LOCK_BROKER; else process.env.WT_SUITE_LOCK_BROKER = previousBroker
    if (previousLease === undefined) delete process.env.WT_SUITE_LEASE; else process.env.WT_SUITE_LEASE = previousLease
  } }
}

async function connectionCount(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)))
}

async function waitForConnections(server: net.Server, count: number, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (await connectionCount(server) !== count) {
    if (Date.now() >= deadline) throw new Error(`expected ${count} broker connections; still ${await connectionCount(server)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// The broker runs only inside the Linux lane sandbox: sandboxAvailability returns { none } on every
// other platform (plugin/bin/lib/host/lane-sandbox.mjs:491), and only that plan sets
// WT_SUITE_LOCK_BROKER (lane-sandbox.mjs:477), the one switch that routes a client to a broker
// (plugin/bin/lib/suite-lock.mjs:319). These tests listen on a unix-socket path under tmpdir, which
// Windows runners do not serve (every test timed out there), so they run on POSIX hosts only.
describe.skipIf(process.platform === 'win32')('lane suite-lock broker [requires unix-domain sockets; broker is Linux-sandbox-only]', () => {
  it('reuses the one exclusive lease across project setups through the current broker', async () => {
    const broker = await startBroker()
    const script = `import setup from ${JSON.stringify(new URL(`file://${GLOBAL_SETUP}`).href)};const teardown=await setup();if(await setup()!==undefined)throw Error('nested setup acquired again');teardown();process.stdout.write('teardown done\\n');process.stdin.once('data',()=>{})`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: sealedPluginCliEnv(broker.root, { WT_SUITE_LOCK_BROKER: broker.socket, WT_SUITE_LEASE: '' }), stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child)
    let stdout = ''; child.stdout!.on('data', (data) => { stdout += String(data) })
    await waitFor(() => stdout.includes('teardown done'))
    expect(readFileSync(broker.lock, 'utf8')).toContain('vitest')
    const competitor = spawnSync(process.execPath, [CLI, 'run', '--wait-s', '0.15', '--', process.execPath, '-e', ''], { env: sealedPluginCliEnv(broker.root, { WT_SUITE_LOCK_DIR: join(broker.root, 'locks'), WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '' }), encoding: 'utf8', timeout: 2000 })
    expect(competitor.status, competitor.stderr).toBe(75)
    expect(child.exitCode).toBeNull()
    child.stdin!.end('exit')
    expect(await new Promise<number | null>((resolve) => child.once('exit', resolve))).toBe(0)
    await waitFor(() => !existsSync(broker.lock))
  })

  it('stops direct Vitest setup with a named reason when its broker lease disappears', async () => {
    const broker = await startBroker()
    const script = `import setup from ${JSON.stringify(new URL(`file://${GLOBAL_SETUP}`).href)};await setup();process.stdout.write('ready\\n');setInterval(()=>{},1000)`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: sealedPluginCliEnv(broker.root, { WT_SUITE_LOCK_BROKER: broker.socket, WT_SUITE_LEASE: '' }), stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
    let stdout = ''; let stderr = ''
    child.stdout!.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
    await waitFor(() => stdout.includes('ready\n'))
    broker.child.kill('SIGKILL')
    const exit = await new Promise<string | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)))
    expect(exit).toBe('SIGTERM')
    expect(stderr).toContain('vitest: suite lease lost (broker gone); stopping run')
  }, 15_000)

  it('does not signal ready on socket publication before the listen callback', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-broker-ready-order-')); roots.push(root)
    const socket = join(root, 'broker.sock')
    const helper = join(ROOT, 'plugin/bin/lib/host/lane-helper-process.mjs')
    // Fake listen deliberately publishes the socket first, then withholds its callback. The
    // independent observer checks the marker on both sides of that controlled boundary.
    const script = `import {EventEmitter} from 'node:events';import {writeFileSync,existsSync} from 'node:fs';import {runLaneHelper} from ${JSON.stringify(new URL(`file://${helper}`).href)};const sock=${JSON.stringify(socket)};const server=new EventEmitter();let accept;server.listen=(_path,cb)=>{writeFileSync(sock,'inode');accept=cb};runLaneHelper({server,options:{socket:sock},name:'test'});if(existsSync(sock+'.ready'))throw Error('ready before accepting');accept();if(!existsSync(sock+'.ready'))throw Error('no ready after accepting')`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  })

  it('publishes readiness after listen and serialises every client', async () => {
    const broker = await startBroker()
    expect(existsSync(`${broker.socket}.ready`)).toBe(true)
    const first = connect(broker.socket, { argv: ['vitest'], waitS: 3 })
    await first.waitForReply(granted)
    const second = connect(broker.socket, { argv: ['typecheck'], waitS: 3 })
    await second.waitForReply((text) => text.includes('wait waiting for suite lock:'))
    expect(second.text()).not.toContain('granted ')
    first.socket.end()
    await second.waitForReply(granted)
    second.socket.end()
  })

  it('answers idle status without ever creating a holder or ticket', async () => {
    const broker = await startBroker()
    const lockRoot = join(broker.root, 'locks')
    mkdirSync(lockRoot, { recursive: true })
    let acquired = false
    const observer = watch(lockRoot, (_event, name) => { if (String(name) === 'lock.d' || String(name) === 'queue.d') acquired = true })
    try {
      const result = await new Promise<{ status: number | null, stdout: string, stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [CLI, 'status'], { env: sealedPluginCliEnv(broker.root, { WT_SUITE_LOCK_DIR: lockRoot, WT_SUITE_LOCK_BROKER: broker.socket, WT_SUITE_LEASE: '' }), stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
        let stdout = ''; let stderr = ''
        child.stdout!.on('data', (data) => { stdout += String(data) })
        child.stderr!.on('data', (data) => { stderr += String(data) })
        child.once('exit', (status) => resolve({ status, stdout, stderr }))
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('suite lock free')
      expect(acquired, 'status created a lock holder even momentarily').toBe(false)
      expect(existsSync(broker.lock)).toBe(false)
    } finally { observer.close() }
  }, 5000)

  // The first text is what installed 0.189.x brokers actually send (lane-suite-lock-broker.mjs requestFrom).
  it.each(['error argv must be an array of strings', 'error argv must be an array of strings (only argv and waitS accepted)'])('names older broker status unavailable without sending an acquisition request (%s)', async (rejection) => {
    const root = mkdtempSync(join(tmpdir(), 'wt-lock-old-status-')); roots.push(root)
    const address = join(root, 'broker.sock')
    let acquisitionRequested = false
    const server = net.createServer((socket) => socket.once('data', (data) => {
      const request = JSON.parse(String(data))
      if ('argv' in request || 'waitS' in request) acquisitionRequested = true
      socket.end(`${rejection}\n`)
    }))
    await new Promise<void>((resolve) => server.listen(address, resolve))
    try {
      const result = await new Promise<{ status: number | null, stdout: string }>((resolve) => {
        const child = spawn(process.execPath, [CLI, 'status', '--json'], { env: sealedPluginCliEnv(root, { WT_SUITE_LOCK_DIR: join(root, 'locks'), WT_SUITE_LOCK_BROKER: address, WT_SUITE_LEASE: '' }), stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
        let stdout = ''
        child.stdout!.on('data', (data) => { stdout += String(data) })
        child.once('exit', (status) => resolve({ status, stdout }))
      })
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ held: null, status: 'status unavailable (older broker)' })
      expect(acquisitionRequested).toBe(false)
    } finally { server.close() }
  }, 5000)

  it('refuses with exit 75 naming the holder when a saturated broker answers busy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-lock-busy-')); roots.push(root)
    const address = join(root, 'broker.sock')
    const server = net.createServer((socket) => socket.once('data', () => socket.end('error busy: holder pid 4242 (pnpm certify) since 19:00; requested command ["pnpm","lint"]; inspect with wt-suite-lock status\n')))
    await new Promise<void>((resolve) => server.listen(address, resolve))
    try {
      const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [CLI, 'run', '--', process.execPath, '-e', 'process.stdout.write("ran")'], { env: sealedPluginCliEnv(root, { WT_SUITE_LOCK_DIR: join(root, 'locks'), WT_SUITE_LOCK_BROKER: address, WT_SUITE_LEASE: '' }), stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
        let stderr = ''
        child.stderr!.on('data', (data) => { stderr += String(data) })
        child.once('exit', (status) => resolve({ status, stderr }))
      })
      expect(result.status, result.stderr).toBe(75)
      expect(result.stderr).toContain('holder pid 4242')
    } finally { server.close() }
  }, 5000)

  it('reports the actual broker status error instead of misidentifying a current broker as older', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-lock-status-error-')); roots.push(root)
    const address = join(root, 'broker.sock')
    const server = net.createServer((socket) => socket.once('data', () => socket.end('error request timed out\n')))
    await new Promise<void>((resolve) => server.listen(address, resolve))
    try {
      const result = await new Promise<{ status: number | null; stderr: string; stdout: string }>((resolve) => {
        const child = spawn(process.execPath, [CLI, 'status'], { env: sealedPluginCliEnv(root, { WT_SUITE_LOCK_DIR: join(root, 'locks'), WT_SUITE_LOCK_BROKER: address, WT_SUITE_LEASE: '' }), stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child)
        let stdout = ''; let stderr = ''
        child.stdout!.on('data', (data) => { stdout += String(data) })
        child.stderr!.on('data', (data) => { stderr += String(data) })
        child.once('exit', (status) => resolve({ status, stdout, stderr }))
      })
      expect(result.stdout).not.toContain('older broker')
      expect(result.stderr).toContain('request timed out')
      expect(result.status).toBe(2)
    } finally { server.close() }
  }, 5000)

  it('does not open a broker connection for an already-aborted acquisition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-lock-preabort-')); roots.push(root)
    const address = join(root, 'broker.sock')
    let connections = 0
    const server = net.createServer((socket) => { connections += 1; socket.destroy() })
    const connectSpy = vi.spyOn(net, 'connect')
    try {
      await new Promise<void>((resolve) => server.listen(address, resolve))
      const controller = new AbortController(); controller.abort()
      await expect(acquireSuiteLock({ env: { WT_SUITE_LOCK_BROKER: address }, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORT_ERR' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(connectSpy).not.toHaveBeenCalledWith(address)
      expect(connections).toBe(0)
    } finally { connectSpy.mockRestore(); server.close() }
  })

  it('closes a rejected broker acquisition even if a grant follows an abort in the same packet', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-lock-late-grant-')); roots.push(root)
    const address = join(root, 'broker.sock')
    let peer: net.Socket | undefined
    const server = net.createServer((socket) => {
      peer = socket
      socket.once('data', () => socket.write('wait queued\ngranted late-lease\n'))
    })
    const controller = new AbortController()
    try {
      await new Promise<void>((resolve) => server.listen(address, resolve))
      await expect(acquireSuiteLock({ env: { WT_SUITE_LOCK_BROKER: address }, signal: controller.signal, onWait: () => controller.abort(), waitS: 2 })).rejects.toMatchObject({ code: 'ABORT_ERR' })
      await waitFor(() => peer?.destroyed === true)
      expect(peer?.destroyed).toBe(true)
    } finally { peer?.destroy(); server.close() }
  })

  it('closes a rejected broker acquisition after an error line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-lock-error-line-')); roots.push(root)
    const address = join(root, 'broker.sock')
    let peer: net.Socket | undefined
    const server = net.createServer((socket) => {
      peer = socket
      socket.once('data', () => socket.write('error refused\n'))
    })
    try {
      await new Promise<void>((resolve) => server.listen(address, resolve))
      await expect(acquireSuiteLock({ env: { WT_SUITE_LOCK_BROKER: address }, waitS: 2 })).rejects.toThrow('refused')
      await waitFor(() => peer?.destroyed === true)
      expect(peer?.destroyed).toBe(true)
    } finally { peer?.destroy(); server.close() }
  })

  // The broker releases the lock when this socket closes, so after a post-grant error line (its hold
  // bound) the client reports the loss with the broker's reason and keeps the socket open; the holder
  // closes it through releaseSuiteLock once its command tree has stopped.
  it('reports lease loss with the broker\'s reason on an error line after a grant, and keeps the socket open until released', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-lock-revoked-')); roots.push(root)
    const address = join(root, 'broker.sock')
    let peer: net.Socket | undefined
    let peerEnded = false
    const server = net.createServer((socket) => {
      peer = socket
      socket.once('end', () => { peerEnded = true })
      socket.once('data', () => socket.write('granted lease-1\nerror revoked\n'))
    })
    try {
      await new Promise<void>((resolve) => server.listen(address, resolve))
      const lease = await acquireSuiteLock({ env: { WT_SUITE_LOCK_BROKER: address }, waitS: 2 })
      expect(await lease.lost).toBe('revoked')
      expect(lease.socket.destroyed).toBe(false)
      expect(peerEnded).toBe(false)
      releaseSuiteLock(lease)
      await waitFor(() => peerEnded, 15_000)
    } finally { peer?.destroy(); server.close() }
  })

  it('closes half-open invalid requests and recovers admission slots', async () => {
    const { address, server, restore } = await localBroker()
    const rejected = Array.from({ length: 16 }, () => connect(address, '{bad', true))
    try {
      await Promise.all(rejected.map((client) => client.waitForReply(errorReply)))
      await waitForConnections(server, 0, 1800)
      expect(await connectionCount(server)).toBe(0)
      const next = connect(address, { argv: ['next'], waitS: 1 })
      expect(await next.waitForReply(granted)).toContain('granted ')
      next.socket.end()
    } finally { for (const client of rejected) client.socket.destroy(); server.close(); restore() }
  }, 20_000)

  it('admits a client after destroying a rejected socket before its close callback', async () => {
    const { address, server, restore } = await localBroker()
    const heldCloses: Array<() => void> = []
    let accepted = 0
    let next: ReturnType<typeof connect> | undefined
    let startNext!: (client: ReturnType<typeof connect>) => void
    const nextStarted = new Promise<ReturnType<typeof connect>>((resolve, reject) => {
      AbortSignal.timeout(15_000).addEventListener('abort', () => {
        reject(new Error(`next client received ${JSON.stringify(next?.text() ?? '')} before the broker destroyed a rejection`))
      }, { once: true })
      startNext = resolve
    })
    server.on('connection', (socket) => {
      if (++accepted === 17) {
        // The broker's admission callback runs first; only then deliver the deferred close events.
        for (const close of heldCloses.splice(0)) close()
        return
      }
      const emit = socket.emit.bind(socket)
      socket.emit = ((event: string | symbol, ...args: unknown[]) => {
        if (event === 'close') { heldCloses.push(() => { emit(event, ...args) }); return true }
        return emit(event, ...args)
      }) as typeof socket.emit
      const destroy = socket.destroy.bind(socket)
      socket.destroy = ((...args: Parameters<net.Socket['destroy']>) => {
        const result = destroy(...args)
        if (!next) { next = connect(address, { argv: ['next'], waitS: 1 }); startNext(next) }
        return result
      }) as typeof socket.destroy
    })
    const rejected = Array.from({ length: 16 }, () => connect(address, '{bad', true))
    try {
      await Promise.all(rejected.map(async (client) => {
        await client.waitForReply(errorReply)
        expect(client.text()).toMatch(/^error [^\n]*\n/)
      }))
      const client = await nextStarted
      expect(await client.waitForReply(granted)).toContain('granted ')
    } finally {
      for (const close of heldCloses.splice(0)) close()
      next?.socket.destroy()
      for (const client of rejected) client.socket.destroy()
      server.close(); restore()
    }
  }, 20_000)

  it('frees the admission slot when it answers a rejection, while the rejected client is still open', async () => {
    // Rejection linger timers are frozen, so the broker keeps all 16 rejected sockets open; only the
    // accounting done at rejection time can let the next client in.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { address, server, restore } = await localBroker()
    const rejected = Array.from({ length: 16 }, () => connect(address, '{bad', true))
    let next: ReturnType<typeof connect> | undefined
    try {
      await Promise.all(rejected.map((client) => client.waitForReply(errorReply)))
      next = connect(address, { argv: ['next'], waitS: 1 })
      const reply = await next.waitForReply((text) => granted(text) || errorReply(text))
      expect(await connectionCount(server)).toBe(17)
      expect(reply).toMatch(/^granted /)
    } finally { vi.useRealTimers(); next?.socket.destroy(); for (const client of rejected) client.socket.destroy(); server.close(); restore() }
  }, 20_000)

  it('bounds open sockets, rejected ones included, by dropping connections past the bound', async () => {
    // Rejection linger timers are frozen, so every rejected half-open socket stays open for the whole test.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { address, server, restore } = await localBroker()
    let dropped = 0
    server.on('drop', () => { dropped += 1 })
    const clients = Array.from({ length: 40 }, () => connect(address, '{bad', true))
    for (const client of clients) client.socket.on('error', () => {})
    const settled = () => clients.every((client) => client.socket.destroyed || client.socket.readableEnded)
    try {
      const deadline = Date.now() + 15_000
      while (!settled() && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve))
      expect(settled(), JSON.stringify(clients.map((client) => client.text()))).toBe(true)
      expect(await connectionCount(server)).toBe(32)
      expect(dropped).toBe(8)
      expect(clients.filter((client) => errorReply(client.text()))).toHaveLength(32)
    } finally { vi.useRealTimers(); for (const client of clients) client.socket.destroy(); server.close(); restore() }
  }, 20_000)

  it('closes half-open busy requests within a bound', async () => {
    const { address, server, restore } = await localBroker()
    const held = Array.from({ length: 16 }, (_, index) => connect(address, { argv: ['held', String(index)], waitS: 10 }))
    await Promise.all(held.map((client) => client.waitForReply((text) => granted(text) || text.includes('wait '))))
    await waitForConnections(server, held.length)
    const rejected = connect(address, { argv: ['overflow'], waitS: 1 }, true)
    try {
      await rejected.waitForReply((text) => /^error busy: holder pid .*wt-suite-lock status\n/.test(text))
      await waitForConnections(server, held.length, 1800)
      expect(await connectionCount(server)).toBe(16)
      for (const client of held) client.socket.destroy()
      await waitForConnections(server, 0)
      const next = connect(address, { argv: ['next'], waitS: 1 })
      await next.waitForReply(granted)
      next.socket.end()
    } finally { rejected.socket.destroy(); for (const client of held) client.socket.destroy(); server.close(); restore() }
  }, 20_000)

  it('never starts an acquisition from data sent after request timeout', async () => {
    const { address, server, restore } = await localBroker()
    const root = join(dirname(address), 'locks')
    const blocker = await acquireSuiteLock({ root, env: {} })
    const client = connect(address, undefined, true)
    const queue = join(root, 'queue.d')
    // Every acquisition allocates a numbered <n>.ticket marker that outlives its wait
    // (plugin/bin/lib/host/suite-lock-queue.mjs:5-8), so a late acquisition leaves a NEW number
    // behind even if it is aborted at once. The watcher only counts numbers the blocker did not
    // allocate: on macOS, fs.watch can deliver the blocker's own ticket removal, which happened
    // before the watch started, after it (seen on the macos-latest runner).
    const ticketNumbers = () => new Set(readdirSync(queue).flatMap((name) => /^(\d+)\.ticket$/.exec(name)?.[1] ?? []).map(Number))
    const before = ticketNumbers()
    let startedLateAcquisition = false
    const watcher = watch(queue, (_event, filename) => {
      const number = /^(\d+)\.(json|ticket)$/.exec(String(filename))?.[1]
      if (number !== undefined && !before.has(Number(number))) startedLateAcquisition = true
    })
    try {
      await client.waitForReply((text) => /^error request timed out\n/.test(text))
      client.socket.write(`${JSON.stringify({ argv: ['late'], waitS: 1 })}\n`)
      let closed = false
      const deadline = Date.now() + 1800
      while (!closed && Date.now() < deadline) {
        closed = (await connectionCount(server)) === 0
        if (!closed) await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await new Promise((resolve) => setImmediate(resolve))
      expect(startedLateAcquisition).toBe(false)
      expect([...ticketNumbers()].filter((number) => !before.has(number))).toEqual([])
      expect(closed).toBe(true)
      expect(client.text()).not.toContain('granted ')
    } finally { watcher.close(); client.socket.destroy(); releaseSuiteLock(blocker); server.close(); restore() }
  }, 20_000)

  it('holds as the broker, serialises clients, and releases on client end', async () => {
    const broker = await startBroker()
    const first = connect(broker.socket, { argv: ['pnpm', 'test'], waitS: 2 })
    await first.waitForReply(granted)
    const holder = JSON.parse(readFileSync(broker.lock, 'utf8'))
    expect(holder.pid).toBe(broker.child.pid)
    expect(holder.argv.slice(0, 2)).toEqual(['wt-lane-sandbox', 'test-lane'])
    const second = connect(broker.socket, { argv: ['pnpm', 'lint'], waitS: 2 })
    await second.waitForReply((text) => /(?:^|\n)wait [^\n]*\n/.test(text))
    expect(second.text()).not.toContain('granted ')
    first.socket.end()
    await second.waitForReply(granted)
    second.socket.end()
    await waitFor(() => !existsSync(broker.lock))
  })

  it('releases after a connected client is SIGKILLed and permits a synchronous client', async () => {
    const broker = await startBroker()
    const script = `const net=require('net');const s=net.connect(process.env.S);s.write(JSON.stringify({argv:['child'],waitS:2})+'\\n');s.on('data',d=>{if(String(d).startsWith('granted '))setInterval(()=>{},1000)})`
    const holder = spawn(process.execPath, ['-e', script], { env: sealedPluginCliEnv(broker.root, { S: broker.socket }) }); children.push(holder)
    await waitFor(() => existsSync(broker.lock))
    holder.kill('SIGKILL')
    await waitFor(() => !existsSync(broker.lock))
    const result = spawnSync(process.execPath, [CLI, 'run', '--', process.execPath, '-e', 'process.stdout.write("sync")'], { encoding: 'utf8', env: sealedPluginCliEnv(broker.root, { WT_SUITE_LOCK_BROKER: broker.socket }) })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('sync')
  })

  it('releases the lock it holds when its parent dies, and the granted client sees the lease lost', async () => {
    const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); children.push(parent)
    const broker = await startBroker(parent.pid)
    const client = connect(broker.socket, { argv: ['pnpm', 'test'], waitS: 2 })
    await client.waitForReply(granted)
    let closed = false
    client.socket.on('close', () => { closed = true })
    parent.kill('SIGKILL')
    await waitFor(() => !existsSync(broker.lock) && closed)
  })

  it('bounds a lane hold: past WT_LANE_SUITE_LOCK_MAX_HOLD_S the lease is released, the hung command stops with exit 75 naming the bound, and the next waiter acquires', async () => {
    const broker = await startBroker(process.pid, { WT_LANE_SUITE_LOCK_MAX_HOLD_S: '1' })
    let brokerStderr = ''; broker.child.stderr!.on('data', (chunk) => { brokerStderr += String(chunk) })
    const marker = join(broker.root, 'hung-pid')
    // Stands in for a `pnpm install` that can never finish: it never exits on its own.
    const hung = `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(()=>{},1000)`
    const laneEnv = sealedPluginCliEnv(broker.root, { WT_SUITE_LOCK_BROKER: broker.socket, WT_SUITE_LEASE: '' })
    const run = spawn(process.execPath, [CLI, 'run', '--', process.execPath, '-e', hung], { env: laneEnv, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(run)
    let stderr = ''; run.stderr!.on('data', (chunk) => { stderr += String(chunk) })
    await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8') !== '', 20_000)
    const hungPid = Number(readFileSync(marker, 'utf8'))
    const next = spawn(process.execPath, [CLI, 'run', '--wait-s', '15', '--', process.execPath, '-e', 'process.stdout.write("next")'], { env: laneEnv, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(next)
    let nextStdout = ''; next.stdout!.on('data', (chunk) => { nextStdout += String(chunk) })
    expect(await exitWithin(run, 10_000)).toBe(75)
    expect(stderr).toMatch(/wt-suite-lock: suite lock lost \(hold bound: lane lease expired after 1 s \(WT_LANE_SUITE_LOCK_MAX_HOLD_S\); command \[[^\n]*\] must stop[^\n]*\); command stopped/)
    expect(brokerStderr).toContain('hold bound: lane lease expired after 1 s')
    expect(brokerStderr).toContain('released after its client closed')
    await waitFor(() => processGone(hungPid), 20_000)
    expect(await exitWithin(next, 10_000)).toBe(0)
    expect(nextStdout).toBe('next')
    await waitFor(() => !existsSync(broker.lock), 15_000)
  }, 30_000)

  // A wrapper (the shape of `bash -c 'cd toolkit && pnpm test'`) whose grandchild appends a timestamp every
  // 100 ms. After the hold bound, the next suite on the same lock root must start only once that
  // grandchild has stopped writing: the lease is released after the whole tree is gone, never before.
  async function overlapAfterHoldBound(grandchildIgnoresTerm: boolean) {
    const broker = await startBroker(process.pid, { WT_LANE_SUITE_LOCK_MAX_HOLD_S: '1' })
    const ticks = join(broker.root, 'ticks')
    const pidFile = join(broker.root, 'grandchild-pid')
    const started = join(broker.root, 'waiter-start')
    const grandchild = `const f=require('fs');${grandchildIgnoresTerm ? "process.on('SIGTERM',()=>{});" : ''}f.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>f.appendFileSync(${JSON.stringify(ticks)},Date.now()+'\\n'),100)`
    const wrapper = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`
    const run = spawn(process.execPath, [CLI, 'run', '--', process.execPath, '-e', wrapper], { env: sealedPluginCliEnv(broker.root, { WT_SUITE_LOCK_BROKER: broker.socket, WT_SUITE_LEASE: '' }), stdio: ['ignore', 'pipe', 'pipe'] }); children.push(run)
    let stderr = ''; run.stderr!.on('data', (chunk) => { stderr += String(chunk) })
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 20_000)
    const grandchildPid = Number(readFileSync(pidFile, 'utf8'))
    try {
      // The next suite waits on the lock root directly, as a host session would.
      const waiter = spawn(process.execPath, [CLI, 'run', '--wait-s', '25', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(started)},String(Date.now()))`], { env: sealedPluginCliEnv(broker.root, { WT_SUITE_LOCK_DIR: join(broker.root, 'locks'), WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '' }), stdio: ['ignore', 'pipe', 'pipe'] }); children.push(waiter)
      let waiterStderr = ''; waiter.stderr!.on('data', (chunk) => { waiterStderr += String(chunk) })
      expect(await exitWithin(waiter, 25_000), waiterStderr).toBe(0)
      const waiterStart = Number(readFileSync(started, 'utf8'))
      // Five tick periods: a grandchild still alive has written after waiterStart by now.
      await new Promise((resolve) => setTimeout(resolve, 500))
      const lastTick = Math.max(...readFileSync(ticks, 'utf8').trim().split('\n').map(Number))
      expect(lastTick, `grandchild still wrote ${lastTick - waiterStart} ms after the next suite started`).toBeLessThan(waiterStart)
      expect(processGone(grandchildPid)).toBe(true)
      expect(await exitWithin(run, 10_000)).toBe(75)
      expect(stderr).toContain('suite lock lost (hold bound:')
    } finally {
      if (!processGone(grandchildPid)) process.kill(grandchildPid, 'SIGKILL')
    }
  }

  it('after a hold bound, the next suite starts only once the lane command\'s whole tree has stopped (wrapper + grandchild)', async () => {
    await overlapAfterHoldBound(false)
  }, 45_000)

  it('after a hold bound, a grandchild that ignores SIGTERM is killed with its group even though the wrapper exits first', async () => {
    await overlapAfterHoldBound(true)
  }, 45_000)

  it('a client that takes the grant and never closes keeps the lock through the stop grace, and loses it right after', async () => {
    expect(DEFAULT_LANE_SUITE_LOCK_STOP_GRACE_S).toBe(30)
    expect(() => createSuiteLockBroker({ stopGraceS: 0 })).toThrow(/stopGraceS/)
    const { address, server, restore } = await localBroker({ maxHoldS: 0.3, stopGraceS: 1.5 })
    const lock = join(process.env.WT_SUITE_LOCK_DIR!, 'lock.d', 'holder.json')
    try {
      // Suspended or wedged client: it reads nothing back and never closes.
      const client = connect(address, { argv: ['pnpm', 'install'], waitS: 2 })
      await client.waitForReply(granted)
      await client.waitForReply((text) => text.includes('error hold bound:'), 15_000)
      const boundAt = Date.now()
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(existsSync(lock), 'lock released before the stop grace while the client may still run').toBe(true)
      await waitFor(() => !existsSync(lock), 4_000)
      const releasedAfter = Date.now() - boundAt
      expect(releasedAfter).toBeGreaterThanOrEqual(1_000)
      await waitFor(() => client.socket.destroyed, 15_000)
    } finally {
      server.close(); restore()
    }
  }, 20_000)

  it('reads the hold bound from WT_LANE_SUITE_LOCK_MAX_HOLD_S and refuses an invalid one', () => {
    expect(DEFAULT_LANE_SUITE_LOCK_MAX_HOLD_S).toBe(2700)
    expect(laneSuiteLockMaxHoldSeconds({})).toBe(2700)
    expect(laneSuiteLockMaxHoldSeconds({ WT_LANE_SUITE_LOCK_MAX_HOLD_S: '' })).toBe(2700)
    expect(laneSuiteLockMaxHoldSeconds({ WT_LANE_SUITE_LOCK_MAX_HOLD_S: '90' })).toBe(90)
    expect(laneSuiteLockMaxHoldSeconds({ WT_LANE_SUITE_LOCK_MAX_HOLD_S: '0.5' })).toBe(0.5)
    for (const bad of ['0', '-3', 'abc', 'Infinity', 'NaN', '12s', '3000000']) {
      expect(() => laneSuiteLockMaxHoldSeconds({ WT_LANE_SUITE_LOCK_MAX_HOLD_S: bad }), bad).toThrow(/WT_LANE_SUITE_LOCK_MAX_HOLD_S must be a finite number of seconds above 0/)
    }
    expect(() => createSuiteLockBroker({ maxHoldS: 0 })).toThrow(/maxHoldS/)
  })

  it('refuses to start, naming the variable, when WT_LANE_SUITE_LOCK_MAX_HOLD_S is invalid', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-lock-broker-bad-')); roots.push(root)
    const socket = join(root, 'broker.sock')
    const result = spawnSync(process.execPath, [BROKER, '--socket', socket, '--parent', String(process.pid)], { env: sealedPluginCliEnv(root, { WT_SUITE_LOCK_DIR: join(root, 'locks'), WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '', WT_LANE_SUITE_LOCK_MAX_HOLD_S: 'forever' }), encoding: 'utf8', timeout: 20_000 })
    expect(result.status, result.stderr).not.toBe(0)
    expect(result.status).not.toBeNull()
    expect(result.stderr).toContain('WT_LANE_SUITE_LOCK_MAX_HOLD_S must be a finite number of seconds above 0')
    expect(existsSync(`${socket}.ready`)).toBe(false)
  })

  it('isolates malformed, oversized, timed-out, and excess clients', async () => {
    const broker = await startBroker()
    for (const request of ['{bad', `${'x'.repeat(4097)}`]) {
      const client = connect(broker.socket, request)
      await client.waitForReply(errorReply)
    }
    const idle = connect(broker.socket)
    await idle.waitForReply(errorReply)
    const held = Array.from({ length: 16 }, (_, index) => connect(broker.socket, { argv: ['held', String(index)], waitS: 10 }))
    await Promise.all(held.map((client) => client.waitForReply((text) => granted(text) || text.includes('wait '))))
    const extra = connect(broker.socket, { argv: ['overflow'], waitS: 1 })
    await extra.waitForReply((text) => /^error busy: holder pid .*wt-suite-lock status\n/.test(text))
    for (const client of held) client.socket.destroy()
    await waitFor(() => !existsSync(broker.lock))
    // Destroying the local endpoints does not tell us when the broker has seen them go, so capacity is
    // asserted to come back: a busy answer is retried until the deadline, any other answer ends the wait.
    const deadline = Date.now() + 15_000
    let next = connect(broker.socket, { argv: ['next'], waitS: 3 })
    let reply = await next.waitForReply((text) => granted(text) || errorReply(text))
    while (/^error busy:/.test(reply) && Date.now() < deadline) {
      await waitFor(() => next.socket.destroyed)
      next = connect(broker.socket, { argv: ['next'], waitS: 3 })
      reply = await next.waitForReply((text) => granted(text) || errorReply(text))
    }
    expect(reply).toMatch(/^granted /)
    next.socket.end()
  }, 20_000)

  it('kills a running command with exit 75 when the broker disappears', async () => {
    const broker = await startBroker()
    const marker = join(broker.root, 'command-started')
    const run = spawn(process.execPath, [CLI, 'run', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes');setInterval(()=>{},1000)`], { env: sealedPluginCliEnv(broker.root, { WT_SUITE_LOCK_BROKER: broker.socket }), stdio: ['ignore', 'pipe', 'pipe'] }); children.push(run)
    let stderr = ''; run.stderr!.on('data', (chunk) => { stderr += String(chunk) })
    await waitFor(() => existsSync(marker))
    broker.child.kill('SIGKILL')
    const status = await new Promise<number | null>((resolve) => run.once('exit', resolve))
    expect(status).toBe(75)
    expect(stderr).toContain('suite lock lost (broker gone); command stopped')
    const reclaimed = spawnSync(process.execPath, [CLI, 'run', '--wait-s', '1', '--', process.execPath, '-e', 'process.stdout.write("reclaimed")'], { encoding: 'utf8', env: sealedPluginCliEnv(broker.root, { WT_SUITE_LOCK_DIR: join(broker.root, 'locks'), WT_SUITE_LOCK_BROKER: '', WT_SUITE_LEASE: '' }) })
    expect(reclaimed.status, reclaimed.stderr).toBe(0)
    expect(reclaimed.stdout).toBe('reclaimed')
  }, 10_000)

})
