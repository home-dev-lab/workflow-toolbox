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

async function spawnServer(port, claim) {
  const script = fileURLToPath(new URL('./wt-artifact-server.mjs', import.meta.url))
  const heartbeat = setInterval(() => claim.heartbeat(), 250)
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, 'serve'], {
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
  let staleOwnerPath = null
  let stale = false
  try {
    const files = readdirSync(claimPath)
    if (files.length === 1) {
      staleOwnerPath = path.join(claimPath, files[0])
      const owner = JSON.parse(readFileSync(staleOwnerPath, 'utf8'))
      const expectedToken = files[0].endsWith('.json') ? files[0].slice(0, -5) : null
      if (typeof owner?.token !== 'string' || owner.token !== expectedToken) throw new Error('invalid startup claim owner')
      stale = !pidAlive(owner.pid) || Date.now() - statSync(staleOwnerPath).mtimeMs > startupClaimStaleMs()
    } else {
      stale = Date.now() - statSync(claimPath).mtimeMs > startupClaimStaleMs()
    }
  } catch {
    try { stale = Date.now() - statSync(claimPath).mtimeMs > startupClaimStaleMs() } catch {}
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

function acquireStartupClaim() {
  const claimPath = artifactStartupClaimPath()
  const token = randomUUID()
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
    } catch {}
    try { rmdirSync(claimPath) } catch {}
  }
  const create = () => {
    mkdirSync(claimPath, { mode: 0o700 })
    try {
      atomicWriteJson(ownerPath, { pid: process.pid, token, createdAt, heartbeatAt: Date.now() })
      testLog('WT_ARTIFACT_SERVER_TEST_ACQUISITION_LOG', `${process.pid} ${token}`)
      return { heartbeat, release }
    } catch (error) {
      try { unlinkSync(ownerPath) } catch {}
      try { rmdirSync(claimPath) } catch {}
      throw error
    }
  }
  try {
    return create()
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOENT') throw error
    if (error?.code === 'ENOENT') return null
  }

  const stale = startupClaimIsStale(claimPath)
  if (!stale) return null
  const displacedPath = `${claimPath}.stale-${token}`
  try {
    renameSync(claimPath, displacedPath)
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOENT' || error?.code === 'ENOTEMPTY') return null
    throw error
  }
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
    if (deadline !== null && Date.now() >= deadline) return { firstFree, found: null, claimLost: false, timedOut: true }
    if (claim && !claim.heartbeat()) return { firstFree: null, found: null, claimLost: true, timedOut: false }
    const port = firstPort + offset
    const probeTimeout = deadline === null ? timeout : Math.max(1, Math.min(timeout, deadline - Date.now()))
    const probe = await probeArtifactServer(port, probeTimeout)
    if (probe.kind === 'ours') return { firstFree, found: { port, health: probe.health }, claimLost: false, timedOut: false }
    if (probe.kind === 'free' && firstFree === null) firstFree = port
    if (probe.kind === 'unknown') uncertain = true
  }
  return { firstFree, found: null, claimLost: false, timedOut: false, uncertain }
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
    if (!stopping && (!Number.isFinite(stopHeartbeatAfterMs) || Date.now() - startedAt < stopHeartbeatAfterMs)) claim.heartbeat()
  }
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
    if (stopping) return { kind: 'shutdown' }
    if (scan.timedOut) return { kind: 'contended' }
    if (scan.found) return { kind: 'found', ...scan.found }
    if (scan.firstFree === null) {
      if (scan.uncertain) return { kind: 'contended' }
      return { kind: 'exhausted' }
    }

    const claim = acquireStartupClaim()
    if (!claim) {
      testLog('WT_ARTIFACT_SERVER_TEST_CONTENTION_LOG', `${process.pid}`)
      contentionDeadline ??= Date.now() + holderWorkBoundMs()
      if (Date.now() >= contentionDeadline) return { kind: 'contended' }
      await new Promise((resolve) => setTimeout(resolve, 50))
      continue
    }
    startupClaim = claim
    try {
      await holdClaimForTest(claim)
      if (stopping) return { kind: 'shutdown' }
      const confirmed = await probeCandidates(firstPort, 750, claim)
      if (stopping) return { kind: 'shutdown' }
      if (confirmed.found) return { kind: 'found', ...confirmed.found }
      if (confirmed.claimLost) return { kind: 'claim-lost' }
      if (confirmed.firstFree === null) return { kind: 'exhausted' }
      await spawnServer(confirmed.firstFree, claim)
      if (stopping) return { kind: 'shutdown' }
      if (!claim.heartbeat()) return { kind: 'claim-lost' }
      const serverDeadline = Date.now() + serverReadinessMs()
      while (Date.now() < serverDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        const ready = await probeCandidates(firstPort, 250, claim)
        if (stopping) return { kind: 'shutdown' }
        if (ready.found) return { kind: 'found', ...ready.found }
        if (ready.claimLost) return { kind: 'claim-lost' }
      }
      return { kind: stopping ? 'shutdown' : 'not-ready' }
    } finally {
      claim.release()
      if (startupClaim === claim) startupClaim = null
    }
  }
  return { kind: 'shutdown' }
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

