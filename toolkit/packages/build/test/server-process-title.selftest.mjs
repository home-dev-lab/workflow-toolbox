import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isInvokedDirectly } from '../../../../plugin/bin/lib/host/entry-guard.mjs'

const BIN = process.env.WT_PROCESS_TITLE_BIN ?? fileURLToPath(new URL('../../../../plugin/bin/', import.meta.url))
export const LINUX_SKIP_REASON = 'Linux /proc/<pid>/comm is required to verify kernel process names'
const TITLES = { server: 'wt-artifact-srv', holder: 'wt-artifact-hol', observe: 'wt-observe-srv' }
// Loaded only into the real server under test. The child uses the server's default
// spawn environment and no preload, so an inherited naming option is observable.
const PROBE = `
import { spawnSync } from 'node:child_process'
process.on('message', (message) => {
  if (message !== 'probe-child') return
  const code = "const fs = require('node:fs'); console.log(JSON.stringify({pid: process.pid, ppid: process.ppid, comm: fs.readFileSync('/proc/self/comm', 'utf8').trim(), nodeOptions: process.env.NODE_OPTIONS ?? null}))"
  const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 5000 })
  process.send({ status: child.status, stderr: child.stderr, stdout: child.stdout })
})
`

async function freePort() {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const { port } = reservation.address()
  await new Promise((resolve) => reservation.close(resolve))
  return port
}

async function waitFor(read, child) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'entry exited before becoming ready')
    assert.equal(child.signalCode, null, 'entry was signalled before becoming ready')
    try { if (read()) return } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await delay(25)
  }
  assert.fail('entry did not become ready within 10000 ms')
}

function startEntry(fixture, name, args, spawnProcess) {
  const probeUrl = pathToFileURL(join(fixture.directory, 'probe.mjs')).href
  const child = spawnProcess(process.execPath, [
    '--import', probeUrl,
    join(BIN, name), ...args,
  ], { cwd: fixture.directory, env: fixture.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  fixture.children.push(child)
  child.stderr.on('data', (chunk) => { fixture.stderr += String(chunk) })
  return child
}

function fixtureEnvironment(directory, port) {
  return {
    ...process.env, HOME: directory, USERPROFILE: directory,
    CLAUDE_CONFIG_DIR: join(directory, 'config'), XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_STATE_HOME: join(directory, 'state'), WT_ARTIFACT_SERVER: '1',
    WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_ROOTS: `artifacts=${directory}`,
    WT_ARTIFACT_SERVER_IDLE_GRACE_S: '600', WT_ARTIFACT_SERVER_TAILSCALE_BINARY: process.execPath,
    WT_ARTIFACT_SERVER_TEST_MODE: '1', WT_ARTIFACT_SERVER_TEST_PORT_ATTEMPTS: '1',
    WT_ARTIFACT_SERVER_TEST_ATTACHMENT_LOG: join(directory, 'attached.log'),
  }
}

async function startFixture(fixture, kind, spawnProcess) {
  if (kind === 'observe') return startObserveFixture(fixture, spawnProcess)
  const registrations = join(fixture.env.XDG_STATE_HOME, 'wt-artifact-server', 'registrations')
  mkdirSync(registrations, { recursive: true, mode: 0o700 })
  writeFileSync(join(registrations, 'test.json'), JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), deny: [],
    roots: [{ name: 'artifacts', path: fixture.directory }],
  }), { mode: 0o600 })
  writeFileSync(join(fixture.directory, 'probe.mjs'), PROBE)
  const server = startEntry(fixture, 'wt-artifact-server.mjs', ['serve'], spawnProcess)
  await waitFor(() => JSON.parse(readFileSync(join(registrations, '..', 'server.json'), 'utf8')).pid === server.pid, server)
  if (kind === 'server') return server
  const holder = startEntry(fixture, 'wt-artifact-server-ensure.mjs', [], spawnProcess)
  await waitFor(() => readFileSync(fixture.env.WT_ARTIFACT_SERVER_TEST_ATTACHMENT_LOG, 'utf8').includes(`${holder.pid} `), holder)
  return holder
}

