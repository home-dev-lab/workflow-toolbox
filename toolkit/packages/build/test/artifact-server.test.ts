import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, utimesSync, watch, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper shipped by the plugin has no TypeScript declaration
import { artifactUrl, assignArtifactMounts, deriveArtifactPort, parseTailscaleServeUrl } from '../../../../plugin/bin/lib/artifact-server.mjs'
// @ts-expect-error runtime .mjs helper shipped by the plugin has no TypeScript declaration
import { inspectProcess, sameIdentity } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SERVER = join(REPO_ROOT, 'plugin/bin/wt-artifact-server.mjs')
const ENSURE = join(REPO_ROOT, 'plugin/bin/wt-artifact-server-ensure.mjs')
const MONITORS = join(REPO_ROOT, 'plugin/monitors/monitors.json')
const temporaryDirs: string[] = []
const children = new Set<ChildProcess>()
const childOutputs = new WeakMap<ChildProcess, ReturnType<typeof captureChildOutput>>()
const ensureOutputs = new Map<string, Array<ReturnType<typeof captureChildOutput>>>()
type ProcessIdentity = { pid: number, argv: string[], startTime: number, startTimeApproximate?: boolean, image?: { name: string, path: string | null }, cwd?: string | null }
type DetachedProcess = { identity: ProcessIdentity | null, state: Discovery | null }
const detachedProcesses = new Map<number, DetachedProcess>()
const serverProcessLogs = new Map<string, { captured: Set<number>, timer: ReturnType<typeof setInterval> }>()
const CANDIDATE_PROBE_MS = 750
const FALLBACK_CANDIDATES = 2
const FALLBACK_READINESS_MS = 5_000
const FALLBACK_DISCOVERY_MARGIN_MS = 2_000
const FALLBACK_DISCOVERY_BOUND_MS = CANDIDATE_PROBE_MS * FALLBACK_CANDIDATES + FALLBACK_READINESS_MS + FALLBACK_DISCOVERY_MARGIN_MS

function temporaryDir(tag: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wt-artifact-${tag}-`)))
  temporaryDirs.push(dir)
  return dir
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function detachedIdentity(pid: number): ProcessIdentity | null {
  const recordedArgv = [process.execPath, SERVER, 'serve']
  // Destructive checks must not reuse lane supervision's short process-read cache.
  return inspectProcess(pid, { captureCwd: false, recordedArgv, spawnSync: spawnSync.bind(null) })
}

function trackDetached(pid: number, state: Discovery | null = null) {
  const previous = detachedProcesses.get(pid)
  const identity = previous?.identity ?? detachedIdentity(pid)
  detachedProcesses.set(pid, { identity, state: state ?? previous?.state ?? null })
}

function detachedIdentityMatches(expected: ProcessIdentity, inspect = detachedIdentity) {
  return sameIdentity(expected, inspect(expected.pid))
}

function killWindowsTree(pid: number, run = spawnSync) {
  const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
  return run(taskkill, ['/PID', String(pid), '/T', '/F'], { timeout: 5_000, windowsHide: true, stdio: 'ignore' })
}

async function waitFor<T>(read: () => T | null | Promise<T | null>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for condition; predicate=${JSON.stringify(read.toString())}`)
}

function statePath(stateHome: string) {
  return join(stateHome, 'wt-artifact-server', 'server.json')
}

function registrationsPath(stateHome: string) {
  return join(stateHome, 'wt-artifact-server', 'registrations')
}

function startupClaimPath(stateHome: string) {
  return join(stateHome, 'wt-artifact-server', 'startup.claim')
}

function spawnReceipts(file: string) {
  try { return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) } catch { return [] }
}

function jsonReceipts<T>(file: string): T[] {
  return spawnReceipts(file).map((line) => JSON.parse(line) as T)
}

function captureChildOutput(child: ChildProcess) {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  return { stdout: () => stdout, stderr: () => stderr }
}

function childOutput(child: ChildProcess) {
  let output = childOutputs.get(child)
  if (!output) {
    output = captureChildOutput(child)
    childOutputs.set(child, output)
  }
  return output
}

function captureSpawnedServers(file: string, captured: Set<number>) {
  for (const value of spawnReceipts(file)) {
    const pid = Number(value)
    if (!Number.isSafeInteger(pid) || pid <= 1 || captured.has(pid)) continue
    trackDetached(pid)
    if (detachedProcesses.get(pid)?.identity) captured.add(pid)
  }
}

function watchSpawnedServers(file: string) {
  if (serverProcessLogs.has(file)) return
  const captured = new Set<number>()
  const timer = setInterval(() => captureSpawnedServers(file, captured), 250)
  timer.unref()
  serverProcessLogs.set(file, { captured, timer })
}

function lastOutputLine(value: string) {
  return value.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '<none>'
}

type RootRecord = { name: string, path: string }
type Discovery = {
  version: string
  pid: number
  port: number
  baseUrl: string
  remoteUrl: string | null
  tailnetDetection?: { status: 'available' | 'no-tailnet' | 'unavailable', reason: string | null }
  roots: RootRecord[]
  mounts?: RootRecord[]
  startedAt: string
}

const CHROME = process.env.CHROME_BIN ?? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync)

function renderInChrome(url: string) {
  if (!CHROME) throw new Error('Chrome/Chromium is unavailable')
  return new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve, reject) => {
    const profile = temporaryDir('chrome-profile')
    const child = spawn(CHROME, [
      '--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`,
      '--dump-dom', '--virtual-time-budget=2000', url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => {
      children.delete(child)
      resolve({ code, stdout, stderr })
    })
  })
}

function readState(stateHome: string): Discovery | null {
  try { return JSON.parse(readFileSync(statePath(stateHome), 'utf8')) as Discovery } catch { return null }
}