async function main() {
  if (!resolveWorkflowToolboxOption('artifact_server').value) return
  let firstPort
  let roots
  try {
    ensureSecureStateDir()
    firstPort = configuredArtifactPort()
    roots = configuredRoots()
    registrationFile = path.join(artifactRegistrationsDir(), `${session}.json`)
    atomicWriteJson(registrationFile, {
      pid: process.pid, roots, deny: configuredDenyPatterns(), startedAt: new Date().toISOString(),
      ...(process.platform === 'win32' ? { identity: {
        pid: process.pid, argv: process.argv,
        startTime: Date.now() - process.uptime() * 1_000, startTimeApproximate: true,
      } } : {}),
    })
  } catch (error) {
    process.stderr.write(`wt-artifact-server: ${error.message}\n`)
    process.exitCode = 1
    return
  }
  try {
    const result = await discoverOrStart(firstPort)
    let pendingRetry = null
    let retryInFlight = false
    const startRetry = (kind) => {
      const startedAt = Date.now()
      return {
        kind,
        startedAt,
        attemptDeadline: startedAt + retryWindowMs(),
        overallCapMs: retryOverallCapMs(),
        maxAttempts: retryAttempts(),
        attempts: 0,
        deferred: false,
        deferredAt: kind === 'contended' ? startedAt : null,
      }
    }
    if (result.kind === 'exhausted') {
      process.stdout.write(`ARTIFACT SERVER NOT STARTED: no available port in ${firstPort}-${Math.min(firstPort + portAttempts() - 1, 65535)}\n`)
      return
    }
    if (result.kind === 'contended') {
      process.stdout.write(`ARTIFACT SERVER STARTUP PENDING: startup claim holder did not finish within ${holderWorkBoundMs()} ms; registration retained.\n`)
      pendingRetry = startRetry(result.kind)
    } else if (result.kind === 'claim-lost') {
      process.stdout.write('ARTIFACT SERVER STARTUP PENDING: startup claim was lost; registration retained.\n')
      pendingRetry = startRetry(result.kind)
    } else if (result.kind === 'shutdown') {
      process.stdout.write('ARTIFACT SERVER NOT STARTED: startup stopped during shutdown.\n')
    } else if (result.kind === 'not-ready') {
      process.stdout.write(`ARTIFACT SERVER STARTUP PENDING: spawned server did not become ready within ${serverReadinessMs()} ms; registration retained.\n`)
      pendingRetry = startRetry(result.kind)
    } else if (!upgradeNoticed && typeof result.health.version === 'string' && compareVersions(ARTIFACT_SERVER_VERSION, result.health.version) > 0) {
      process.stdout.write(`artifact server v${result.health.version} is older than plugin v${ARTIFACT_SERVER_VERSION}; run \`node wt-artifact-server.mjs restart\` when sessions can disconnect.\n`)
      upgradeNoticed = true
    }

    const retryTick = async () => {
      if (stopping || !pendingRetry || retryInFlight) return
      retryInFlight = true
      try {
        let now = Date.now()
        if (now - pendingRetry.startedAt >= pendingRetry.overallCapMs) {
          const holder = liveStartupClaimHolder() ? 'yes' : 'no'
          process.stdout.write(`ARTIFACT SERVER RETRY STOPPED: overall cap reached after ${pendingRetry.attempts}/${pendingRetry.maxAttempts} attempts and ${now - pendingRetry.startedAt} ms total wait (cap ${pendingRetry.overallCapMs} ms); live startup claim holder: ${holder}; registration retained.\n`)
          pendingRetry = null
          return
        }

        const scan = await probeCandidates(firstPort, 750)
        if (stopping || !pendingRetry) return
        if (scan.found) {
          process.stdout.write(`ARTIFACT SERVER ATTACHED: discovered server on port ${scan.found.port} during startup retry.\n`)
          pendingRetry = null
          return
        }

        if (liveStartupClaimHolder()) {
          pendingRetry.deferredAt ??= Date.now()
          if (!pendingRetry.deferred) {
            process.stdout.write('ARTIFACT SERVER RETRY DEFERRED: live startup claim holder is still working; registration retained.\n')
            pendingRetry.deferred = true
          }
          return
        }

        now = Date.now()
        if (pendingRetry.deferredAt !== null) {
          pendingRetry.attemptDeadline += now - pendingRetry.deferredAt
          pendingRetry.deferredAt = null
          pendingRetry.deferred = false
        }
        if (pendingRetry.attempts >= pendingRetry.maxAttempts || now >= pendingRetry.attemptDeadline) {
          const windowMs = retryWindowMs()
          process.stdout.write(`ARTIFACT SERVER RETRY STOPPED: gave up after ${pendingRetry.attempts}/${pendingRetry.maxAttempts} attempts within ${windowMs} ms of own retry time; live startup claim holder: no; registration retained.\n`)
          pendingRetry = null
          return
        }

        pendingRetry.attempts += 1
        process.stdout.write(`ARTIFACT SERVER RETRY ATTEMPT ${pendingRetry.attempts}/${pendingRetry.maxAttempts}: re-entering discovery after ${pendingRetry.kind}.\n`)
        const attemptStartedAt = Date.now()
        const retried = await discoverOrStart(firstPort)
        if (stopping || !pendingRetry) return
        if (retried.kind === 'found') {
          process.stdout.write(`ARTIFACT SERVER ATTACHED: discovered server on port ${retried.port} during startup retry.\n`)
          pendingRetry = null
        } else {
          pendingRetry.kind = retried.kind
          if (retried.kind === 'contended') {
            pendingRetry.attemptDeadline += Date.now() - attemptStartedAt
            pendingRetry.deferredAt = Date.now()
            pendingRetry.deferred = false
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stdout.write(`ARTIFACT SERVER RETRY ERROR: attempt ${pendingRetry?.attempts ?? 0}/${pendingRetry?.maxAttempts ?? retryAttempts()} failed: ${message}; registration retained.\n`)
      } finally {
        retryInFlight = false
      }
    }
    const keepAlive = setInterval(() => {
      const shutdownFile = TEST_MODE ? process.env.WT_ARTIFACT_SERVER_TEST_SHUTDOWN_FILE : null
      if (shutdownFile && existsSync(shutdownFile)) cleanExit()
      if (process.ppid !== parentPid) cleanExit()
      void retryTick()
    }, 2_000)
    try { await finished } finally { clearInterval(keepAlive) }
  } finally {
    removeRegistration()
  }
}

const argv = process.argv.slice(2)
handleHelpFlag(argv, HELP)
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
