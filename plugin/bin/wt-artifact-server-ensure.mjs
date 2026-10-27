#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ARTIFACT_PORT_ATTEMPTS,
  ARTIFACT_SERVER_VERSION,
  artifactRegistrationsDir,
  artifactServerProcessIdentity,
  artifactServerProcessStatus,
  artifactStartupClaimPath,
  atomicWriteJson,
  configuredArtifactPort,
  configuredDenyPatterns,
  configuredRoots,
  ensureSecureStateDir,
  pidAlive,
  probeArtifactServer,
} from './lib/artifact-server.mjs'
import { handleHelpFlag } from './lib/cli-help.mjs'
import { resolveWorkflowToolboxOption } from './lib/plugin-options.mjs'

const HELP = `wt-artifact-server-ensure - register this session with the shared artifact server

Usage:
  wt-artifact-server-ensure

The monitor starts or attaches by default. Set WT_ARTIFACT_SERVER=0 to disable it.
WT_ARTIFACT_SERVER_PORT overrides the per-user candidate port; WT_ARTIFACT_SERVER_ROOTS
is a path-delimited list of name=path or bare-path roots.

Options:
  --help, -h  print this text and exit 0
`

const session = `${process.pid}-${randomUUID()}`
const parentPid = process.ppid
let stopping = false
let upgradeNoticed = false
let registrationFile = null
let startupClaim = null
let finish
const finished = new Promise((resolve) => { finish = resolve })
const STARTUP_CLAIM_STALE_MS = 15_000
const SERVER_READINESS_MS = 5_000
const RETRY_ATTEMPTS = 3
const RETRY_WINDOW_MS = 60_000
const RETRY_OVERALL_CAP_MS = 5 * 60_000
const WATCH_INTERVAL_MS = 10_000
const TEST_MODE = process.env.WT_ARTIFACT_SERVER_TEST_MODE === '1'
const TEST_CONTROL_NAMES = [
  'WT_ARTIFACT_SERVER_TEST_MODE',
  'WT_ARTIFACT_SERVER_TEST_CLAIM_STALE_MS',
  'WT_ARTIFACT_SERVER_TEST_PORT_ATTEMPTS',
  'WT_ARTIFACT_SERVER_TEST_HOLDER_BOUND_MS',
  'WT_ARTIFACT_SERVER_TEST_READINESS_MS',
  'WT_ARTIFACT_SERVER_TEST_RETRY_ATTEMPTS',
  'WT_ARTIFACT_SERVER_TEST_RETRY_WINDOW_MS',
  'WT_ARTIFACT_SERVER_TEST_RETRY_OVERALL_CAP_MS',
  'WT_ARTIFACT_SERVER_TEST_WATCH_MS',
  'WT_ARTIFACT_SERVER_TEST_ATTACHMENT_LOG',
  'WT_ARTIFACT_SERVER_TEST_SPAWN_LOG',
  'WT_ARTIFACT_SERVER_TEST_SERVER_PROCESS_LOG',
  'WT_ARTIFACT_SERVER_TEST_ACQUISITION_LOG',
  'WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS',
  'WT_ARTIFACT_SERVER_TEST_STOP_HEARTBEAT_AFTER_MS',
  'WT_ARTIFACT_SERVER_TEST_CONTENTION_LOG',
  'WT_ARTIFACT_SERVER_TEST_GIT_ROOT',
  'WT_ARTIFACT_SERVER_TEST_SHUTDOWN_FILE',
  'WT_ARTIFACT_SERVER_TEST_SWEEP_DIAGNOSTIC',
]
const TEST_SEAMS_ACTIVE = new Set(TEST_MODE ? TEST_CONTROL_NAMES.filter((name) => process.env[name] !== undefined) : [])

function startupClaimStaleMs() {
  const override = TEST_MODE ? Number(process.env.WT_ARTIFACT_SERVER_TEST_CLAIM_STALE_MS) : NaN
  return Number.isFinite(override) && override >= STARTUP_CLAIM_STALE_MS ? override : STARTUP_CLAIM_STALE_MS
}

