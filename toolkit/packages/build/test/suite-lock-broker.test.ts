import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { acquireSuiteLock } from '../../../../plugin/bin/lib/suite-lock.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createSuiteLockBroker } from '../../../../plugin/bin/lib/host/lane-suite-lock-broker.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const BROKER = join(ROOT, 'plugin/bin/lib/host/lane-suite-lock-broker.mjs')
const CLI = join(ROOT, 'plugin/bin/wt-suite-lock.mjs')
const roots: string[] = []
const children: Array<ReturnType<typeof spawn>> = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for fixture state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function startBroker(parent = process.pid) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lock-broker-')); roots.push(root)
  const socket = join(root, 'broker.sock')
  const child = spawn(process.execPath, [BROKER, '--socket', socket, '--parent', String(parent), '--label', 'test-lane'], { env: sealedPluginCliEnv(root, { WT_SUITE_LOCK_DIR: join(root, 'locks') }), stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  await waitFor(() => existsSync(socket))
  return { root, socket, child, lock: join(root, 'locks', 'lock.d', 'holder.json') }
}

function connect(socketPath: string, request?: unknown, allowHalfOpen = false) {
  const socket = net.connect({ path: socketPath, allowHalfOpen })
  let text = ''
  socket.on('data', (chunk) => { text += String(chunk) })
  if (request !== undefined) socket.write(`${typeof request === 'string' ? request : JSON.stringify(request)}\n`)
  return { socket, text: () => text }
}

async function localBroker() {
  const root = mkdtempSync(join(tmpdir(), 'wt-lock-local-broker-')); roots.push(root)
  const address = join(root, 'broker.sock')
  const previous = process.env.WT_SUITE_LOCK_DIR
  process.env.WT_SUITE_LOCK_DIR = join(root, 'locks')
  const server = createSuiteLockBroker() as net.Server
  await new Promise<void>((resolve) => server.listen(address, resolve))
  return { address, server, restore: () => { if (previous === undefined) delete process.env.WT_SUITE_LOCK_DIR; else process.env.WT_SUITE_LOCK_DIR = previous } }
}

async function connectionCount(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)))
}

async function waitForConnections(server: net.Server, count: number) {
  const deadline = Date.now() + 3500
  while (await connectionCount(server) !== count) {
    if (Date.now() >= deadline) throw new Error(`expected ${count} broker connections; still ${await connectionCount(server)}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('lane suite-lock broker', () => {
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

  it('closes half-open invalid requests and recovers admission slots', async () => {
    const { address, server, restore } = await localBroker()
    const rejected = Array.from({ length: 16 }, () => connect(address, '{bad', true))
    try {
      await waitFor(() => rejected.every((client) => client.text().startsWith('error ')))
      await waitForConnections(server, 0)
      expect(await connectionCount(server)).toBe(0)
      const next = connect(address, { argv: ['next'], waitS: 1 })
      await waitFor(() => next.text().includes('granted '))
      next.socket.end()
    } finally { for (const client of rejected) client.socket.destroy(); server.close(); restore() }
  }, 10_000)

  it('closes half-open busy requests within a bound', async () => {
    const { address, server, restore } = await localBroker()
    const held = Array.from({ length: 16 }, () => connect(address))
    await waitForConnections(server, 16)
    const rejected = connect(address, undefined, true)
    try {
      await waitFor(() => rejected.text().startsWith('error busy'))
      await waitForConnections(server, 16)
      expect(await connectionCount(server)).toBe(16)
      for (const client of held) client.socket.destroy()
      await waitForConnections(server, 0)
      const next = connect(address, { argv: ['next'], waitS: 1 })
      await waitFor(() => next.text().includes('granted '))
      next.socket.end()
    } finally { rejected.socket.destroy(); for (const client of held) client.socket.destroy(); server.close(); restore() }
  }, 10_000)
  it('holds as the broker, serialises clients, and releases on client end', async () => {
    const broker = await startBroker()
    const first = connect(broker.socket, { argv: ['pnpm', 'test'], waitS: 2 })
    await waitFor(() => first.text().includes('granted '))
    const holder = JSON.parse(readFileSync(broker.lock, 'utf8'))
    expect(holder.pid).toBe(broker.child.pid)
    expect(holder.argv.slice(0, 2)).toEqual(['wt-lane-sandbox', 'test-lane'])
    const second = connect(broker.socket, { argv: ['pnpm', 'lint'], waitS: 2 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(second.text()).not.toContain('granted ')
    first.socket.end()
    await waitFor(() => second.text().includes('granted '))
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
    await waitFor(() => client.text().includes('granted '))
    let closed = false
    client.socket.on('close', () => { closed = true })
    parent.kill('SIGKILL')
    await waitFor(() => !existsSync(broker.lock) && closed, 6000)
  })

  it('isolates malformed, oversized, timed-out, and excess clients', async () => {
    const broker = await startBroker()
    for (const request of ['{bad', `${'x'.repeat(4097)}`]) {
      const client = connect(broker.socket, request)
      await waitFor(() => client.text().startsWith('error '))
    }
    const idle = connect(broker.socket)
    await waitFor(() => idle.text().startsWith('error '), 6500)
    const held = Array.from({ length: 16 }, () => connect(broker.socket))
    const extra = connect(broker.socket)
    await waitFor(() => extra.text().startsWith('error busy'))
    for (const client of held) client.socket.destroy()
    const next = connect(broker.socket, { argv: ['next'], waitS: 1 })
    await waitFor(() => next.text().includes('granted '))
    next.socket.end()
  }, 10_000)

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
    const reclaimed = spawnSync(process.execPath, [CLI, 'run', '--wait-s', '1', '--', process.execPath, '-e', 'process.stdout.write("reclaimed")'], { encoding: 'utf8', env: sealedPluginCliEnv(broker.root, { WT_SUITE_LOCK_DIR: join(broker.root, 'locks'), WT_SUITE_LOCK_BROKER: '' }) })
    expect(reclaimed.status, reclaimed.stderr).toBe(0)
    expect(reclaimed.stdout).toBe('reclaimed')
  }, 10_000)
})