function commandShim(bin: string, name: string, source: string) {
  const implementation = join(bin, `${name}.cjs`)
  writeFileSync(implementation, source)
  const posix = join(bin, name)
  writeFileSync(posix, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(implementation)} "$@"\n`)
  chmodSync(posix, 0o755)
  const windows = join(bin, `${name}.cmd`)
  writeFileSync(windows, `@"${process.execPath}" "${implementation}" %*\r\n`)
  return process.platform === 'win32' ? windows : posix
}

function baseEnv(stateHome: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const bin = temporaryDir('tailscale-default-absent')
  const tailscale = commandShim(bin, 'tailscale', 'process.exitCode = 1\n')
  commandShim(bin, 'git', "if (process.env.WT_TEST_GIT_ROOT && process.argv.slice(2).join(' ') === 'rev-parse --show-toplevel') process.stdout.write(process.env.WT_TEST_GIT_ROOT + '\\n'); else process.exitCode = 1\n")
  return {
    ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, XDG_STATE_HOME: stateHome,
    WT_ARTIFACT_SERVER_TAILSCALE_BINARY: tailscale,
    WT_ARTIFACT_SERVER_REGISTRATION_POLL_MS: '25', WT_ARTIFACT_SERVER_TEST_MODE: '1', ...extra,
  }
}

async function reservePort(host = '127.0.0.1') {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('listener has no TCP port')
  return { port: address.port, server }
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (!child.pid || !pidAlive(child.pid)) return
  const pid = child.pid
  if (process.platform === 'win32') killWindowsTree(pid)
  else child.kill(signal)
  await waitFor(() => pidAlive(pid) ? null : true, 10_000).catch(() => {
    throw new Error(`timed out waiting for test child pid=${pid} to exit before teardown`)
  })
}

async function detachedServerMatches(expected: Discovery) {
  try {
    const actual = await health(expected)
    return actual.pid === expected.pid && actual.port === expected.port && actual.version === expected.version &&
      actual.uid === (typeof process.getuid === 'function' ? process.getuid() : userInfo().username)
  } catch {
    return false
  }
}

async function stopDetached(record: DetachedProcess) {
  const pid = record.identity?.pid ?? record.state?.pid
  if (!pid) return
  const processMatches = record.identity ? detachedIdentityMatches(record.identity) : false
  // A loaded hosted Windows runner can time out the PowerShell identity refresh. The live server's
  // authenticated protocol identity is the bounded fallback; no identity evidence still means no kill.
  const serverMatches = process.platform === 'win32' && record.state ? await detachedServerMatches(record.state) : false
  if (!processMatches && !serverMatches) {
    detachedProcesses.delete(pid)
    return
  }
  try {
    if (process.platform === 'win32') {
      killWindowsTree(pid)
    } else {
      process.kill(pid, 'SIGTERM')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    detachedProcesses.delete(pid)
    return
  }
  await waitFor(() => pidAlive(pid) ? null : true, 10_000).catch(() => {
    throw new Error(`timed out waiting for detached artifact server pid=${pid} to exit before teardown`)
  })
  detachedProcesses.delete(pid)
}

afterEach(async () => {
  for (const [file, record] of serverProcessLogs) {
    clearInterval(record.timer)
    captureSpawnedServers(file, record.captured)
  }
  serverProcessLogs.clear()
  for (const child of [...children]) {
    children.delete(child)
    await stopChild(child)
  }
  for (const record of [...detachedProcesses.values()]) await stopDetached(record)
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, ...(process.platform === 'win32' ? { maxRetries: 20, retryDelay: 100 } : {}) })
  }
  ensureOutputs.clear()
})

function spawnEnsure(cwd: string, env: NodeJS.ProcessEnv) {
  const stateHome = env.XDG_STATE_HOME
  const processLog = process.platform === 'win32' && stateHome ? join(stateHome, 'server-processes.log') : null
  const child = spawn(process.execPath, [ENSURE], {
    cwd,
    env: processLog ? { ...env, WT_ARTIFACT_SERVER_TEST_SERVER_PROCESS_LOG: processLog } : env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  if (stateHome) {
    const output = childOutput(child)
    ensureOutputs.set(stateHome, [...ensureOutputs.get(stateHome) ?? [], output])
  }
  if (processLog) watchSpawnedServers(processLog)
  return child
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [SERVER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.once('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

async function waitForState(stateHome: string, predicate: (state: Discovery) => boolean = () => true, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  const state = await new Promise<Discovery>((resolve, reject) => {
    let watcher: ReturnType<typeof watch> | null = null
    let poller: ReturnType<typeof setInterval> | null = null
    const stopWaiting = () => {
      clearTimeout(timer)
      if (poller) clearInterval(poller)
      watcher?.close()
    }
    const timer = setTimeout(() => {
      stopWaiting()
      const outputs = ensureOutputs.get(stateHome) ?? []
      const stdout = outputs.map((output) => lastOutputLine(output.stdout())).at(-1) ?? '<none>'
      const stderr = outputs.map((output) => lastOutputLine(output.stderr())).at(-1) ?? '<none>'
      reject(new Error(`timed out waiting for artifact server state; predicate=${JSON.stringify(predicate.toString())}; last state=${JSON.stringify(readState(stateHome))}; last stdout=${JSON.stringify(stdout)}; last stderr=${JSON.stringify(stderr)}`))
    }, timeoutMs)
    const inspect = () => {
      const value = readState(stateHome)
      if (!value || !predicate(value)) return false
      stopWaiting()
      resolve(value)
      return true
    }
    const arm = () => {
      if (inspect()) return
      if (Date.now() >= deadline) return
      watcher?.close()
      const stateDir = join(stateHome, 'wt-artifact-server')
      // Canonical spelling before libuv, as the wake-channel server does: on the hosted Windows runner the
      // temp state home carries an 8.3 short name, and fs.watch on that spelling trips libuv's
      // src\win\fs-event.c:72 assertion, which ABORTS the vitest worker with no result line (runs 27–31 of
      // the cross-OS card; run 31's traced single-file step printed the assertion after two tests).
      const watchTarget = realpathSync.native(existsSync(stateDir) ? stateDir : stateHome)
      watcher = watch(watchTarget, { persistent: false }, () => {
        if (!inspect() && existsSync(stateDir)) arm()
      })
      inspect()
    }
    // fs.watch is the fast path, not the correctness boundary: events may be coalesced or
    // dropped on every supported platform. Poll the state predicate as a bounded backstop.
    poller = setInterval(inspect, 50)
    arm()
  })
  trackDetached(state.pid, state)
  return state
}

function rawRequest(port: number, pathname: string, host?: string, connectHost = '127.0.0.1', method = 'GET'): Promise<{ status: number, body: string, headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolvePromise, reject) => {
    const headers = host === undefined ? {} : { Host: host }
    const req = httpRequest({ host: connectHost, port, path: pathname, method, headers, setHost: host !== undefined }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, body, headers: response.headers }))
    })
    req.once('error', reject)
    req.end()
  })
}

async function health(state: Discovery) {
  const response = await rawRequest(state.port, '/__wt-artifact-server/health', `localhost:${state.port}`)
  return JSON.parse(response.body) as { service: string, version: string, uid: number | string, pid: number, port: number, registeredSessions: number }
}

describe('review test infrastructure', () => {
  it('[B-01] retries awaited async predicates', async () => {
    let calls = 0
    const result = await waitFor(async () => ++calls === 3 ? 'ready' : null)
    expect(result).toBe('ready')
    expect(calls).toBe(3)
  })

  it('refuses to stop a recycled detached PID', () => {
    const expected: ProcessIdentity = { pid: 123, argv: ['node', SERVER, 'serve'], startTime: 10 }
    expect(detachedIdentityMatches(expected, () => ({ ...expected, startTime: 11 }))).toBe(false)
  })

  it('uses taskkill to stop the verified Windows process tree', () => {
    const calls: unknown[][] = []
    killWindowsTree(123, ((...args: unknown[]) => {
      calls.push(args)
      return {} as ReturnType<typeof spawnSync>
    }) as typeof spawnSync)
    expect(calls).toEqual([[
      join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', '123', '/T', '/F'],
      { timeout: 5_000, windowsHide: true, stdio: 'ignore' },
    ]])
  })
})

function projectWithRoots(tag: string) {
  const project = temporaryDir(tag)
  const reports = join(project, '.claude', 'reports')
  const worktrees = join(project, '.claude', 'worktrees')
  mkdirSync(reports, { recursive: true })
  mkdirSync(worktrees, { recursive: true })
  return { project, reports, worktrees }
}

describe('owner decision 1: default enablement', () => {
  it('[B-02] starts by default and only WT_ARTIFACT_SERVER=0 disables it', async () => {
    const { project } = projectWithRoots('default-on')
    const stateHome = temporaryDir('default-on-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)

    const monitor = spawnEnsure(project, baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port) }))
    const state = await waitForState(stateHome)
    expect(state.port).toBe(port)
    await waitFor(async () => (await health(state)).registeredSessions === 1 ? true : null)
    await stopChild(monitor)

    const offState = temporaryDir('explicit-off-state')
    const off = spawnSync(process.execPath, [ENSURE], {
      cwd: project,
      encoding: 'utf8',
      env: baseEnv(offState, { WT_ARTIFACT_SERVER: '0', WT_ARTIFACT_SERVER_PORT: String(port) }),
    })
    expect(off.status).toBe(0)
    expect(readState(offState)).toBeNull()
    const monitors = JSON.parse(readFileSync(MONITORS, 'utf8')) as Array<{ name: string, description: string }>
    expect(monitors.find((entry) => entry.name === 'artifact-server')?.description).not.toMatch(/opt-in/i)
  })
})

describe('owner decision 2: discovery and one instance', () => {
  it('[A-02] derives a stable per-user port outside Atrium range', () => {
    const username = userInfo().username
    expect(deriveArtifactPort(username)).toBe(deriveArtifactPort(username))
    expect(deriveArtifactPort(username)).toBeGreaterThanOrEqual(48_000)
    expect(deriveArtifactPort(username)).toBeLessThan(49_000)
    expect(deriveArtifactPort(`${username}-other`)).not.toBe(deriveArtifactPort(username))
  })

  it('[E-01] lets two concurrent monitors attach to one server', async () => {
    const { project } = projectWithRoots('race')
    const stateHome = temporaryDir('race-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const env = baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port) })
    spawnEnsure(project, env)
    spawnEnsure(project, env)
    const state = await waitForState(stateHome)
    await waitFor(async () => (await health(state)).registeredSessions === 2 ? true : null)
    expect((await health(state)).pid).toBe(state.pid)
    expect((await health(state)).version).toBe(state.version)
    expect((await health(state)).uid).toBe(typeof process.getuid === 'function' ? process.getuid() : userInfo().username)
    if (process.platform !== 'win32') expect(statSync(statePath(stateHome)).mode & 0o777).toBe(0o600)
  })

  it('starts exactly one server when concurrent monitors ensure an empty state', async () => {
    const { project } = projectWithRoots('startup-claim-race')
    const stateHome = temporaryDir('startup-claim-race-state')
    const spawnLog = join(temporaryDir('startup-claim-race-log'), 'spawns.log')
    const contentionLog = join(temporaryDir('startup-claim-contention-log'), 'contention.log')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const env = baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: spawnLog,
      WT_ARTIFACT_SERVER_TEST_CONTENTION_LOG: contentionLog,
      WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '150',
    })

    for (let index = 0; index < 6; index += 1) spawnEnsure(project, env)

    const state = await waitForState(stateHome)
    await waitFor(async () => (await health(state)).registeredSessions === 6 ? true : null, 10_000)
    expect(spawnReceipts(spawnLog)).toHaveLength(1)
    expect(spawnReceipts(contentionLog).length).toBeGreaterThan(0)
  })

  it('ignores all test controls unless master test mode is enabled', async () => {
    const { project } = projectWithRoots('test-mode-gate')
    const stateHome = temporaryDir('test-mode-gate-state')
    const testLog = join(temporaryDir('test-mode-gate-log'), 'spawns.log')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_MODE: '0',
      WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: testLog, WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '30000',
      WT_ARTIFACT_SERVER_TEST_PORT_ATTEMPTS: '1', WT_ARTIFACT_SERVER_TEST_HOLDER_BOUND_MS: '1',
      WT_ARTIFACT_SERVER_TEST_RETRY_ATTEMPTS: '1', WT_ARTIFACT_SERVER_TEST_RETRY_WINDOW_MS: '1',
      WT_ARTIFACT_SERVER_TEST_RETRY_OVERALL_CAP_MS: '1',
      WT_ARTIFACT_SERVER_TEST_READINESS_MS: '1',
    }))

    await waitForState(stateHome)
    expect(spawnReceipts(testLog)).toEqual([])
  })

  it('names every active test control in one startup banner', () => {
    const { project } = projectWithRoots('test-mode-banner')
    const stateHome = temporaryDir('test-mode-banner-state')
    const result = spawnSync(process.execPath, [ENSURE], {
      cwd: project,
      encoding: 'utf8',
      env: baseEnv(stateHome, {
        WT_ARTIFACT_SERVER: '0',
        WT_ARTIFACT_SERVER_TEST_CLAIM_STALE_MS: '60000',
      }),
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('ARTIFACT SERVER TEST MODE')
    expect(result.stderr).toContain('WT_ARTIFACT_SERVER_TEST_MODE=1')
    expect(result.stderr).toContain('WT_ARTIFACT_SERVER_TEST_CLAIM_STALE_MS=60000')
  })

  it('ignores hostile retry and readiness controls when test mode is disabled', async () => {
    const { project } = projectWithRoots('retry-test-mode-gate')
    const stateHome = temporaryDir('retry-test-mode-gate-state')
    const preloadDir = temporaryDir('retry-test-mode-gate-preload')
    const preload = join(preloadDir, 'freeze-server.cjs')
    const frozenLog = join(preloadDir, 'frozen.log')
    writeFileSync(preload, `if (process.argv[1]?.endsWith('wt-artifact-server.mjs') && process.argv[2] === 'serve') { require('node:fs').appendFileSync(${JSON.stringify(frozenLog)}, JSON.stringify({ pid: process.pid, argv: process.argv }) + '\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000) }\n`)
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const startedAt = Date.now()
    const monitor = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_MODE: '0',
      WT_ARTIFACT_SERVER_TEST_RETRY_ATTEMPTS: '1', WT_ARTIFACT_SERVER_TEST_RETRY_WINDOW_MS: '1',
      WT_ARTIFACT_SERVER_TEST_RETRY_OVERALL_CAP_MS: '1',
      WT_ARTIFACT_SERVER_TEST_READINESS_MS: '1', NODE_OPTIONS: `--require=${preload}`,
    }))
    const output = childOutput(monitor)

    await waitFor(() => /did not become ready/i.test(output.stdout()) ? true : null, 8_000)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_000)
    const receipts = await waitFor(() => {
      const values = jsonReceipts<{ pid: number, argv: string[] }>(frozenLog)
      return values.length >= 3 ? values : null
    }, 20_000)
    for (const receipt of receipts) {
      expect(receipt.argv).toEqual([process.execPath, SERVER, 'serve'])
      trackDetached(receipt.pid)
    }
    expect(output.stdout()).toMatch(/retry attempt 2\/3/i)
    expect(monitor.exitCode).toBeNull()
    expect(readdirSync(registrationsPath(stateHome))).toHaveLength(1)
  }, 25_000)

  it('recovers an aged empty claim left by an interrupted holder', async () => {
    const { project } = projectWithRoots('empty-startup-claim')
    const stateHome = temporaryDir('empty-startup-claim-state')
    const spawnLog = join(temporaryDir('empty-startup-claim-log'), 'spawns.log')
    const claimPath = startupClaimPath(stateHome)
    mkdirSync(claimPath, { recursive: true, mode: 0o700 })
    const staleTime = new Date(Date.now() - 16_000)
    utimesSync(claimPath, staleTime, staleTime)
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)

    spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: spawnLog,
    }))
    const state = await waitForState(stateHome)
    expect(state.port).toBe(port)
    expect(spawnReceipts(spawnLog)).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('does not evict a live holder paused beyond the old three-second bound', async () => {
    const { project } = projectWithRoots('paused-startup-claim')
    const stateHome = temporaryDir('paused-startup-claim-state')
    const spawnLog = join(temporaryDir('paused-startup-claim-spawns'), 'spawns.log')
    const acquisitionLog = join(temporaryDir('paused-startup-claim-acquisitions'), 'acquisitions.log')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const common = {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: spawnLog,
      WT_ARTIFACT_SERVER_TEST_ACQUISITION_LOG: acquisitionLog,
      WT_ARTIFACT_SERVER_TEST_CLAIM_STALE_MS: '60000',
    }
    const holder = spawnEnsure(project, baseEnv(stateHome, {
      ...common, WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '7000',
    }))
    if (!holder.pid) throw new Error('startup claim holder has no pid')
    await waitFor(() => spawnReceipts(acquisitionLog).length === 1 ? true : null)
    process.kill(holder.pid, 'SIGSTOP')
    try {
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      spawnEnsure(project, baseEnv(stateHome, common))
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(spawnReceipts(acquisitionLog)).toHaveLength(1)
    } finally {
      if (pidAlive(holder.pid)) process.kill(holder.pid, 'SIGCONT')
    }

    const state = await waitForState(stateHome, () => true, 10_000)
    await waitFor(async () => (await health(state)).registeredSessions === 2 ? true : null, 10_000)
    expect(spawnReceipts(acquisitionLog)).toHaveLength(1)
    expect(spawnReceipts(spawnLog)).toHaveLength(1)
  }, 20_000)

  it('keeps a live, heartbeating claim whose creation is over 30 seconds old', async () => {
    const { project } = projectWithRoots('long-startup-claim')
    const stateHome = temporaryDir('long-startup-claim-state')
    const spawnLog = join(temporaryDir('long-startup-claim-spawns'), 'spawns.log')
    const acquisitionLog = join(temporaryDir('long-startup-claim-acquisitions'), 'acquisitions.log')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const env = baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: spawnLog,
      WT_ARTIFACT_SERVER_TEST_ACQUISITION_LOG: acquisitionLog,
      WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '31000',
    })
    const holder = spawnEnsure(project, env)
    if (!holder.pid) throw new Error('startup claim holder has no pid')
    await waitFor(() => spawnReceipts(acquisitionLog).length === 1 ? true : null)
    spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: spawnLog,
      WT_ARTIFACT_SERVER_TEST_ACQUISITION_LOG: acquisitionLog,
      WT_ARTIFACT_SERVER_TEST_HOLDER_BOUND_MS: '40000',
    }))

    await new Promise((resolve) => setTimeout(resolve, 4_000))
    expect(spawnReceipts(acquisitionLog)).toHaveLength(1)
    const state = await waitForState(stateHome, () => true, 35_000)
    await waitFor(async () => (await health(state)).registeredSessions === 2 ? true : null, 10_000)
    expect(spawnReceipts(acquisitionLog)).toHaveLength(1)
    expect(spawnReceipts(spawnLog)).toHaveLength(1)
  }, 45_000)

  it('releases only its token file and cannot delete a replacement claim', async () => {
    const { project } = projectWithRoots('owned-startup-claim')
    const stateHome = temporaryDir('owned-startup-claim-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const holder = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '5000',
    }))
    if (!holder.pid) throw new Error('startup claim holder has no pid')
    const claimPath = startupClaimPath(stateHome)
    const ownerFile = await waitFor(() => {
      try {
        const files = readdirSync(claimPath)
        return files.length === 1 && /^[0-9a-f-]+\.json$/.test(files[0]!) ? files[0]! : null
      } catch { return null }
    })
    rmSync(join(claimPath, ownerFile), { force: true })
    rmdirSync(claimPath)
    mkdirSync(claimPath, { mode: 0o700 })
    writeFileSync(join(claimPath, 'replacement.json'), '{}', { mode: 0o600 })

    await stopChild(holder)
    expect(readdirSync(claimPath)).toEqual(['replacement.json'])
  })

  it('reports a contention timeout and preserves its registration while the holder starts', async () => {
    const { project } = projectWithRoots('startup-contention-timeout')
    const stateHome = temporaryDir('startup-contention-timeout-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const holder = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '5000',
    }))
    await waitFor(() => {
      try { return readdirSync(startupClaimPath(stateHome)).length === 1 ? true : null } catch { return null }
    })
    const contender = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_HOLDER_BOUND_MS: '400',
    }))
    const output = childOutput(contender)
    await waitFor(() => /startup claim holder did not finish/i.test(output.stdout()) ? true : null, 7_000)

    expect(output.stdout()).not.toMatch(/no available port/i)
    expect(contender.exitCode).toBeNull()
    expect(readdirSync(registrationsPath(stateHome))).toHaveLength(2)
    await stopChild(holder)
  })

  it('retries discovery after a contending holder dies and becomes served', async () => {
    const { project } = projectWithRoots('startup-retry-after-dead-holder')
    const stateHome = temporaryDir('startup-retry-after-dead-holder-state')
    const spawnLog = join(temporaryDir('startup-retry-after-dead-holder-spawns'), 'spawns.log')
    const acquisitionLog = join(temporaryDir('startup-retry-after-dead-holder-acquisitions'), 'acquisitions.log')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const common = {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: spawnLog,
      WT_ARTIFACT_SERVER_TEST_ACQUISITION_LOG: acquisitionLog,
    }
    const holder = spawnEnsure(project, baseEnv(stateHome, {
      ...common, WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '30000',
    }))
    if (!holder.pid) throw new Error('startup claim holder has no pid')
    expect(holder.spawnargs).toEqual([process.execPath, ENSURE])
    await waitFor(() => spawnReceipts(acquisitionLog).length === 1 ? true : null)
    const contender = spawnEnsure(project, baseEnv(stateHome, {
      ...common, WT_ARTIFACT_SERVER_TEST_HOLDER_BOUND_MS: '300',
      WT_ARTIFACT_SERVER_TEST_RETRY_WINDOW_MS: '10000',
    }))
    if (!contender.pid) throw new Error('startup contender has no pid')
    const output = childOutput(contender)
    await waitFor(() => /startup claim holder did not finish/i.test(output.stdout()) ? true : null, 5_000)

    await stopChild(holder, 'SIGKILL')
    children.delete(holder)
    const state = await waitForState(stateHome, () => true, 8_000)
    expect((await health(state)).service).toBe('workflow-toolbox-artifact-server')
    expect(spawnReceipts(spawnLog)).toEqual([`${contender.pid} ${port}`])
    expect(output.stdout()).toMatch(/retry attempt 1\/3/i)
    await waitFor(() => /attached.*startup retry/i.test(output.stdout()) ? true : null)
  }, 15_000)

  it('defers retry to a live startup holder instead of racing it', async () => {
    const { project } = projectWithRoots('startup-retry-live-holder')
    const stateHome = temporaryDir('startup-retry-live-holder-state')
    const spawnLog = join(temporaryDir('startup-retry-live-holder-spawns'), 'spawns.log')
    const acquisitionLog = join(temporaryDir('startup-retry-live-holder-acquisitions'), 'acquisitions.log')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const common = {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: spawnLog,
      WT_ARTIFACT_SERVER_TEST_ACQUISITION_LOG: acquisitionLog,
    }
    const holder = spawnEnsure(project, baseEnv(stateHome, {
      ...common, WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '7000',
    }))
    if (!holder.pid) throw new Error('startup claim holder has no pid')
    await waitFor(() => spawnReceipts(acquisitionLog).length === 1 ? true : null)
    const contender = spawnEnsure(project, baseEnv(stateHome, {
      ...common, WT_ARTIFACT_SERVER_TEST_HOLDER_BOUND_MS: '300',
      WT_ARTIFACT_SERVER_TEST_RETRY_WINDOW_MS: '12000',
    }))
    const output = childOutput(contender)
    await waitFor(() => /retry deferred.*live startup claim holder/i.test(output.stdout()) ? true : null, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(spawnReceipts(spawnLog)).toEqual([])
    expect(spawnReceipts(acquisitionLog)).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${holder.pid} `))]))
    expect(spawnReceipts(acquisitionLog)).toHaveLength(1)

    await waitForState(stateHome, () => true, 8_000)
    expect(spawnReceipts(spawnLog)).toEqual([`${holder.pid} ${port}`])
    expect(spawnReceipts(acquisitionLog)).toHaveLength(1)
    await waitFor(() => /attached.*startup retry/i.test(output.stdout()) ? true : null, 5_000)
  }, 18_000)

  it('stops retrying at the attempt budget while retaining registration', async () => {
    const { project } = projectWithRoots('startup-retry-attempt-bound')
    const stateHome = temporaryDir('startup-retry-attempt-bound-state')
    const preloadDir = temporaryDir('startup-retry-attempt-bound-preload')
    const preload = join(preloadDir, 'freeze-server.cjs')
    const frozenLog = join(preloadDir, 'frozen.log')
    const spawnLog = join(preloadDir, 'spawns.log')
    writeFileSync(preload, `if (process.argv[1]?.endsWith('wt-artifact-server.mjs') && process.argv[2] === 'serve') { require('node:fs').appendFileSync(${JSON.stringify(frozenLog)}, JSON.stringify({ pid: process.pid, argv: process.argv }) + '\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000) }\n`)
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const monitor = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: spawnLog,
      WT_ARTIFACT_SERVER_TEST_READINESS_MS: '100', WT_ARTIFACT_SERVER_TEST_RETRY_WINDOW_MS: '600000',
      NODE_OPTIONS: `--require=${preload}`,
    }))
    if (!monitor.pid) throw new Error('startup monitor has no pid')
    const output = childOutput(monitor)

    await waitFor(() => /retry stopped.*3\/3 attempts/i.test(output.stdout()) ? true : null, 12_000)
    const receipts = jsonReceipts<{ pid: number, argv: string[] }>(frozenLog)
    expect(receipts).toHaveLength(4)
    for (const receipt of receipts) {
      expect(receipt.argv).toEqual([process.execPath, SERVER, 'serve'])
      trackDetached(receipt.pid)
    }
    expect(spawnReceipts(spawnLog)).toEqual(Array(4).fill(`${monitor.pid} ${port}`))
    expect(output.stdout().match(/retry attempt [123]\/3/gi)).toHaveLength(3)
    await new Promise((resolve) => setTimeout(resolve, 6_500))
    expect(spawnReceipts(spawnLog)).toHaveLength(4)
    expect(output.stdout().match(/retry stopped/gi)).toHaveLength(1)
    expect(monitor.exitCode).toBeNull()
    expect(readdirSync(registrationsPath(stateHome))).toHaveLength(1)
  }, 22_000)

  it('preserves the retry window while deferring, then serves after the holder dies', async () => {
    const { project } = projectWithRoots('startup-retry-window-bound')
    const stateHome = temporaryDir('startup-retry-window-bound-state')
    const spawnLog = join(temporaryDir('startup-retry-window-bound-spawns'), 'spawns.log')
    const acquisitionLog = join(temporaryDir('startup-retry-window-bound-acquisitions'), 'acquisitions.log')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const common = {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: spawnLog,
      WT_ARTIFACT_SERVER_TEST_ACQUISITION_LOG: acquisitionLog,
    }
    const holder = spawnEnsure(project, baseEnv(stateHome, {
      ...common, WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '30000',
    }))
    if (!holder.pid) throw new Error('startup claim holder has no pid')
    await waitFor(() => spawnReceipts(acquisitionLog).length === 1 ? true : null)
    const contender = spawnEnsure(project, baseEnv(stateHome, {
      ...common, WT_ARTIFACT_SERVER_TEST_HOLDER_BOUND_MS: '300',
      WT_ARTIFACT_SERVER_TEST_RETRY_WINDOW_MS: '3000',
    }))
    const output = childOutput(contender)

    await waitFor(() => /retry deferred/i.test(output.stdout()) ? true : null, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 3_500))
    await stopChild(holder, 'SIGKILL')
    children.delete(holder)

    const state = await waitForState(stateHome, () => true, 8_000)
    expect(spawnReceipts(spawnLog)).toEqual([`${contender.pid} ${port}`])
    expect(output.stdout()).toMatch(/retry attempt 1\/3/i)
    await waitFor(() => /attached.*startup retry/i.test(output.stdout()) ? true : null)
    expect(contender.exitCode).toBeNull()
    expect((await health(state)).registeredSessions).toBe(1)
  }, 18_000)

  it('ends live-holder deferral at the absolute overall cap', async () => {
    const { project } = projectWithRoots('startup-retry-overall-cap')
    const stateHome = temporaryDir('startup-retry-overall-cap-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const holder = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '30000',
    }))
    await waitFor(() => {
      try { return readdirSync(startupClaimPath(stateHome)).length === 1 ? true : null } catch { return null }
    })
    const contender = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_HOLDER_BOUND_MS: '300',
      WT_ARTIFACT_SERVER_TEST_RETRY_WINDOW_MS: '1000', WT_ARTIFACT_SERVER_TEST_RETRY_OVERALL_CAP_MS: '3000',
    }))
    const output = childOutput(contender)

    await waitFor(() => /overall cap reached after 0\/3 attempts and \d+ ms total wait \(cap 3000 ms\)/i.test(output.stdout()) ? true : null, 7_000)
    expect(output.stdout()).not.toMatch(/retry attempt/i)
    expect(contender.exitCode).toBeNull()
    await stopChild(holder)
  }, 10_000)

  it('attaches to a slow healthy server during retry pre-scan without journalling an attempt', async () => {
    const { project } = projectWithRoots('startup-retry-slow-health')
    const stateHome = temporaryDir('startup-retry-slow-health-state')
    const preloadDir = temporaryDir('startup-retry-slow-health-preload')
    const preload = join(preloadDir, 'freeze-server.cjs')
    const frozenLog = join(preloadDir, 'frozen.log')
    writeFileSync(preload, `if (process.argv[1]?.endsWith('wt-artifact-server.mjs') && process.argv[2] === 'serve') { require('node:fs').appendFileSync(${JSON.stringify(frozenLog)}, JSON.stringify({ pid: process.pid }) + '\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000) }\n`)
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const monitor = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_READINESS_MS: '100',
      WT_ARTIFACT_SERVER_TEST_RETRY_WINDOW_MS: '10000', NODE_OPTIONS: `--require=${preload}`,
    }))
    const output = childOutput(monitor)
    await waitFor(() => /did not become ready/i.test(output.stdout()) ? true : null, 5_000)
    const [frozen] = await waitFor(() => {
      const receipts = jsonReceipts<{ pid: number }>(frozenLog)
      return receipts.length === 1 ? receipts : null
    })
    if (!frozen) throw new Error('frozen artifact server receipt is missing')
    trackDetached(frozen.pid)

    const slowHealthy = createServer((_request, response) => {
      setTimeout(() => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ service: 'workflow-toolbox-artifact-server', uid: typeof process.getuid === 'function' ? process.getuid() : userInfo().username }))
      }, 500)
    })
    await new Promise<void>((resolve, reject) => {
      slowHealthy.once('error', reject)
      slowHealthy.listen(port, '127.0.0.1', resolve)
    })
    try {
      await waitFor(() => /attached.*startup retry/i.test(output.stdout()) ? true : null, 5_000)
      expect(output.stdout()).not.toMatch(/retry attempt/i)
    } finally {
      await closeServer(slowHealthy)
    }
  }, 10_000)

  it('journals retry spawn failures and remains bounded and registered', async () => {
    const { project } = projectWithRoots('startup-retry-error')
    const stateHome = temporaryDir('startup-retry-error-state')
    const preloadDir = temporaryDir('startup-retry-error-preload')
    const marker = join(preloadDir, 'fail-spawn')
    const preload = join(preloadDir, 'fail-spawn.cjs')
    writeFileSync(preload, `const cp = require('node:child_process'); const original = cp.spawn; cp.spawn = function(command, args, options) { if (args?.[0]?.endsWith('wt-artifact-server.mjs') && args?.[1] === 'serve' && require('node:fs').existsSync(${JSON.stringify(marker)})) { const child = new (require('node:events').EventEmitter)(); process.nextTick(() => child.emit('error', new Error('forced retry spawn failure'))); return child } return original.call(this, command, args, options) }\n`)
    const acquisitionLog = join(preloadDir, 'acquisitions.log')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const common = {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_ACQUISITION_LOG: acquisitionLog,
      NODE_OPTIONS: `--require=${preload}`,
    }
    const holder = spawnEnsure(project, baseEnv(stateHome, {
      ...common, WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '30000',
    }))
    if (!holder.pid) throw new Error('startup claim holder has no pid')
    await waitFor(() => spawnReceipts(acquisitionLog).length === 1 ? true : null)
    const contender = spawnEnsure(project, baseEnv(stateHome, {
      ...common, WT_ARTIFACT_SERVER_TEST_HOLDER_BOUND_MS: '300',
      WT_ARTIFACT_SERVER_TEST_RETRY_ATTEMPTS: '2', WT_ARTIFACT_SERVER_TEST_RETRY_WINDOW_MS: '30000',
    }))
    const output = childOutput(contender)
    await waitFor(() => /startup claim holder did not finish/i.test(output.stdout()) ? true : null, 5_000)
    writeFileSync(marker, 'fail')
    await stopChild(holder, 'SIGKILL')
    children.delete(holder)

    await waitFor(() => /retry stopped.*2\/2 attempts/i.test(output.stdout()) ? true : null, 9_000)
    expect(output.stdout().match(/retry error.*forced retry spawn failure/gi)).toHaveLength(2)
    await new Promise((resolve) => setTimeout(resolve, 4_500))
    expect(output.stdout().match(/retry attempt/gi)).toHaveLength(2)
    expect(output.stdout().match(/retry stopped/gi)).toHaveLength(1)
    expect(contender.exitCode).toBeNull()
    const registeredPids = readdirSync(registrationsPath(stateHome)).map((file) => {
      return (JSON.parse(readFileSync(join(registrationsPath(stateHome), file), 'utf8')) as { pid: number }).pid
    })
    expect(registeredPids).toContain(contender.pid)
  }, 18_000)

  it('reports a lost claim and preserves its registration and keepalive', async () => {
    const { project } = projectWithRoots('startup-claim-lost')
    const stateHome = temporaryDir('startup-claim-lost-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const holder = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '500',
    }))
    const output = childOutput(holder)
    const claimPath = startupClaimPath(stateHome)
    const ownerFile = await waitFor(() => {
      try { return readdirSync(claimPath)[0] ?? null } catch { return null }
    })
    rmSync(join(claimPath, ownerFile), { force: true })
    rmdirSync(claimPath)
    mkdirSync(claimPath, { mode: 0o700 })
    writeFileSync(join(claimPath, 'replacement.json'), '{}', { mode: 0o600 })

    await waitFor(() => /startup claim was lost/i.test(output.stdout()) ? true : null)
    expect(output.stdout()).not.toMatch(/no available port/i)
    expect(holder.exitCode).toBeNull()
    expect(readdirSync(registrationsPath(stateHome))).toHaveLength(1)
  })

  it('reports shutdown without claiming port exhaustion', async () => {
    const { project } = projectWithRoots('startup-shutdown')
    const stateHome = temporaryDir('startup-shutdown-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const holder = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '30000',
    }))
    const output = childOutput(holder)
    await waitFor(() => {
      try { return readdirSync(startupClaimPath(stateHome)).length === 1 ? true : null } catch { return null }
    })
    holder.kill('SIGTERM')
    await waitFor(() => /startup stopped during shutdown/i.test(output.stdout()) ? true : null)
    expect(output.stdout()).not.toMatch(/no available port/i)
  })

  it('reports a spawned server that was not ready without claiming port exhaustion', async () => {
    const { project } = projectWithRoots('startup-not-ready')
    const stateHome = temporaryDir('startup-not-ready-state')
    const preloadDir = temporaryDir('startup-not-ready-preload')
    const preload = join(preloadDir, 'delay-server.cjs')
    const delayedProcess = join(preloadDir, 'delayed-process.json')
    writeFileSync(preload, `if (process.argv[1]?.endsWith('wt-artifact-server.mjs') && process.argv[2] === 'serve') { require('node:fs').writeFileSync(${JSON.stringify(delayedProcess)}, JSON.stringify({ pid: process.pid, argv: process.argv })); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000) }\n`)
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const holder = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), NODE_OPTIONS: `--require=${preload}`,
      // Keep this legacy assertion isolated from the monitor's later retry spawns.
      WT_ARTIFACT_SERVER_TEST_RETRY_WINDOW_MS: '1',
    }))
    const output = childOutput(holder)
    const delayed = await waitFor(() => {
      try { return JSON.parse(readFileSync(delayedProcess, 'utf8')) as { pid: number, argv: string[] } } catch { return null }
    })
    expect(delayed.argv).toEqual([process.execPath, SERVER, 'serve'])
    trackDetached(delayed.pid)

    await waitFor(() => /did not become ready/i.test(output.stdout()) ? true : null, 12_000)
    expect(output.stdout()).not.toMatch(/no available port/i)
    expect(holder.exitCode).toBeNull()
    expect(readdirSync(registrationsPath(stateHome))).toHaveLength(1)
  }, 15_000)

  it('still reports no available port when candidate ports are occupied', async () => {
    const { project } = projectWithRoots('startup-no-port')
    const stateHome = temporaryDir('startup-no-port-state')
    const foreign = await reservePort()
    try {
      const monitor = spawnEnsure(project, baseEnv(stateHome, {
        WT_ARTIFACT_SERVER_PORT: String(foreign.port), WT_ARTIFACT_SERVER_TEST_PORT_ATTEMPTS: '1',
      }))
      const output = childOutput(monitor)
      await waitFor(() => /no available port/i.test(output.stdout()) ? true : null, 3_000)
      expect(output.stdout()).not.toMatch(/startup claim holder did not finish/i)
    } finally {
      await closeServer(foreign.server)
    }
  })

  it('recovers a startup claim after its holder is killed', async () => {
    const { project } = projectWithRoots('stale-startup-claim')
    const stateHome = temporaryDir('stale-startup-claim-state')
    const spawnLog = join(temporaryDir('stale-startup-claim-log'), 'spawns.log')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const env = baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: spawnLog,
      WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '30000',
    })
    const holder = spawnEnsure(project, env)
    if (!holder.pid) throw new Error('startup claim holder has no pid')
    expect(holder.spawnargs).toEqual([process.execPath, ENSURE])
    await waitFor(() => {
      try {
        const [ownerFile] = readdirSync(startupClaimPath(stateHome))
        if (!ownerFile) return null
        const owner = JSON.parse(readFileSync(join(startupClaimPath(stateHome), ownerFile), 'utf8')) as { pid?: number }
        return owner.pid === holder.pid ? true : null
      } catch { return null }
    })
    const holderExited = new Promise<void>((resolve) => holder.once('exit', () => resolve()))
    holder.kill('SIGKILL')
    await holderExited
    children.delete(holder)

    spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: spawnLog,
    }))
    const state = await waitForState(stateHome)
    expect(state.port).toBe(port)
    expect(spawnReceipts(spawnLog)).toHaveLength(1)
  })

  it('reclaims a live holder that stops heartbeating', async () => {
    const { project } = projectWithRoots('frozen-startup-claim')
    const stateHome = temporaryDir('frozen-startup-claim-state')
    const spawnLog = join(temporaryDir('frozen-startup-claim-spawns'), 'spawns.log')
    const acquisitionLog = join(temporaryDir('frozen-startup-claim-acquisitions'), 'acquisitions.log')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const common = {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_TEST_SPAWN_LOG: spawnLog,
      WT_ARTIFACT_SERVER_TEST_ACQUISITION_LOG: acquisitionLog,
    }
    const holder = spawnEnsure(project, baseEnv(stateHome, {
      ...common, WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS: '20000',
      WT_ARTIFACT_SERVER_TEST_STOP_HEARTBEAT_AFTER_MS: '100',
    }))
    if (!holder.pid) throw new Error('startup claim holder has no pid')
    await waitFor(() => spawnReceipts(acquisitionLog).length === 1 ? true : null)
    spawnEnsure(project, baseEnv(stateHome, common))

    const state = await waitForState(stateHome, () => true, 22_000)
    expect(pidAlive(holder.pid)).toBe(true)
    expect(spawnReceipts(acquisitionLog)).toHaveLength(2)
    expect(spawnReceipts(spawnLog)).toHaveLength(1)
    await stopChild(holder)
    expect(state.port).toBe(port)
  }, 25_000)

  it('[A-02] probes all candidates before starting after a fallback port becomes free', async () => {
    const { project } = projectWithRoots('fallback')
    const stateHome = temporaryDir('fallback-state')
    const foreign = createServer((_request, response) => response.end('foreign'))
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    await new Promise<void>((resolve, reject) => {
      foreign.once('error', reject)
      foreign.listen(port, '127.0.0.1', resolve)
    })
    try {
      const env = baseEnv(stateHome, {
        WT_ARTIFACT_SERVER_PORT: String(port),
        WT_ARTIFACT_SERVER_TEST_READINESS_MS: String(FALLBACK_READINESS_MS),
      })
      spawnEnsure(project, env)
      const state = await waitForState(stateHome, () => true, FALLBACK_DISCOVERY_BOUND_MS)
      expect(state.port).toBe(port + 1)
      expect(foreign.listening).toBe(true)
      await closeServer(foreign)
      spawnEnsure(project, env)
      await waitFor(async () => (await health(state)).registeredSessions === 2 ? true : null)
      expect(readState(stateHome)?.pid).toBe(state.pid)
    } finally {
      if (foreign.listening) await closeServer(foreign)
    }
  }, FALLBACK_DISCOVERY_BOUND_MS + 2_000)

  it('[E-04] refuses uid mismatch attachment and same-process forged stop identity', async () => {
    const stateHome = temporaryDir('mismatch-state')
    const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    children.add(decoy)
    if (!decoy.pid) throw new Error('decoy process has no pid')
    const foreign = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ service: 'workflow-toolbox-artifact-server', version: 'x', uid: 'foreign-user', pid: decoy.pid, port: addressPort, registeredSessions: 0 }))
    })
    let addressPort = 0
    await new Promise<void>((resolve, reject) => {
      foreign.once('error', reject)
      foreign.listen(0, '127.0.0.1', resolve)
    })
    const address = foreign.address()
    if (!address || typeof address === 'string') throw new Error('foreign listener has no port')
    addressPort = address.port
    mkdirSync(join(stateHome, 'wt-artifact-server'), { recursive: true })
    writeFileSync(statePath(stateHome), JSON.stringify({
      version: 'x', pid: decoy.pid, port: address.port, baseUrl: `http://localhost:${address.port}`,
      remoteUrl: null, roots: [], startedAt: new Date().toISOString(),
    }))
    chmodSync(statePath(stateHome), 0o600)
    try {
      const stopped = await runCli(['stop', '--force'], baseEnv(stateHome))
      expect(stopped.code).not.toBe(0)
      expect(stopped.stderr).toMatch(/identity|mismatch/i)
      expect(foreign.listening).toBe(true)

      const { project } = projectWithRoots('uid-mismatch')
      const monitor = spawnEnsure(project, baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(address.port) }))
      const output = childOutput(monitor)
      const own = await waitForState(stateHome, (value) => value.port !== address.port, 30_000)
        .catch(() => readState(stateHome))
      expect(own?.port, `monitor stdout=${output.stdout()} stderr=${output.stderr()}`).not.toBe(address.port)
    } finally {
      await closeServer(foreign)
    }
  }, 40_000)
})