function testLog(name, line) {
  if (!TEST_MODE) return
  const destination = process.env[name]
  if (destination) appendFileSync(destination, `${line}\n`)
}

function portAttempts() {
  const override = TEST_MODE ? Number(process.env.WT_ARTIFACT_SERVER_TEST_PORT_ATTEMPTS) : NaN
  return Number.isInteger(override) && override > 0 ? override : ARTIFACT_PORT_ATTEMPTS
}

function holderWorkBoundMs() {
  const override = TEST_MODE ? Number(process.env.WT_ARTIFACT_SERVER_TEST_HOLDER_BOUND_MS) : NaN
  if (Number.isFinite(override) && override > 0) return override
  return portAttempts() * 750 + serverReadinessMs() + portAttempts() * 250 + 2_000
}

function serverReadinessMs() {
  const override = TEST_MODE ? Number(process.env.WT_ARTIFACT_SERVER_TEST_READINESS_MS) : NaN
  return Number.isFinite(override) && override > 0 ? override : SERVER_READINESS_MS
}

function retryAttempts() {
  const override = TEST_MODE ? Number(process.env.WT_ARTIFACT_SERVER_TEST_RETRY_ATTEMPTS) : NaN
  return Number.isInteger(override) && override > 0 ? override : RETRY_ATTEMPTS
}

function retryWindowMs() {
  const override = TEST_MODE ? Number(process.env.WT_ARTIFACT_SERVER_TEST_RETRY_WINDOW_MS) : NaN
  return Number.isFinite(override) && override > 0 ? override : RETRY_WINDOW_MS
}

function retryOverallCapMs() {
  const override = TEST_MODE ? Number(process.env.WT_ARTIFACT_SERVER_TEST_RETRY_OVERALL_CAP_MS) : NaN
  return Number.isFinite(override) && override > 0 ? override : RETRY_OVERALL_CAP_MS
}

function watchIntervalMs() {
  const override = TEST_MODE ? Number(process.env.WT_ARTIFACT_SERVER_TEST_WATCH_MS) : NaN
  return Number.isFinite(override) && override > 0 ? override : WATCH_INTERVAL_MS
}

async function spawnServer(port, claim) {
  const script = fileURLToPath(new URL('./wt-artifact-server.mjs', import.meta.url))
  const heartbeat = setInterval(() => claim.heartbeat(), 250)
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, 'serve'], {
        // The server is shared and outlives this session: never pin the session's project as its cwd
        // (Windows refuses to delete a live process's cwd). Its own state directory is what it owns.
        cwd: ensureSecureStateDir(),
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, WT_ARTIFACT_SERVER_PORT: String(port) },
      })
      child.once('error', reject)
      child.once('spawn', () => {
        testLog('WT_ARTIFACT_SERVER_TEST_SPAWN_LOG', `${process.pid} ${port}`)
        testLog('WT_ARTIFACT_SERVER_TEST_SERVER_PROCESS_LOG', `${child.pid}`)
        child.unref()
        resolve()
      })
    })
  } finally {
    clearInterval(heartbeat)
  }
}

function startupClaimIsStale(claimPath) {
  let stale = false
  try {
    const files = readdirSync(claimPath)
    if (files.length === 1) {
      const staleOwnerPath = path.join(claimPath, files[0])
      const owner = JSON.parse(readFileSync(staleOwnerPath, 'utf8'))
      const expectedToken = files[0].endsWith('.json') ? files[0].slice(0, -5) : null
      if (typeof owner?.token !== 'string' || owner.token !== expectedToken) throw new Error('invalid startup claim owner')
      stale = !pidAlive(owner.pid) || Date.now() - statSync(staleOwnerPath).mtimeMs > startupClaimStaleMs()
    } else {
      stale = Date.now() - statSync(claimPath).mtimeMs > startupClaimStaleMs()
    }
  } catch {
    try { stale = Date.now() - statSync(claimPath).mtimeMs > startupClaimStaleMs() } catch { /* Inaccessible claims remain live. */ }
  }
  return stale
}