// The companion app is distributed separately. This checkout stand-in runs behind
// the real launcher and real tsx, and reports the PID of the actual HTTP server.
const OBSERVE_SERVER = `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const server = createServer((request, response) => {
  const code = "const fs = require('node:fs'); console.log(JSON.stringify({pid: process.pid, ppid: process.ppid, comm: fs.readFileSync('/proc/self/comm', 'utf8').trim(), nodeOptions: process.env.NODE_OPTIONS ?? null}))"
  const health = { app: 'observe-ui', pid: process.pid, port: server.address().port,
    startedAt: new Date().toISOString(), configDir: process.env.CLAUDE_CONFIG_DIR }
  const child = request.url === '/probe-child'
    ? spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 5000 }) : null
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(child ? {status: child.status, stderr: child.stderr, stdout: child.stdout} : health))
})
server.listen(Number(process.env.OBSERVE_UI_SERVER_PORT), '127.0.0.1', () => {
  writeFileSync(process.env.WT_PROCESS_TITLE_RECEIPT, JSON.stringify({pid: process.pid, argv: process.argv}))
})
`

async function startObserveFixture(fixture, spawnProcess) {
  const app = join(fixture.directory, 'apps', 'observe-ui')
  mkdirSync(join(app, 'server'), { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: '@workflow-toolbox/observe-ui' }))
  writeFileSync(join(app, 'server', 'dev-api.ts'), OBSERVE_SERVER)
  writeFileSync(join(fixture.directory, 'package.json'), '{"type":"module"}')
  symlinkSync(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(fixture.directory, 'node_modules'), 'dir')
  const git = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' })
  assert.equal(git.status, 0, git.stderr)
  Object.assign(fixture.env, {
    DWT_OBSERVE_ROOT: fixture.directory, OBSERVE_UI_SERVER_PORT: fixture.env.WT_ARTIFACT_SERVER_PORT,
    WT_PROCESS_TITLE_RECEIPT: join(fixture.directory, 'observe-pid.json'), GIT_DIR: git.stdout.trim(),
  })
  writeFileSync(join(fixture.directory, 'probe.mjs'), PROBE)
  const cli = startEntry(fixture, 'wt-observe.mjs', ['start', '--watch', '--allow-branch', '--source', fixture.directory], spawnProcess)
  await waitFor(() => {
    const receipt = JSON.parse(readFileSync(fixture.env.WT_PROCESS_TITLE_RECEIPT, 'utf8'))
    fixture.observePid = receipt.pid
    assert.deepEqual(receipt.argv.slice(1), [join(app, 'server', 'dev-api.ts'), '--watch'], 'server must retain its entry argv and watch flag')
    return true
  }, cli)
  const cliComm = readFileSync(`/proc/${cli.pid}/comm`, 'utf8').trim()
  assert.ok(!Object.values(TITLES).includes(cliComm), 'short start CLI must not get a server title')
  return { pid: fixture.observePid }
}

async function stopEntry(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  if (child.connected) child.disconnect()
  // Only ChildProcess instances started by this fixture are signalled, by exact PID.
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 3_000)
  try { await exited } finally { clearTimeout(force) }
}

async function checkChild(entry, fixture, kind, log) {
  const result = kind === 'observe'
    ? await (await fetch(`http://127.0.0.1:${fixture.env.OBSERVE_UI_SERVER_PORT}/probe-child`, { signal: AbortSignal.timeout(7_000) })).json()
    : await probeEntry(entry)
  assert.equal(result.status, 0, `server-spawned child failed: ${result.stderr}`)
  const child = JSON.parse(result.stdout)
  assert.equal(child.ppid, entry.pid, 'probe child must be spawned by the real entry process')
  assert.ok(!Object.values(TITLES).includes(child.comm), `child inherited a server name: ${child.comm}`)
  assert.equal(child.nodeOptions, fixture.env.NODE_OPTIONS ?? null, 'server must not change inherited NODE_OPTIONS')
  log(`${kind} child PID=${child.pid} PPID=${child.ppid} comm=${child.comm}`)
}