describe('owner decision 3: session lifetime and operator controls', () => {
  it('tolerates a transient discovery miss and uses a bounded removal retry while the server stops', async () => {
    const stateHome = temporaryDir('removed-state-home')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const server = spawn(process.execPath, [SERVER, 'serve'], {
      env: baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port) }),
      stdio: 'ignore',
    })
    children.add(server)
    if (!server.pid) throw new Error('artifact server process has no pid')
    const state = await waitForState(stateHome)
    expect(state.pid).toBe(server.pid)

    const displacedState = `${statePath(stateHome)}.displaced`
    renameSync(statePath(stateHome), displacedState)
    await new Promise((resolve) => setTimeout(resolve, 35))
    renameSync(displacedState, statePath(stateHome))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(pidAlive(server.pid)).toBe(true)

    rmSync(stateHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })

    await waitFor(() => pidAlive(server.pid!) ? null : true, 500)
  })

  it('[V3-idle-registration][V3-last-deregistration] keeps an idle registered session alive past grace and stops immediately after clean removal', async () => {
    const { project } = projectWithRoots('clean-stop')
    const stateHome = temporaryDir('clean-stop-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const monitor = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_IDLE_GRACE_S: '0.5',
    }))
    const state = await waitForState(stateHome)
    await new Promise((resolve) => setTimeout(resolve, 650))
    expect(pidAlive(state.pid)).toBe(true)
    await stopChild(monitor)
    await waitFor(() => pidAlive(state.pid) ? null : true, 300)
  })

  it('[V3-dead-pid-grace] removes a dead registration and stops after grace', async () => {
    const { project } = projectWithRoots('dead-stop')
    const stateHome = temporaryDir('dead-stop-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const monitor = spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_IDLE_GRACE_S: '0.2',
    }))
    const state = await waitForState(stateHome)
    await waitFor(async () => (await health(state)).registeredSessions === 1 ? true : null)
    await stopChild(monitor, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(pidAlive(state.pid)).toBe(true)
    await waitFor(() => pidAlive(state.pid) ? null : true, 2_000)
    expect(readdirSync(registrationsPath(stateHome))).toHaveLength(0)
  })

  it('[V3-stop-refused][V3-force] refuses stop/restart with registrations and allows both with --force', async () => {
    const { project } = projectWithRoots('controls')
    const stateHome = temporaryDir('controls-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const env = baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port) })
    const monitor = spawnEnsure(project, env)
    const first = await waitForState(stateHome)
    await waitFor(async () => (await health(first)).registeredSessions === 1 ? true : null)

    for (const command of ['stop', 'restart']) {
      const refused = spawnSync(process.execPath, [SERVER, command], { encoding: 'utf8', env })
      expect(refused.status, command).not.toBe(0)
      expect(refused.stderr, command).toMatch(/registered session/i)
      expect(pidAlive(first.pid)).toBe(true)
    }

    const restarted = spawnSync(process.execPath, [SERVER, 'restart', '--force'], { encoding: 'utf8', env, timeout: 5_000 })
    expect(restarted.status).toBe(0)
    const second = await waitForState(stateHome, (state) => state.pid !== first.pid)
    expect(second.pid).not.toBe(first.pid)

    const stopped = spawnSync(process.execPath, [SERVER, 'stop', '--force'], { encoding: 'utf8', env, timeout: 5_000 })
    expect(stopped.status).toBe(0)
    await waitFor(() => pidAlive(second.pid) ? null : true)
    await stopChild(monitor)
  })
})