function liveStartupClaimHolder() {
  const claimPath = artifactStartupClaimPath()
  try {
    statSync(claimPath)
  } catch (error) {
    return error?.code !== 'ENOENT'
  }
  return !startupClaimIsStale(claimPath)
}

function startupClaimCreator(claimPath, token) {
  const ownerPath = path.join(claimPath, `${token}.json`)
  const createdAt = Date.now()
  let released = false
  const heartbeat = () => {
    if (released) return false
    try {
      const now = new Date()
      utimesSync(ownerPath, now, now)
      return true
    } catch {
      released = true
      return false
    }
  }
  const release = () => {
    if (released) return
    released = true
    try {
      unlinkSync(ownerPath)
    } catch { /* Already absent or unavailable. */ }
    try { rmdirSync(claimPath) } catch { /* Another owner may hold the claim. */ }
  }
  return () => {
    mkdirSync(claimPath, { mode: 0o700 })
    try {
      atomicWriteJson(ownerPath, { pid: process.pid, token, createdAt, heartbeatAt: Date.now() })
      testLog('WT_ARTIFACT_SERVER_TEST_ACQUISITION_LOG', `${process.pid} ${token}`)
      return { heartbeat, release }
    } catch (error) {
      try { unlinkSync(ownerPath) } catch { /* Preserve the publication error. */ }
      try { rmdirSync(claimPath) } catch { /* Preserve the publication error. */ }
      throw error
    }
  }
}

function initialStartupClaim(create) {
  try {
    return create()
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOENT') throw error
    if (error?.code === 'ENOENT') return null
  }
}

function displaceStartupClaim(claimPath, displacedPath) {
  try {
    renameSync(claimPath, displacedPath)
    return true
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOENT' || error?.code === 'ENOTEMPTY') return false
    throw error
  }
}

function acquireStartupClaim() {
  const claimPath = artifactStartupClaimPath()
  const token = randomUUID()
  const create = startupClaimCreator(claimPath, token)
  const initial = initialStartupClaim(create)
  if (initial !== undefined) return initial
  const stale = startupClaimIsStale(claimPath)
  if (!stale) return null
  const displacedPath = `${claimPath}.stale-${token}`
  if (!displaceStartupClaim(claimPath, displacedPath)) return null
  try {
    return create()
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOENT') return null
    throw error
  } finally {
    rmSync(displacedPath, { recursive: true, force: true })
  }
}

async function probeCandidates(firstPort, timeout, claim = null, deadline = null) {
  let firstFree = null
  let uncertain = false
  const attempts = portAttempts()
  for (let offset = 0; offset < attempts && firstPort + offset <= 65535; offset += 1) {
    const interrupted = candidateScanInterruption(firstFree, claim, deadline)
    if (interrupted) return interrupted
    const port = firstPort + offset
    const probeTimeout = candidateProbeTimeout(timeout, deadline)
    const probe = await probeArtifactServer(port, probeTimeout)
    if (probe.kind === 'ours') return { firstFree, found: { port, health: probe.health }, claimLost: false, timedOut: false }
    if (probe.kind === 'free' && firstFree === null) firstFree = port
    if (probe.kind === 'unknown') uncertain = true
  }
  return { firstFree, found: null, claimLost: false, timedOut: false, uncertain }
}

function candidateScanInterruption(firstFree, claim, deadline) {
  if (deadline !== null && Date.now() >= deadline) return { firstFree, found: null, claimLost: false, timedOut: true }
  if (claim && !claim.heartbeat()) return { firstFree: null, found: null, claimLost: true, timedOut: false }
  return null
}

function candidateProbeTimeout(timeout, deadline) {
  return deadline === null ? timeout : Math.max(1, Math.min(timeout, deadline - Date.now()))
}

