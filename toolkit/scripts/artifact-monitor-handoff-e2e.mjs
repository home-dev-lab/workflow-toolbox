#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { artifactServerProcessStatus, probeArtifactServer } from '../../plugin/bin/lib/artifact-server.mjs'

const serverScript = fileURLToPath(new URL('../../plugin/bin/wt-artifact-server.mjs', import.meta.url))
const monitorScript = fileURLToPath(new URL('../../plugin/bin/wt-artifact-server-ensure.mjs', import.meta.url))

async function until(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(50)
  }
  throw new Error(`timed out: ${label}`)
}

async function freePort() {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const { port } = reservation.address()
  await new Promise((resolve) => reservation.close(resolve))
  return port
}

function receipts(file) {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split(/\s+/).filter(Boolean) : []
}

function environment(directory, port) {
  return {
    ...process.env, NODE_OPTIONS: '', XDG_STATE_HOME: directory, HOME: directory, USERPROFILE: directory,
    LOCALAPPDATA: directory, WT_ARTIFACT_SERVER: '1', WT_ARTIFACT_SERVER_PORT: String(port),
    WT_ARTIFACT_SERVER_ROOTS: `proof=${directory}`, WT_ARTIFACT_SERVER_TEST_GIT_ROOT: directory,
    // An authoritative missing binary seals tailnet detection, including on a failing/mutated run.
    WT_ARTIFACT_SERVER_TAILSCALE_BINARY: join(directory, 'unavailable-tailscale'),
    WT_ARTIFACT_SERVER_TEST_MODE: '1', WT_ARTIFACT_SERVER_TEST_PORT_ATTEMPTS: '1',
    WT_ARTIFACT_SERVER_TEST_WATCH_MS: '100', WT_ARTIFACT_SERVER_REGISTRATION_POLL_MS: '100',
    WT_ARTIFACT_SERVER_TEST_ATTACHMENT_LOG: join(directory, 'attached.log'),
    WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: join(directory, 'spawn.log'),
    WT_ARTIFACT_SERVER_TEST_SERVER_PROCESS_LOG: join(directory, 'processes.log'),
  }
}

function child(script, env, directory) {
  const process = spawn(globalThis.process.execPath, [script, ...(script === serverScript ? ['serve'] : [])], {
    env, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
  })
  process.on('error', (error) => { process.launchError = error })
  process.stdout.resume()
  process.stderr.resume()
  return process
}

async function stop(process) {
  if (!process || process.exitCode !== null || process.signalCode !== null) return
  process.kill('SIGKILL')
  await until(() => process.exitCode !== null || process.signalCode !== null, 'child exit')
}

async function drain(server, port) {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await once(socket, 'connect')
  // An unfinished request keeps a real connection draining after server.close() stops accepting.
  socket.write(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\n`)
  await delay(100)
  server.kill('SIGTERM')
  await until(async () => (await probeArtifactServer(port, 100)).kind === 'free', 'listener closure')
  assert.equal(artifactServerProcessStatus(server.pid).status, 'alive', 'old server must still execute')
  return socket
}

async function proveHandoff(server, monitor, env, port) {
  let output = ''
  monitor.stdout.on('data', (chunk) => { output += chunk })
  const socket = await drain(server, port)
  try {
    await until(() => output.includes('ARTIFACT SERVER RESTART DEFERRED:'), 'bounded drain verdict')
    assert.equal(receipts(env.WT_ARTIFACT_SERVER_TEST_SPAWN_LOG).length, 0, 'live old process forbids spawning')
    assert.equal(artifactServerProcessStatus(server.pid).status, 'alive')
    console.log('old process alive, listener closed: spawn count=0')
    console.log(output.trim())
    await stop(server)
    socket.destroy()
    await until(() => receipts(env.WT_ARTIFACT_SERVER_TEST_SERVER_PROCESS_LOG).length === 1, 'one replacement spawn')
    const [pid] = receipts(env.WT_ARTIFACT_SERVER_TEST_SERVER_PROCESS_LOG).map(Number)
    await until(async () => (await probeArtifactServer(port, 200)).health?.pid === pid, 'replacement health')
    console.log('old process gone: spawn count=1; real replacement healthy')
  } finally { socket.destroy() }
}

async function cleanup(monitor, server, env) {
  await stop(monitor)
  await stop(server)
  for (const pid of receipts(env.WT_ARTIFACT_SERVER_TEST_SERVER_PROCESS_LOG).map(Number)) {
    if (artifactServerProcessStatus(pid).status === 'gone') continue
    try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    await until(() => artifactServerProcessStatus(pid).status === 'gone', 'replacement exit')
  }
}

async function main() {
  if (process.platform !== 'linux') throw new Error('this real-drain proof requires Linux execution-state evidence')
  const directory = mkdtempSync(join(tmpdir(), 'artifact-monitor-handoff-'))
  const port = await freePort()
  const env = environment(directory, port)
  let server
  let monitor
  try {
    server = child(serverScript, env, directory)
    await until(async () => (await probeArtifactServer(port, 200)).health?.pid === server.pid, 'initial server health')
    monitor = child(monitorScript, env, directory)
    await until(() => receipts(env.WT_ARTIFACT_SERVER_TEST_ATTACHMENT_LOG).length > 0, 'monitor attachment')
    await proveHandoff(server, monitor, env, port)
  } finally {
    await cleanup(monitor, server, env)
    rmSync(directory, { recursive: true, force: true })
  }
}

await main()