describe('review decisions: filesystem roots and URLs', () => {
  it('[V1] extends a colliding short hash instead of dropping a root', () => {
    const assignments = new Map<string, string>()
    const roots = assignArtifactMounts([
      { name: 'reports', canonical: '/projects/one/reports' },
      { name: 'reports', canonical: '/projects/two/reports' },
      { name: 'reports', canonical: '/projects/three/reports' },
    ], assignments, (canonical: string) => canonical.includes('/two/') ? 'abcdef1' : 'abcdef2')

    expect(roots.map((root: { name: string }) => root.name)).toEqual(['reports', 'reports-abcdef', 'reports-abcdef2'])
    expect(new Set(roots.map((root: { name: string }) => root.name)).size).toBe(3)
  })

  it('[E-01] registers with owner-only per-session files and exposes no HTTP controls', async () => {
    const project = temporaryDir('multi-project')
    const rootA = temporaryDir('root-a')
    const rootB = temporaryDir('root-b')
    writeFileSync(join(rootA, 'a.txt'), 'A')
    writeFileSync(join(rootB, 'b.txt'), 'B')
    const stateHome = temporaryDir('multi-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const common = { WT_ARTIFACT_SERVER_PORT: String(port) }
    spawnEnsure(project, baseEnv(stateHome, { ...common, WT_ARTIFACT_SERVER_ROOTS: `alpha=${rootA}` }))
    spawnEnsure(project, baseEnv(stateHome, { ...common, WT_ARTIFACT_SERVER_ROOTS: `beta=${rootB}` }))
    const state = await waitForState(stateHome, (value) => value.roots.length === 2)
    expect(state.roots.map((root) => root.name).sort()).toEqual(['alpha', 'beta'])
    if (process.platform !== 'win32') expect(statSync(join(stateHome, 'wt-artifact-server')).mode & 0o777).toBe(0o700)
    if (process.platform !== 'win32') expect(statSync(registrationsPath(stateHome)).mode & 0o777).toBe(0o700)
    const registrations = readdirSync(registrationsPath(stateHome))
    expect(registrations).toHaveLength(2)
    if (process.platform !== 'win32') expect(registrations.every((file) => (statSync(join(registrationsPath(stateHome), file)).mode & 0o777) === 0o600)).toBe(true)
    for (const file of registrations) {
      const registration = JSON.parse(readFileSync(join(registrationsPath(stateHome), file), 'utf8')) as Record<string, unknown>
      expect(registration).toEqual(expect.objectContaining({ pid: expect.any(Number), roots: expect.any(Array), deny: expect.any(Array), startedAt: expect.any(String) }))
    }
    expect((await rawRequest(port, '/alpha/a.txt', `localhost:${port}`)).status).toBe(200)
    expect((await rawRequest(port, '/beta/b.txt', `localhost:${port}`)).status).toBe(200)
    expect((await rawRequest(port, '/__wt-artifact-server/register?session=x', `localhost:${port}`)).status).toBe(404)
    expect((await rawRequest(port, '/__wt-artifact-server/deregister?session=x', `localhost:${port}`)).status).toBe(404)
  })

  it('keeps root-index links inside a proxy path while preserving the unprefixed destination', async () => {
    const project = temporaryDir('relative-index-project')
    const root = temporaryDir('relative-index-root')
    const stateHome = temporaryDir('relative-index-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_ROOTS: `reports=${root}`,
    }))
    await waitForState(stateHome, (state) => state.roots.length === 1)

    const proxy = createServer(async (_request, response) => {
      const upstream = await rawRequest(port, '/', `localhost:${port}`)
      response.writeHead(upstream.status, { 'content-type': 'text/html' })
      response.end(upstream.body)
    })
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(0, '127.0.0.1', resolve)
    })
    const proxyAddress = proxy.address()
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('proxy has no TCP port')
    try {
      const index = await rawRequest(proxyAddress.port, '/serve-mount/', `localhost:${proxyAddress.port}`)
      expect(index.status).toBe(200)
      const href = /<a href="([^"]+)">reports\/<\/a>/.exec(index.body)?.[1]
      expect(href).toBe('reports/')
      expect(new URL(href!, `http://localhost:${port}/`).href).toBe(`http://localhost:${port}/reports/`)
      expect(new URL(href!, 'https://host.tailnet.ts.net/serve-mount/').href)
        .toBe('https://host.tailnet.ts.net/serve-mount/reports/')
    } finally {
      await closeServer(proxy)
    }
  })

  it('[A-01] defaults to project-unique reports/worktrees names and chooses the longest URL root', async () => {
    const { project, reports, worktrees } = projectWithRoots('defaults')
    const nestedCwd = join(project, 'packages', 'nested')
    mkdirSync(nestedCwd, { recursive: true })
    const nested = join(reports, 'nested')
    mkdirSync(nested)
    const artifact = join(nested, 'report file.md')
    writeFileSync(artifact, '# Report')
    const stateHome = temporaryDir('defaults-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    spawnEnsure(nestedCwd, baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port), WT_TEST_GIT_ROOT: project }))
    const state = await waitForState(stateHome, (value) => value.roots.length === 2)
    const prefix = basename(project)
    expect(state.roots).toEqual(expect.arrayContaining([
      { name: `${prefix}-reports`, path: reports }, { name: `${prefix}-worktrees`, path: worktrees },
    ]))
    expect(state.roots.some((root) => root.path === process.env.HOME)).toBe(false)

    const env = baseEnv(stateHome)
    expect(artifactUrl(artifact, { env })).toBe(`${state.baseUrl}/${prefix}-reports/nested/report%20file.md`)
    writeFileSync(statePath(stateHome), JSON.stringify({
      ...state, roots: [{ name: 'gone', path: join(project, 'removed-root') }, ...state.roots],
    }))
    expect(artifactUrl(artifact, { env })).toBe(`${state.baseUrl}/${prefix}-reports/nested/report%20file.md`)
    const outside = join(project, 'outside.txt')
    writeFileSync(outside, 'outside')
    const outsideResult = spawnSync(process.execPath, [SERVER, 'url', outside], { encoding: 'utf8', env })
    expect(outsideResult.status).toBe(3)
    const status = spawnSync(process.execPath, [SERVER, 'status'], { encoding: 'utf8', env })
    expect(status.status).toBe(0)
    expect(status.stdout).toContain(`port: ${port}`)
    expect(status.stdout).toContain(`baseUrl: ${state.baseUrl}`)
    expect(status.stdout).toContain('remoteUrl: null')
    expect(status.stdout).toContain(`${prefix}-reports=${reports}`)

    const duplicate = spawnSync(process.execPath, [ENSURE], {
      cwd: project, encoding: 'utf8', timeout: 3_000,
      env: baseEnv(temporaryDir('duplicate-state'), {
        WT_ARTIFACT_SERVER_ROOTS: `same=${reports}${delimiter}same=${worktrees}`,
      }),
    })
    expect(duplicate.status).not.toBe(0)
    expect(duplicate.stderr).toMatch(/duplicate root name/i)
  })

  it('[A-01] lets default roots from different projects coexist', async () => {
    const one = projectWithRoots('coexist-one')
    const two = projectWithRoots('coexist-two')
    writeFileSync(join(one.reports, 'one.txt'), 'one')
    writeFileSync(join(two.reports, 'two.txt'), 'two')
    const stateHome = temporaryDir('coexist-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const env = baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port) })
    spawnEnsure(one.project, env)
    spawnEnsure(two.project, env)
    const state = await waitForState(stateHome, (value) => value.roots.length === 4)
    const oneName = `${basename(one.project)}-reports`
    const twoName = `${basename(two.project)}-reports`
    expect((await rawRequest(port, `/${oneName}/one.txt`, `localhost:${port}`)).status).toBe(200)
    expect((await rawRequest(port, `/${twoName}/two.txt`, `localhost:${port}`)).status).toBe(200)
    expect(state.roots.map((root) => root.name)).toContain(oneName)
    expect(state.roots.map((root) => root.name)).toContain(twoName)
  })

  it('[A-01] adds stable hash suffixes when projects share a basename', async () => {
    const parentOne = temporaryDir('same-name-one')
    const parentTwo = temporaryDir('same-name-two')
    const projectOne = join(parentOne, 'project')
    const projectTwo = join(parentTwo, 'project')
    for (const project of [projectOne, projectTwo]) {
      mkdirSync(join(project, '.claude', 'reports'), { recursive: true })
      mkdirSync(join(project, '.claude', 'worktrees'), { recursive: true })
    }
    const stateHome = temporaryDir('same-name-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const common = { WT_ARTIFACT_SERVER_PORT: String(port) }
    spawnEnsure(projectOne, baseEnv(stateHome, { ...common, WT_TEST_GIT_ROOT: projectOne }))
    spawnEnsure(projectTwo, baseEnv(stateHome, { ...common, WT_TEST_GIT_ROOT: projectTwo }))
    const state = await waitForState(stateHome, (value) => value.roots.length === 4)
    const reportNames = state.roots.filter((root) => root.path.endsWith(join('.claude', 'reports'))).map((root) => root.name)
    expect(reportNames).toHaveLength(2)
    expect(new Set(reportNames).size).toBe(2)
    expect(reportNames).toContain('project-reports')
    expect(reportNames.filter((name) => /^project-reports-[0-9a-f]{6}$/.test(name))).toHaveLength(1)
  })

  it('[V2] keeps first-assigned mount URLs when projects join, leave, and rejoin', async () => {
    const parentOne = temporaryDir('stable-one')
    const parentTwo = temporaryDir('stable-two')
    const projectOne = join(parentOne, 'project')
    const projectTwo = join(parentTwo, 'project')
    for (const project of [projectOne, projectTwo]) mkdirSync(join(project, '.claude', 'reports'), { recursive: true })
    const reportOne = join(projectOne, '.claude', 'reports', 'one.txt')
    const reportTwo = join(projectTwo, '.claude', 'reports', 'two.txt')
    writeFileSync(reportOne, 'one')
    writeFileSync(reportTwo, 'two')
    const stateHome = temporaryDir('stable-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const common = { WT_ARTIFACT_SERVER_PORT: String(port) }
    const monitorOne = spawnEnsure(projectOne, baseEnv(stateHome, { ...common, WT_TEST_GIT_ROOT: projectOne }))
    const first = await waitForState(stateHome, (state) => state.roots.length === 1)
    const firstName = first.roots[0]!.name
    const firstUrl = `${first.baseUrl}/${firstName}/one.txt`

    const monitorTwo = spawnEnsure(projectTwo, baseEnv(stateHome, { ...common, WT_TEST_GIT_ROOT: projectTwo }))
    const joined = await waitForState(stateHome, (state) => state.roots.length === 2)
    const secondName = joined.roots.find((root) => root.path === join(projectTwo, '.claude', 'reports'))?.name
    expect(joined.roots.find((root) => root.path === join(projectOne, '.claude', 'reports'))?.name).toBe(firstName)
    expect(secondName).toBeTruthy()
    expect(secondName).not.toBe(firstName)

    await stopChild(monitorOne)
    const left = await waitForState(stateHome, (state) => state.roots.length === 1 && state.roots[0]?.path === join(projectTwo, '.claude', 'reports'))
    expect(left.roots[0]!.name).toBe(secondName)
    expect(left.mounts).toEqual(expect.arrayContaining([
      { name: firstName, path: join(projectOne, '.claude', 'reports') },
      { name: secondName, path: join(projectTwo, '.claude', 'reports') },
    ]))
    if (process.platform !== 'win32') expect(statSync(statePath(stateHome)).mode & 0o777).toBe(0o600)

    spawnEnsure(projectOne, baseEnv(stateHome, { ...common, WT_TEST_GIT_ROOT: projectOne }))
    const rejoined = await waitForState(stateHome, (state) => state.roots.length === 2)
    expect(rejoined.roots.find((root) => root.path === join(projectOne, '.claude', 'reports'))?.name).toBe(firstName)
    expect(rejoined.roots.find((root) => root.path === join(projectTwo, '.claude', 'reports'))?.name).toBe(secondName)
    expect(artifactUrl(reportOne, { env: baseEnv(stateHome) })).toBe(firstUrl)
    expect((await rawRequest(port, `/${secondName}/two.txt`, `localhost:${port}`)).status).toBe(200)
    await stopChild(monitorTwo)
  })

  it.skipIf(process.platform === 'win32')('[E-01] refuses an insecure or foreign-owned state directory [POSIX mode-bit enforcement]', () => {
    const { project } = projectWithRoots('insecure-state')
    const stateHome = temporaryDir('insecure-state-home')
    const stateDir = join(stateHome, 'wt-artifact-server')
    mkdirSync(stateDir)
    chmodSync(stateDir, 0o777)
    const result = spawnSync(process.execPath, [ENSURE], { cwd: project, encoding: 'utf8', env: baseEnv(stateHome), timeout: 1_500 })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/state directory.*writable|secure/i)
  })
})

describe('owner decision 5: Tailscale access', () => {
  function tailscaleStub(mode: 'present' | 'https' | 'https-path' | 'https-port' | 'hijack' | 'no-tailnet' | 'absent', cwd: string, platform = process.platform) {
    const bin = temporaryDir(`tailscale-${mode}`)
    const serveStatus = mode === 'https'
      ? 'https://host.tailnet.ts.net\n|-- / proxy http://127.0.0.1:${process.env.WT_ARTIFACT_SERVER_PORT}\n'
      : mode === 'https-path'
        ? 'https://host.tailnet.ts.net\n|-- /reports proxy http://127.0.0.1:${process.env.WT_ARTIFACT_SERVER_PORT}\n'
        : mode === 'https-port'
          ? 'https://host.tailnet.ts.net:8443\n|-- / proxy http://127.0.0.1:${process.env.WT_ARTIFACT_SERVER_PORT}\n'
          : mode === 'hijack'
            ? 'https://host.tailnet.ts.net\n|-- / proxy http://127.0.0.1:9999\nhttps://other.tailnet.ts.net\n|-- / proxy http://127.0.0.1:${process.env.WT_ARTIFACT_SERVER_PORT}\n'
            : 'No serve config'
    const source = mode === 'absent'
      ? 'process.exitCode = 1\n'
      : `const command = process.argv.slice(2).join(' '); if (command === 'ip -4') { ${mode === 'no-tailnet' ? '' : "process.stdout.write('127.0.0.1\\n')"} } else if (command === 'status --json') process.stdout.write(JSON.stringify({ Self: { DNSName: 'host.tailnet.ts.net.' } })); else if (command === 'serve status') process.stdout.write(\`${serveStatus}\`); else process.exitCode = 1\n`
    if (platform !== 'win32') {
      const command = commandShim(bin, 'tailscale', source)
      return { bin: realpathSync(bin), env: { WT_ARTIFACT_SERVER_TAILSCALE_BINARY: command } }
    }

    // execFileSync cannot directly execute a .cmd file. Pin Node as the real executable and place
    // its three command scripts in the fixture cwd, preserving the exact tailscale argv shape.
    const failed = 'process.exitCode = 1\n'
    writeFileSync(join(cwd, 'ip'), mode === 'absent' ? failed : mode === 'no-tailnet' ? '' : "process.stdout.write('127.0.0.1\\n')\n")
    writeFileSync(join(cwd, 'status'), mode === 'absent' ? failed : "process.stdout.write(JSON.stringify({ Self: { DNSName: 'host.tailnet.ts.net.' } }))\n")
    writeFileSync(join(cwd, 'serve'), mode === 'absent' ? failed : `process.stdout.write(${JSON.stringify(serveStatus)})\n`)
    return {
      bin: realpathSync(bin),
      env: { WT_ARTIFACT_SERVER_TAILSCALE_BINARY: process.execPath },
    }
  }

  it('parses the URL token from the captured Tailscale Serve header', () => {
    const served = [
      'https://desktop-ug8o6r2.tailc54ed8.ts.net (tailnet only)',
      '|-- /          proxy http://127.0.0.1:47375',
      '|-- /artifacts proxy http://127.0.0.1:48375',
    ].join('\n')

    expect(parseTailscaleServeUrl(served, 'desktop-ug8o6r2.tailc54ed8.ts.net', 48375))
      .toBe('https://desktop-ug8o6r2.tailc54ed8.ts.net/artifacts')
    expect(parseTailscaleServeUrl('https://% invalid\n|-- / proxy http://127.0.0.1:48375', 'desktop-ug8o6r2.tailc54ed8.ts.net', 48375))
      .toBeNull()
  })

  it('runs the Windows Tailscale fixture through a real executable', () => {
    const cwd = temporaryDir('tailscale-windows-executable')
    const { env } = tailscaleStub('present', cwd, 'win32')
    const result = spawnSync(env.WT_ARTIFACT_SERVER_TAILSCALE_BINARY, ['ip', '-4'], {
      cwd, encoding: 'utf8', env: { ...process.env, ...env },
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('127.0.0.1')
  })

  it('[B-02] accepts MagicDNS, rejects an evil Host, and reports the tailnet URL', async () => {
    const { project } = projectWithRoots('tailscale')
    const stateHome = temporaryDir('tailscale-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const { bin, env: tailscaleEnv } = tailscaleStub('present', project)
    spawnEnsure(project, baseEnv(stateHome, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, ...tailscaleEnv, WT_ARTIFACT_SERVER_PORT: String(port),
    }))
    const state = await waitForState(stateHome)
    expect(state.remoteUrl).toBe(`http://127.0.0.1:${port}`)
    expect((await rawRequest(port, '/__wt-artifact-server/health', 'host.tailnet.ts.net')).status).toBe(200)
    expect((await rawRequest(port, '/__wt-artifact-server/health', `127.0.0.1:${port}`, '127.0.0.1')).status).toBe(200)
    expect((await rawRequest(port, '/__wt-artifact-server/register?session=remote&roots=%5B%5D', 'host.tailnet.ts.net')).status).toBe(404)
    const refused = await rawRequest(port, '/__wt-artifact-server/health', 'evil.example')
    expect(refused.status).toBe(421)
    expect(refused.body).toContain('evil.example')
    expect(refused.body).toMatch(/not in the allow-list/i)
    expect(refused.body).not.toContain('host.tailnet.ts.net')
    expect(refused.body).not.toContain('127.0.0.1')
  })

  it('[B-02] sets remoteUrl to null when the stubbed tailscale binary is absent', async () => {
    const { project } = projectWithRoots('no-tailscale')
    const stateHome = temporaryDir('no-tailscale-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const { bin, env: tailscaleEnv } = tailscaleStub('absent', project)
    spawnEnsure(project, baseEnv(stateHome, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, ...tailscaleEnv, WT_ARTIFACT_SERVER_PORT: String(port),
    }))
    const state = await waitForState(stateHome)
    expect(state.remoteUrl).toBeNull()
    expect(state.tailnetDetection).toEqual({ status: 'unavailable', reason: expect.stringMatching(/configured tailscale binary failed after \d+ ms: exit=1/) })
    expect((await rawRequest(port, '/__wt-artifact-server/health', `localhost:${port}`)).status).toBe(200)
    const status = await runCli(['status'], baseEnv(stateHome))
    expect(status.stdout).toMatch(/tailnetDetection: unavailable.*configured tailscale binary failed.*exit=1/i)
  })

  it('reports the configured Tailscale timeout and measured elapsed time', async () => {
    const { project } = projectWithRoots('tailscale-timeout')
    const stateHome = temporaryDir('tailscale-timeout-state')
    const reservation = await reservePort()
    await closeServer(reservation.server)
    writeFileSync(join(project, 'ip'), 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000)\n')
    spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_TAILSCALE_BINARY: process.execPath,
      WT_ARTIFACT_SERVER_PORT: String(reservation.port),
    }))

    const state = await waitForState(stateHome, () => true, 12_000)
    expect(state.tailnetDetection).toEqual({
      status: 'unavailable',
      reason: expect.stringMatching(/configured tailscale binary failed after \d+ ms: exit=none, signal=SIGTERM, code=ETIMEDOUT, timeout=5000ms/),
    })
  }, 15_000)

  it('distinguishes a successful no-tailnet result from a failed lookup', async () => {
    const { project } = projectWithRoots('no-tailnet-result')
    const stateHome = temporaryDir('no-tailnet-result-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const { bin, env: tailscaleEnv } = tailscaleStub('no-tailnet', project)
    spawnEnsure(project, baseEnv(stateHome, { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, ...tailscaleEnv, WT_ARTIFACT_SERVER_PORT: String(port) }))
    const state = await waitForState(stateHome)
    expect(state.remoteUrl).toBeNull()
    expect(state.tailnetDetection).toEqual({ status: 'no-tailnet', reason: 'tailscale reported no IPv4 address' })
  })

  it('[B-02] uses the HTTPS MagicDNS URL only when the stub reports a matching Serve proxy', async () => {
    const { project, reports } = projectWithRoots('tailscale-https')
    const artifact = join(reports, 'phone.md')
    writeFileSync(artifact, '# Phone')
    const stateHome = temporaryDir('tailscale-https-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    const { bin, env: tailscaleEnv } = tailscaleStub('https', project)
    spawnEnsure(project, baseEnv(stateHome, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, ...tailscaleEnv, WT_ARTIFACT_SERVER_PORT: String(port),
    }))
    const state = await waitForState(stateHome, (value) => value.roots.length > 0)
    expect(state.remoteUrl).toBe('https://host.tailnet.ts.net')
    const remote = spawnSync(process.execPath, [SERVER, 'url', artifact, '--remote'], {
      encoding: 'utf8', env: baseEnv(stateHome),
    })
    expect(remote.status).toBe(0)
    expect(remote.stdout.trim()).toBe(`https://host.tailnet.ts.net/${basename(project)}-reports/phone.md`)
  })

  it('includes a path-mounted Serve mapping in the HTTPS artifact URL', async () => {
    const { project } = projectWithRoots('tailscale-https-path')
    const stateHome = temporaryDir('tailscale-https-path-state')
    const reservation = await reservePort()
    await closeServer(reservation.server)
    const { bin, env: tailscaleEnv } = tailscaleStub('https-path', project)
    spawnEnsure(project, baseEnv(stateHome, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, ...tailscaleEnv, WT_ARTIFACT_SERVER_PORT: String(reservation.port),
    }))
    const state = await waitForState(stateHome)
    expect(state.remoteUrl).toBe('https://host.tailnet.ts.net/reports')
  })

  it('preserves a non-default HTTPS port from the Serve mapping', async () => {
    const { project } = projectWithRoots('tailscale-https-port')
    const stateHome = temporaryDir('tailscale-https-port-state')
    const reservation = await reservePort()
    await closeServer(reservation.server)
    const { bin, env: tailscaleEnv } = tailscaleStub('https-port', project)
    spawnEnsure(project, baseEnv(stateHome, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, ...tailscaleEnv, WT_ARTIFACT_SERVER_PORT: String(reservation.port),
    }))
    const state = await waitForState(stateHome)
    expect(state.remoteUrl).toBe('https://host.tailnet.ts.net:8443')
  })

  it('does not claim a MagicDNS name whose mapping belongs to another service', async () => {
    const { project } = projectWithRoots('tailscale-hijack')
    const stateHome = temporaryDir('tailscale-hijack-state')
    const reservation = await reservePort()
    await closeServer(reservation.server)
    const { bin, env: tailscaleEnv } = tailscaleStub('hijack', project)
    spawnEnsure(project, baseEnv(stateHome, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, ...tailscaleEnv, WT_ARTIFACT_SERVER_PORT: String(reservation.port),
    }))
    const state = await waitForState(stateHome)
    expect(state.remoteUrl).toBe(`http://127.0.0.1:${reservation.port}`)
  })

  it.skipIf(process.platform !== 'linux')('resolves the Windows Tailscale executable through WSL interop without an install path guess', async () => {
    const { project } = projectWithRoots('tailscale-wsl')
    const stateHome = temporaryDir('tailscale-wsl-state')
    const bin = temporaryDir('tailscale-wsl-bin')
    const windowsTailscale = join(bin, 'windows-tailscale.exe')
    writeFileSync(windowsTailscale, '#!/bin/sh\nif [ "$1 $2" = "ip -4" ]; then printf "127.0.0.2\\n"; exit 0; fi\nif [ "$1 $2" = "status --json" ]; then printf \'{"Self":{"DNSName":"host.tailnet.ts.net."}}\'; exit 0; fi\nif [ "$1 $2" = "serve status" ]; then printf "No serve config"; exit 0; fi\nexit 1\n')
    writeFileSync(join(bin, 'powershell.exe'), '#!/bin/sh\nprintf "C:\\\\Resolved\\\\tailscale.exe\\r\\n"\n')
    writeFileSync(join(bin, 'wslpath'), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(windowsTailscale)}\n`)
    for (const file of readdirSync(bin)) chmodSync(join(bin, file), 0o755)
    const reservation = await reservePort()
    await closeServer(reservation.server)
    spawnEnsure(project, baseEnv(stateHome, {
      PATH: bin, WT_ARTIFACT_SERVER_TAILSCALE_BINARY: undefined,
      WT_ARTIFACT_SERVER_PORT: String(reservation.port), WT_ARTIFACT_SERVER_TEST_WSL: '1',
    }))
    const state = await waitForState(stateHome)
    expect(state.remoteUrl).toBe(`http://127.0.0.2:${reservation.port}`)
    expect(state.tailnetDetection).toEqual({ status: 'available', reason: null })
  })
})