async function holdClaimForTest(claim) {
  if (!TEST_MODE) return
  const holdMs = Number(process.env.WT_ARTIFACT_SERVER_TEST_CLAIM_HOLD_MS ?? 0)
  if (!Number.isFinite(holdMs) || holdMs <= 0) return
  const startedAt = Date.now()
  const stopHeartbeatAfterMs = Number(process.env.WT_ARTIFACT_SERVER_TEST_STOP_HEARTBEAT_AFTER_MS)
  const deadline = Date.now() + holdMs
  while (!stopping && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - Date.now())))
    const shutdownFile = process.env.WT_ARTIFACT_SERVER_TEST_SHUTDOWN_FILE
    if (shutdownFile && existsSync(shutdownFile)) cleanExit()
    heartbeatDuringTestHold(claim, startedAt, stopHeartbeatAfterMs)
  }
}

function heartbeatDuringTestHold(claim, startedAt, stopHeartbeatAfterMs) {
  if (!stopping && (!Number.isFinite(stopHeartbeatAfterMs) || Date.now() - startedAt < stopHeartbeatAfterMs)) claim.heartbeat()
}

function compareVersions(left, right) {
  const a = String(left).split('.').map(Number)
  const b = String(right).split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}

async function discoverOrStart(firstPort) {
  let contentionDeadline = null
  while (!stopping) {
    const scan = await probeCandidates(firstPort, 750, null, contentionDeadline)
    const discovered = initialDiscoveryResult(scan)
    if (discovered) return discovered
    const claim = acquireStartupClaim()
    if (!claim) {
      testLog('WT_ARTIFACT_SERVER_TEST_CONTENTION_LOG', `${process.pid}`)
      contentionDeadline = nextContentionDeadline(contentionDeadline)
      if (Date.now() >= contentionDeadline) return { kind: 'contended' }
      await new Promise((resolve) => setTimeout(resolve, 50))
      continue
    }
    startupClaim = claim
    try {
      await holdClaimForTest(claim)
      if (stopping) return { kind: 'shutdown' }
      const confirmed = await probeCandidates(firstPort, 750, claim)
      const confirmation = confirmedStartupResult(confirmed)
      if (confirmation) return confirmation
      await spawnServer(confirmed.firstFree, claim)
      const spawned = serverSpawnResult(claim)
      if (spawned) return spawned
      const serverDeadline = Date.now() + serverReadinessMs()
      while (Date.now() < serverDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        const ready = await probeCandidates(firstPort, 250, claim)
        const readiness = serverReadinessResult(ready)
        if (readiness) return readiness
      }
      return serverReadinessTimeout()
    } finally {
      releaseMonitorStartupClaim(claim)
    }
  }
  return { kind: 'shutdown' }
}

function initialDiscoveryResult(scan) {
  if (stopping) return { kind: 'shutdown' }
  if (scan.timedOut) return { kind: 'contended' }
  if (scan.found) return { kind: 'found', ...scan.found }
  if (scan.firstFree === null) return unavailableCandidateResult(scan)
  return null
}

function unavailableCandidateResult(scan) {
  if (scan.uncertain) return { kind: 'contended' }
  return { kind: 'exhausted' }
}

function nextContentionDeadline(deadline) {
  return deadline ?? Date.now() + holderWorkBoundMs()
}

function confirmedStartupResult(confirmed) {
  const ready = serverReadinessResult(confirmed)
  if (ready) return ready
  if (confirmed.firstFree === null) return { kind: 'exhausted' }
  return null
}

function serverSpawnResult(claim) {
  if (stopping) return { kind: 'shutdown' }
  if (!claim.heartbeat()) return { kind: 'claim-lost' }
  return null
}

function serverReadinessResult(ready) {
  if (stopping) return { kind: 'shutdown' }
  if (ready.found) return { kind: 'found', ...ready.found }
  if (ready.claimLost) return { kind: 'claim-lost' }
  return null
}

function serverReadinessTimeout() {
  return { kind: stopping ? 'shutdown' : 'not-ready' }
}

function releaseMonitorStartupClaim(claim) {
  claim.release()
  if (startupClaim === claim) startupClaim = null
}

function removeRegistration() {
  if (registrationFile) rmSync(registrationFile, { force: true })
}

function cleanExit() {
  if (stopping) return
  stopping = true
  startupClaim?.release()
  startupClaim = null
  removeRegistration()
  finish()
}