async function probeEntry(entry) {
  const response = once(entry, 'message', { signal: AbortSignal.timeout(7_000) })
  entry.send('probe-child')
  const [result] = await response
  return result
}

function checkStop(fixture, log) {
  const result = spawnSync(process.execPath, [join(BIN, 'wt-artifact-server.mjs'), 'stop', '--force'], {
    cwd: fixture.directory, env: fixture.env, encoding: 'utf8', timeout: 7_000,
  })
  assert.equal(result.status, 0, `named artifact server must remain stoppable: ${result.stderr}`)
  log(`stop CLI: ${result.stdout.trim()}`)
}

export async function checkServerProcessTitle(kind, spawnProcess = spawn, log = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'wt-process-title-'))
  const fixture = { directory, env: fixtureEnvironment(directory, await freePort()), children: [], stderr: '' }
  try {
    const entry = await startFixture(fixture, kind, spawnProcess)
    const comm = readFileSync(`/proc/${entry.pid}/comm`, 'utf8').trim()
    log(`${kind} PID=${entry.pid} comm=${comm}`)
    assert.equal(comm, TITLES[kind], `${kind} kernel comm must be ${TITLES[kind]}`)
    assert.ok(TITLES[kind].length <= 15, 'server title must fit the Linux comm limit')
    await checkChild(entry, fixture, kind, log)
    if (kind === 'server') checkStop(fixture, log)
  } catch (error) {
    error.message += `\nentry stderr: ${fixture.stderr}`
    throw error
  } finally {
    if (fixture.observePid) process.kill(fixture.observePid, 'SIGTERM')
    for (const child of fixture.children.reverse()) {
      await stopEntry(child)
      log(`stopped PID=${child.pid}`)
    }
    rmSync(directory, { recursive: true, force: true })
  }
}

export function checkShortProcessTitles() {
  const directory = mkdtempSync(join(tmpdir(), 'wt-title-cli-'))
  try {
    const probe = join(directory, 'exit-probe.mjs')
    writeFileSync(probe, `import {readFileSync} from 'node:fs'; process.on('exit', () => console.error('COMM=' + readFileSync('/proc/self/comm', 'utf8').trim()))`)
    const commands = [
      ['wt-artifact-server.mjs', '--help'], ['wt-artifact-server-ensure.mjs', '--help'],
      ['wt-artifact-server-ensure.mjs'], ['wt-observe.mjs', '--help'],
    ]
    for (const [name, ...args] of commands) {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(probe).href, join(BIN, name), ...args], {
        cwd: directory, env: { ...fixtureEnvironment(directory, 0), WT_ARTIFACT_SERVER: '0' }, encoding: 'utf8', timeout: 7_000,
      })
      assert.equal(result.status, 0, result.stderr)
      const comm = /COMM=(.+)/.exec(result.stderr)?.[1]
      assert.ok(comm, `${name} must report its kernel name`)
      assert.ok(!Object.values(TITLES).includes(comm), `${name} ${args.join(' ')} must not get a server title`)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (isInvokedDirectly(import.meta.url)) {
  const { test } = await import('node:test')
  for (const kind of Object.keys(TITLES)) {
    test(`${kind} has its own kernel name and does not rename its children`, {
      skip: process.platform !== 'linux' ? LINUX_SKIP_REASON : false,
    }, () => checkServerProcessTitle(kind, spawn, console.log))
  }
  test('short CLI commands do not receive server titles', {
    skip: process.platform !== 'linux' ? LINUX_SKIP_REASON : false,
  }, checkShortProcessTitles)
}