describe('review decisions: serving security matrix', () => {
  it.skipIf(!CHROME)('runs only marked rich HTML scripts while Chrome blocks fetch and external images', async () => {
    const project = temporaryDir('rich-project')
    const root = temporaryDir('rich-root')
    const stateHome = temporaryDir('rich-state')
    let sinkRequests = 0
    const sink = createServer((_request, response) => { sinkRequests += 1; response.end('reachable') })
    await new Promise<void>((resolve, reject) => {
      sink.once('error', reject)
      sink.listen(0, '127.0.0.1', resolve)
    })
    const sinkAddress = sink.address()
    if (!sinkAddress || typeof sinkAddress === 'string') throw new Error('sink has no port')
    const script = `<script>document.body.dataset.script='ran';Promise.all([fetch('http://127.0.0.1:${sinkAddress.port}/fetch').then(()=>document.body.dataset.fetch='allowed',()=>document.body.dataset.fetch='blocked'),new Promise(resolve=>{const image=new Image();image.onload=()=>{document.body.dataset.image='allowed';resolve()};image.onerror=()=>{document.body.dataset.image='blocked';resolve()};image.src='http://127.0.0.1:${sinkAddress.port}/image'})]).then(()=>document.documentElement.dataset.done='yes')</script>`
    writeFileSync(join(root, 'rich.html'), `<!-- wt-artifact-server: rich --><body data-script="not-run" data-fetch="pending" data-image="pending">${script}</body>`)
    writeFileSync(join(root, 'plain.html'), `<body data-script="not-run">${script}</body>`)
    const reservation = await reservePort()
    await closeServer(reservation.server)
    try {
      spawnEnsure(project, baseEnv(stateHome, {
        WT_ARTIFACT_SERVER_PORT: String(reservation.port), WT_ARTIFACT_SERVER_ROOTS: `artifacts=${root}`,
      }))
      await waitForState(stateHome, (state) => state.roots.length === 1)
      const rich = await renderInChrome(`http://localhost:${reservation.port}/artifacts/rich.html`)
      const plain = await renderInChrome(`http://localhost:${reservation.port}/artifacts/plain.html`)
      expect(rich.code, rich.stderr).toBe(0)
      expect(rich.stdout).toContain('data-script="ran"')
      expect(rich.stdout).toContain('data-fetch="blocked"')
      expect(rich.stdout).toContain('data-image="blocked"')
      expect(rich.stdout).toContain('data-done="yes"')
      expect(plain.code, plain.stderr).toBe(0)
      expect(plain.stdout).toContain('data-script="not-run"')
      expect(plain.stdout).not.toContain('data-script="ran"')
      expect(sinkRequests).toBe(0)
    } finally {
      await closeServer(sink)
    }
  }, 20_000)

  it('[B-02][E-02][E-03] serves each type with CSP and rejects aliases, traversal, hosts, and methods', async () => {
    const project = temporaryDir('security-project')
    const root = temporaryDir('security-root')
    const outside = temporaryDir('security-outside')
    writeFileSync(join(root, 'report.md'), [
      '# Report',
      '',
      '| Method | Signature | Notes |',
      ':--- | :---: | ---:',
      '| `notice` | `left|right` | **bold** and [docs](https://example.com?a=1&b=2) |',
      '| escaped | left \\| right | <b>raw</b> |',
      '',
      'prose | remains',
      'not a separator',
      '',
      '<script>alert(1)</script>',
    ].join('\n'))
    mkdirSync(join(root, 'index'))
    writeFileSync(join(root, 'index', '&script;.txt'), 'index')
    writeFileSync(join(root, 'plain.txt'), '<b>text</b>')
    writeFileSync(join(root, 'events.log'), 'event')
    writeFileSync(join(root, 'data.json'), '{"ok":true}')
    writeFileSync(join(root, 'active.html'), '<script>top.location="https://evil.example"</script>')
    writeFileSync(join(root, 'active.svg'), '<svg><script>alert(1)</script></svg>')
    writeFileSync(join(root, 'blob.bin'), 'blob')
    writeFileSync(join(root, '.env'), 'secret')
    writeFileSync(join(root, '.ENV.PROD'), 'secret')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'config'), 'secret')
    writeFileSync(join(root, 'id_ed25519.pub'), 'secret')
    symlinkSync(join(root, '.git'), join(root, 'git-alias'))
    symlinkSync(join(root, '.ENV.PROD'), join(root, 'env-alias'))
    symlinkSync(join(root, 'id_ed25519.pub'), join(root, 'key-alias'))
    writeFileSync(join(outside, 'outside.txt'), 'secret')
    symlinkSync(join(outside, 'outside.txt'), join(root, 'escape.txt'))
    const stateHome = temporaryDir('security-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_ROOTS: `artifacts=${root}`,
    }))
    await waitForState(stateHome, (state) => state.roots.some((entry) => entry.name === 'artifacts'))

    const markdown = await rawRequest(port, '/artifacts/report.md', `localhost:${port}`)
    expect(markdown.status).toBe(200)
    expect(markdown.body).toContain('&lt;script&gt;')
    expect(markdown.body).not.toContain('<script>')
    expect(markdown.body.match(/<t[hd]>/g)).toHaveLength(9)
    expect(markdown.body).toContain('<div class="table-scroll"><table>')
    expect(markdown.body).toContain('<code>left|right</code>')
    expect(markdown.body).toContain('<td>left | right</td>')
    expect(markdown.body).toContain('<strong>bold</strong> and <a href="https://example.com?a=1&amp;b=2">docs</a>')
    expect(markdown.body).toContain('&lt;b&gt;raw&lt;/b&gt;')
    expect(markdown.body).not.toContain('&amp;lt;b&amp;gt;')
    expect(markdown.body).toContain('<p>prose | remains not a separator</p>')
    expect(markdown.body).toMatch(/\.table-scroll\{[^}]*overflow-x:auto/)
    expect(markdown.headers['content-security-policy']).toMatch(/default-src 'none'/)
    for (const file of ['plain.txt', 'events.log', 'data.json']) {
      const response = await rawRequest(port, `/artifacts/${file}`, `localhost:${port}`)
      expect(response.status, file).toBe(200)
      expect(response.headers['content-type'], file).toMatch(/^text\/html/)
      expect(response.headers['content-security-policy'], file).toMatch(/default-src 'none'/)
    }
    for (const file of ['active.html', 'active.svg', 'blob.bin']) {
      const response = await rawRequest(port, `/artifacts/${file}`, `localhost:${port}`)
      expect(response.status, file).toBe(200)
      expect(response.headers['content-security-policy'], file).toBe("sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
      expect(response.headers['x-content-type-options'], file).toBe('nosniff')
    }
    const index = await rawRequest(port, '/artifacts/index/', `localhost:${port}`)
    expect(index.status).toBe(200)
    expect(index.body).toContain('&amp;script;.txt')
    expect(index.body).not.toContain('<script>')
    expect(index.headers['content-security-policy']).toMatch(/default-src 'none'/)
    const head = await rawRequest(port, '/artifacts/report.md', `localhost:${port}`, '127.0.0.1', 'HEAD')
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0)
    for (const file of ['.env', '.ENV.PROD', 'id_ed25519.pub', 'git-alias/config', 'env-alias', 'key-alias']) {
      expect((await rawRequest(port, `/artifacts/${file}`, `localhost:${port}`)).status, file).toBe(403)
    }
    expect((await rawRequest(port, '/artifacts/escape.txt', `localhost:${port}`)).status).toBe(403)
    for (const target of [
      '/artifacts/../outside.txt', '/artifacts/%2e%2e/outside.txt', '/artifacts/%252e%252e/outside.txt',
      '/artifacts/%2e%2e%2foutside.txt', '/artifacts/..%5coutside.txt', '/artifacts/%00.txt',
    ]) expect([403, 404]).toContain((await rawRequest(port, target, `localhost:${port}`)).status)
    expect((await rawRequest(port, '/artifacts/report.md', `localhost.evil.com:${port}`)).status).toBe(421)
    expect((await rawRequest(port, '/artifacts/report.md', '[::1]')).status).toBe(421)
    expect([400, 421]).toContain((await rawRequest(port, '/artifacts/report.md')).status)
    const post = await fetch(`http://127.0.0.1:${port}/artifacts/report.md`, {
      method: 'POST', headers: { Host: `localhost:${port}` },
    })
    expect(post.status).toBe(405)
    expect(post.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('[E-01][E-02] pins canonical roots and applies deny policy per registration', async () => {
    const project = temporaryDir('pin-project')
    const rootA = temporaryDir('policy-a')
    const rootB = temporaryDir('policy-b')
    writeFileSync(join(rootA, 'blocked-a'), 'a')
    writeFileSync(join(rootA, 'blocked-b'), 'a')
    writeFileSync(join(rootB, 'blocked-a'), 'b')
    writeFileSync(join(rootB, 'blocked-b'), 'b')
    const stateHome = temporaryDir('pin-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_ROOTS: `a=${rootA}`, WT_ARTIFACT_SERVER_DENY: 'blocked-a',
    }))
    spawnEnsure(project, baseEnv(stateHome, {
      WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_ROOTS: `b=${rootB}`, WT_ARTIFACT_SERVER_DENY: 'blocked-b',
    }))
    await waitForState(stateHome, (state) => state.roots.length === 2)
    expect((await rawRequest(port, '/a/blocked-a', `localhost:${port}`)).status).toBe(403)
    expect((await rawRequest(port, '/a/blocked-b', `localhost:${port}`)).status).toBe(200)
    expect((await rawRequest(port, '/b/blocked-a', `localhost:${port}`)).status).toBe(200)
    expect((await rawRequest(port, '/b/blocked-b', `localhost:${port}`)).status).toBe(403)

    const moved = `${rootA}-moved`
    renameSync(rootA, moved)
    symlinkSync(rootB, rootA)
    expect((await rawRequest(port, '/a/blocked-b', `localhost:${port}`)).status).toBe(403)
  })

  it('[E-02] rejects a root whose own canonical basename is denied', async () => {
    const project = temporaryDir('denied-root-project')
    const parent = temporaryDir('denied-root-parent')
    const root = join(parent, '.git')
    mkdirSync(root)
    writeFileSync(join(root, 'config'), 'secret')
    const stateHome = temporaryDir('denied-root-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    spawnEnsure(project, baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port), WT_ARTIFACT_SERVER_ROOTS: `hidden=${root}` }))
    await waitForState(stateHome, (state) => state.roots.length === 1)
    expect((await rawRequest(port, '/hidden/config', `localhost:${port}`)).status).toBe(403)
  })

  it('[MISSED] returns 400 for malformed URLs and survives handler exceptions', async () => {
    const { project } = projectWithRoots('malformed')
    const stateHome = temporaryDir('malformed-state')
    const reservation = await reservePort()
    const port = reservation.port
    await closeServer(reservation.server)
    spawnEnsure(project, baseEnv(stateHome, { WT_ARTIFACT_SERVER_PORT: String(port) }))
    await waitForState(stateHome)
    expect((await rawRequest(port, '//[', `localhost:${port}`)).status).toBe(400)
    expect((await rawRequest(port, '/__wt-artifact-server/health', `localhost:${port}`)).status).toBe(200)
  })

  it('[V4] returns null for discovery that differs from a live state only by a dead PID', () => {
    const artifact = join(temporaryDir('discovery-file'), 'report.md')
    writeFileSync(artifact, '# report')
    const stateHome = temporaryDir('discovery-absent')
    const env = baseEnv(stateHome)
    expect(artifactUrl(artifact, { env })).toBeNull()
    const absent = spawnSync(process.execPath, [SERVER, 'url', artifact], { encoding: 'utf8', env })
    expect(absent.status).toBe(3)
    mkdirSync(join(stateHome, 'wt-artifact-server'), { recursive: true })
    const discovery = {
      version: 'x', pid: process.pid, port: 48_001, baseUrl: 'http://localhost:48001', remoteUrl: null,
      roots: [{ name: 'reports', path: join(artifact, '..') }], startedAt: new Date().toISOString(),
    }
    writeFileSync(statePath(stateHome), JSON.stringify(discovery), { mode: 0o600 })
    chmodSync(statePath(stateHome), 0o600)
    expect(artifactUrl(artifact, { env })).toBe('http://localhost:48001/reports/report.md')
    writeFileSync(statePath(stateHome), JSON.stringify({ ...discovery, pid: 999_999 }))
    expect(artifactUrl(artifact, { env })).toBeNull()
    const stale = spawnSync(process.execPath, [SERVER, 'url', artifact], { encoding: 'utf8', env })
    expect(stale.status).toBe(3)
  })
})