async function waitForAttachedServerExit(processes) {
  const deadline = Date.now() + 3_000
  let pending = pendingAttachedProcesses(processes)
  while (!stopping && pending.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    pending = pendingAttachedProcesses(processes)
  }
  if (pending.length === 0) return true
  if (!stopping) for (const { pid, evidence } of pending) {
    const reason = evidence.reason ? ` (${evidence.reason})` : ''
    process.stdout.write(`ARTIFACT SERVER RESTART DEFERRED: PID ${pid ?? 'unknown'} is ${evidence.status}${reason} after 3000 ms; no replacement started; registration retained.\n`)
  }
  return false
}

function pendingAttachedProcesses(processes) {
  const pending = []
  for (const [pid, identity] of processes) {
    const evidence = artifactServerProcessStatus(pid, undefined, identity)
    if (evidence.status === 'gone') processes.delete(pid)
    else pending.push({ pid, evidence })
  }
  return pending
}

async function watchAttachedServer(state, firstPort) {
  pendingAttachedProcesses(state.attachedProcesses)
  const attached = state.attachedServer
  const direct = await probeArtifactServer(attached.port, 750)
  if (stopping) return attached
  if (direct.kind === 'ours') return { port: attached.port, health: direct.health }
  const scan = await probeCandidates(firstPort, 750)
  if (stopping) return attached
  if (scan.found) return scan.found
  return await waitForAttachedServerExit(state.attachedProcesses) ? null : attached
}

function startRetry(kind) {
  const startedAt = Date.now()
  return {
    kind, startedAt, attemptDeadline: startedAt + retryWindowMs(),
    overallCapMs: retryOverallCapMs(), maxAttempts: retryAttempts(),
    attempts: 0, deferred: false, deferredAt: kind === 'contended' ? startedAt : null,
  }
}

function createMonitorState(result) {
  const state = {
    pendingRetry: null, retryInFlight: false, watchInFlight: false,
    attachedServer: result.kind === 'found' ? result : null, lastWatchAt: Date.now(),
    attachedProcesses: new Map(),
  }
  if (state.attachedServer !== null) {
    rememberAttachedProcess(state)
    testLog('WT_ARTIFACT_SERVER_TEST_ATTACHMENT_LOG', `${process.pid} ${state.attachedServer.port}`)
  }
  return state
}

function rememberAttachedProcess(state) {
  const pid = state.attachedServer.health?.pid
  if (!state.attachedProcesses.has(pid)) state.attachedProcesses.set(pid, artifactServerProcessIdentity(pid))
}

function noticeArtifactUpgrade(result) {
  if (!upgradeNoticed && typeof result.health.version === 'string' && compareVersions(ARTIFACT_SERVER_VERSION, result.health.version) > 0) {
    process.stdout.write(`artifact server v${result.health.version} is older than plugin v${ARTIFACT_SERVER_VERSION}; run \`node wt-artifact-server.mjs restart\` when sessions can disconnect.\n`)
    upgradeNoticed = true
  }
}

function reportInitialResult(result, state, firstPort) {
  if (result.kind === 'exhausted') {
    process.stdout.write(`ARTIFACT SERVER NOT STARTED: no available port in ${firstPort}-${Math.min(firstPort + portAttempts() - 1, 65535)}\n`)
    return false
  }
  if (result.kind === 'contended') {
    process.stdout.write(`ARTIFACT SERVER STARTUP PENDING: startup claim holder did not finish within ${holderWorkBoundMs()} ms; registration retained.\n`)
    state.pendingRetry = startRetry(result.kind)
  } else if (result.kind === 'claim-lost') {
    process.stdout.write('ARTIFACT SERVER STARTUP PENDING: startup claim was lost; registration retained.\n')
    state.pendingRetry = startRetry(result.kind)
  } else if (result.kind === 'shutdown') {
    process.stdout.write('ARTIFACT SERVER NOT STARTED: startup stopped during shutdown.\n')
  } else if (result.kind === 'not-ready') {
    process.stdout.write(`ARTIFACT SERVER STARTUP PENDING: spawned server did not become ready within ${serverReadinessMs()} ms; registration retained.\n`)
    state.pendingRetry = startRetry(result.kind)
  } else {
    noticeArtifactUpgrade(result)
  }
  return true
}

function attachMonitor(state, found) {
  process.stdout.write(`ARTIFACT SERVER ATTACHED: discovered server on port ${found.port} during startup retry.\n`)
  state.attachedServer = found
  recordMonitorAttachment(state)
}

function recordMonitorAttachment(state) {
  rememberAttachedProcess(state)
  testLog('WT_ARTIFACT_SERVER_TEST_ATTACHMENT_LOG', `${process.pid} ${state.attachedServer.port}`)
  state.lastWatchAt = Date.now()
  state.pendingRetry = null
}

function retryCapReached(state) {
  const now = Date.now()
  const retry = state.pendingRetry
  const reached = now - retry.startedAt >= retry.overallCapMs
  if (!reached) return false
  const holder = liveStartupClaimHolder() ? 'yes' : 'no'
  process.stdout.write(`ARTIFACT SERVER RETRY STOPPED: overall cap reached after ${retry.attempts}/${retry.maxAttempts} attempts and ${now - retry.startedAt} ms total wait (cap ${retry.overallCapMs} ms); live startup claim holder: ${holder}; registration retained.\n`)
  state.pendingRetry = null
  return true
}

function deferMonitorRetry(state) {
  state.pendingRetry.deferredAt ??= Date.now()
  if (!state.pendingRetry.deferred) {
    process.stdout.write('ARTIFACT SERVER RETRY DEFERRED: live startup claim holder is still working; registration retained.\n')
    state.pendingRetry.deferred = true
  }
}

function retryWindowExpired(state) {
  const now = Date.now()
  const retry = state.pendingRetry
  if (retry.deferredAt !== null) {
    retry.attemptDeadline += now - retry.deferredAt
    retry.deferredAt = null
    retry.deferred = false
  }
  const expired = retry.attempts >= retry.maxAttempts || now >= retry.attemptDeadline
  if (!expired) return false
  const windowMs = retryWindowMs()
  process.stdout.write(`ARTIFACT SERVER RETRY STOPPED: gave up after ${retry.attempts}/${retry.maxAttempts} attempts within ${windowMs} ms of own retry time; live startup claim holder: no; registration retained.\n`)
  state.pendingRetry = null
  return true
}

function finishMonitorRetry(state, retried, attemptStartedAt) {
  if (retried.kind === 'found') {
    attachMonitor(state, retried)
  } else {
    state.pendingRetry.kind = retried.kind
    if (retried.kind === 'contended') {
      state.pendingRetry.attemptDeadline += Date.now() - attemptStartedAt
      state.pendingRetry.deferredAt = Date.now()
      state.pendingRetry.deferred = false
    }
  }
}

function reportRetryError(state, error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(`ARTIFACT SERVER RETRY ERROR: attempt ${state.pendingRetry?.attempts ?? 0}/${state.pendingRetry?.maxAttempts ?? retryAttempts()} failed: ${message}; registration retained.\n`)
}

function monitorRetryBlocked(state) {
  return stopping || !state.pendingRetry || state.retryInFlight || state.watchInFlight
}

function monitorRetryInterrupted(state) { return stopping || !state.pendingRetry }

function monitorRestartInterrupted(state, processesGone) {
  return !processesGone || monitorRetryInterrupted(state)
}

async function retryTick(state, firstPort) {
  if (monitorRetryBlocked(state)) return
  state.retryInFlight = true
  try {
    if (retryCapReached(state)) return
    const scan = await probeCandidates(firstPort, 750)
    if (monitorRetryInterrupted(state)) return
    if (scan.found) {
      process.stdout.write(`ARTIFACT SERVER ATTACHED: discovered server on port ${scan.found.port} during startup retry.\n`)
      state.attachedServer = scan.found
      recordMonitorAttachment(state)
      return
    }
    if (monitorRestartInterrupted(state, await waitForAttachedServerExit(state.attachedProcesses))) return
    if (liveStartupClaimHolder()) { deferMonitorRetry(state); return }
    if (retryWindowExpired(state)) return
    state.pendingRetry.attempts += 1
    process.stdout.write(`ARTIFACT SERVER RETRY ATTEMPT ${state.pendingRetry.attempts}/${state.pendingRetry.maxAttempts}: re-entering discovery after ${state.pendingRetry.kind}.\n`)
    const attemptStartedAt = Date.now()
    const retried = await discoverOrStart(firstPort)
    if (monitorRetryInterrupted(state)) return
    finishMonitorRetry(state, retried, attemptStartedAt)
  } catch (error) {
    reportRetryError(state, error)
  } finally {
    state.retryInFlight = false
  }
}

function monitorWatchBlocked(state) {
  return stopping || state.pendingRetry || state.retryInFlight || state.watchInFlight || state.attachedServer === null
}

async function watchTick(state, firstPort) {
  if (monitorWatchBlocked(state)) return
  if (Date.now() - state.lastWatchAt < watchIntervalMs()) return
  state.watchInFlight = true
  const watchedPort = state.attachedServer.port
  state.lastWatchAt = Date.now()
  try {
    state.attachedServer = await watchAttachedServer(state, firstPort)
    if (stopping || state.pendingRetry) return
    if (state.attachedServer !== null) {
      rememberAttachedProcess(state)
      return
    }
    process.stdout.write(`ARTIFACT SERVER LOST: server on port ${watchedPort} is no longer answering; restarting; registration retained.\n`)
    state.pendingRetry = startRetry('lost')
  } finally {
    state.watchInFlight = false
  }
}

async function monitorSession(firstPort) {
  const result = await discoverOrStart(firstPort)
  const state = createMonitorState(result)
  if (!reportInitialResult(result, state, firstPort)) return
  const keepAlive = setInterval(() => {
    const shutdownFile = TEST_MODE ? process.env.WT_ARTIFACT_SERVER_TEST_SHUTDOWN_FILE : null
    if (shutdownFile && existsSync(shutdownFile)) cleanExit()
    if (process.ppid !== parentPid) cleanExit()
    void watchTick(state, firstPort)
    void retryTick(state, firstPort)
  }, 2_000)
  try { await finished } finally { clearInterval(keepAlive) }
}

function registerMonitor() {
  ensureSecureStateDir()
  const firstPort = configuredArtifactPort()
  const roots = configuredRoots()
  registrationFile = path.join(artifactRegistrationsDir(), `${session}.json`)
  atomicWriteJson(registrationFile, {
    pid: process.pid, roots, deny: configuredDenyPatterns(), startedAt: new Date().toISOString(),
    ...(process.platform === 'win32' ? { identity: {
      pid: process.pid, argv: process.argv,
      startTime: Date.now() - process.uptime() * 1_000, startTimeApproximate: true,
    } } : {}),
  })
  return firstPort
}

async function main() {
  if (!resolveWorkflowToolboxOption('artifact_server').value) return
  let firstPort
  try {
    firstPort = registerMonitor()
  } catch (error) {
    process.stderr.write(`wt-artifact-server: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  try { await monitorSession(firstPort) } finally { removeRegistration() }
}

const argv = process.argv.slice(2)
handleHelpFlag(argv, HELP, {
  valueFlags: [],
  booleanFlags: [],
})
if (argv.length > 0) {
  process.stderr.write('usage: wt-artifact-server-ensure\n')
  process.exitCode = 2
} else {
  if (TEST_SEAMS_ACTIVE.size > 0) {
    const controls = [...TEST_SEAMS_ACTIVE].map((name) => `${name}=${process.env[name]}`).join(' ')
    process.stderr.write(`⚠ ARTIFACT SERVER TEST MODE — ${controls} — named controls may alter startup timing or emit receipts. This must NEVER be set outside the test suite.\n`)
  }
  process.once('SIGINT', cleanExit)
  process.once('SIGTERM', cleanExit)
  process.once('exit', () => { startupClaim?.release(); removeRegistration() })
  await main()
}
