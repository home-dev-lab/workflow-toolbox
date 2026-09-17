#!/usr/bin/env node
// wt-lane.mjs -- detached, one-command external opencode lane launcher.

import { appendFileSync, chmodSync, closeSync, fstatSync, mkdirSync, openSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFileSync as readLaneLog } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConsent } from './lib/lane-consent-check-core.mjs'
import { evaluateConsentGate } from './lib/lane-consent-gate-core.mjs'
import { effectiveSkillDiscoveryRefusal, materialiseAllowedSkills, opencodeChildEnv, opencodeSkillFenceRefusal, spawnOpencode, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence } from './lib/opencode-skill-fence.mjs'
import { resolveLaneSkillAllowlist } from './lib/lane-skill-allowlist.mjs'
import { laneModelRefusal } from './lib/lane-model-allowlist.mjs'
import { appendSupervisorJournal, argvSummary, claimCurrentSupervision, classifyLane, inspectProcess, laneHardBoundAt, latestWorktreeWrite, processEvidenceStatus, readCurrentSupervision, readLogTail, shellQuote, supervisionPaths, terminateLane, writeJsonAtomic } from './lib/lane-supervisor-core.mjs'
import { resolvePluginDataDir } from './lib/plugin-data-dir.mjs'

const DEFAULT_TIMEOUT = 5400
const GRACE_MS = 250
const DEFAULT_DECISION_GRACE = 300
const DEFAULT_MAX_EXTENSIONS = 3
const DEFAULT_MAX_BRIEF_AGE = 600
const DECISION_TRANSITION_BOUND_MS = 5_000
const LAUNCH_LOCK_MAX_AGE_MS = 120_000
const WINDOWS_PROCESS_READ_TIMEOUT_MS = 10_000

async function loadConsentModules() {
  return { resolveConsent, evaluateConsentGate, effectiveSkillDiscoveryRefusal, materialiseAllowedSkills, opencodeChildEnv, opencodeSkillFenceRefusal, spawnOpencode, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence, resolveLaneSkillAllowlist, laneModelRefusal, appendSupervisorJournal, argvSummary, claimCurrentSupervision, classifyLane, inspectProcess, inspectStartedProcess, laneHardBoundAt, latestWorktreeWrite, processEvidenceStatus, readCurrentSupervision, readLogTail, shellQuote, supervisionPaths, terminateLane, writeJsonAtomic, resolvePluginDataDir }
}

function usage() {
  return 'Usage: node wt-lane.mjs --dir <project-root>/.claude/worktrees/<name> --model <provider/model> --brief <file> [--max-brief-age 600] [--acknowledge-stale-brief] [--timeout 5400] [--decision-grace 300] [--max-extensions 3] [--owner session|pilot] [--owner-token <token>] [--log <path>] [--variant <name>] [--allow-no-git]'
}

function parse(argv) {
  const out = { dir: null, model: null, brief: null, maxBriefAge: DEFAULT_MAX_BRIEF_AGE, acknowledgeStaleBrief: false, briefReceipt: null, timeout: DEFAULT_TIMEOUT, decisionGrace: DEFAULT_DECISION_GRACE, maxExtensions: DEFAULT_MAX_EXTENSIONS, owner: 'session', ownerToken: null, briefCleanupDir: null, log: null, allowNoGit: false, runId: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir') out.dir = argv[++i] ?? null
    else if (arg === '--model') out.model = argv[++i] ?? null
    else if (arg === '--brief') out.brief = argv[++i] ?? null
    else if (arg === '--max-brief-age') out.maxBriefAge = Number(argv[++i])
    else if (arg === '--acknowledge-stale-brief') out.acknowledgeStaleBrief = true
    else if (arg === '--brief-receipt') out.briefReceipt = argv[++i] ?? null
    else if (arg === '--timeout') out.timeout = Number(argv[++i])
    else if (arg === '--decision-grace') out.decisionGrace = Number(argv[++i])
    else if (arg === '--max-extensions') out.maxExtensions = Number(argv[++i])
    else if (arg === '--owner') out.owner = argv[++i] ?? null
    else if (arg === '--owner-token') out.ownerToken = argv[++i] ?? null
    else if (arg === '--brief-cleanup-dir') out.briefCleanupDir = argv[++i] ?? null
    else if (arg === '--log') out.log = argv[++i] ?? null
    else if (arg === '--variant') out.variant = argv[++i] ?? null
    else if (arg === '--allow-no-git') out.allowNoGit = true
    else if (arg === '--run-id') out.runId = argv[++i] ?? null
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `unknown argument: ${arg}` }
  }
  if (!out.dir || !out.model || !out.brief) return { error: 'missing required --dir, --model, or --brief' }
  if (!Number.isFinite(out.maxBriefAge) || out.maxBriefAge <= 0) return { error: '--max-brief-age must be a positive number of seconds' }
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) return { error: '--timeout must be a positive number of seconds' }
  if (!Number.isFinite(out.decisionGrace) || out.decisionGrace < 0) return { error: '--decision-grace must be a non-negative number of seconds' }
  if (!Number.isSafeInteger(out.maxExtensions) || out.maxExtensions < 0) return { error: '--max-extensions must be a non-negative integer' }
  if (!['session', 'pilot'].includes(out.owner)) return { error: '--owner must be session or pilot' }
  if (out.runId && !/^\d+-\d+$/.test(out.runId)) return { error: 'internal run id is malformed' }
  // opencode's built-in effort axis; an unknown name falls back SILENTLY to the default on the opencode side, so it is validated here.
  if (out.variant !== undefined && out.variant !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out.variant)) return { error: '--variant must be a plain variant name' }
  out.dir = path.resolve(out.dir)
  try { out.dir = realpathSync(out.dir) } catch { /* preserve the existing not-a-directory diagnostic */ }
  out.brief = path.resolve(out.brief)
  if (out.briefCleanupDir) out.briefCleanupDir = path.resolve(out.briefCleanupDir)
  out.log = path.resolve(out.log ?? path.join(out.dir, '.lane', 'run.log'))
  return out
}

function formatAge(ageMs) {
  const seconds = Math.max(0, Math.floor(ageMs / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

function readBriefEvidence(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const bytes = readFileSync(fd)
    const stat = fstatSync(fd)
    const heading = bytes.toString('utf8').split(/\r?\n/).find((line) => /^#(?:\s|$)/.test(line)) ?? '(no Markdown heading)'
    const ageMs = Math.max(0, Date.now() - stat.mtimeMs)
    return { bytes, path: file, ageMs, age: formatAge(ageMs), heading, sha256: createHash('sha256').update(bytes).digest('hex') }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function parseBriefReceipt(encoded) {
  try {
    const receipt = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (typeof receipt?.path !== 'string' || typeof receipt?.age !== 'string' || typeof receipt?.heading !== 'string' || !/^[0-9a-f]{64}$/.test(receipt?.sha256)) return null
    return receipt
  } catch {
    return null
  }
}

export function inspectStartedProcess(inspect, pid, { platform = process.platform, timeoutMs = platform === 'linux' ? 1_000 : 5_000, expectedCommand = null } = {}) {
  const deadline = Date.now() + timeoutMs
  let candidate = null
  do {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    const identity = inspect(pid, { platform, captureCwd: false, singlePid: platform === 'win32', timeoutMs: remainingMs })
    if (identity && identity.argv.length > 0 && Number.isFinite(identity.startTime)) {
      candidate = identity
      const commandLine = identity.argv.length === 1 ? identity.argv[0].trim() : identity.argv[0]
      const executable = commandLine.startsWith('"')
        ? /^"([^"]+)"/.exec(commandLine)?.[1] ?? commandLine
        : commandLine.split(/\s+/, 1)[0]
      const command = path.basename(executable).toLowerCase().replace(/^\(|\)$/g, '')
      if (!['sh', 'bash', 'dash', 'zsh', 'ksh'].includes(command)) {
        const expectedSeen = !expectedCommand || commandLine.replaceAll('^', '').replaceAll('"', '').toLowerCase().includes(String(expectedCommand).replaceAll('"', '').toLowerCase())
        if (platform !== 'darwin' && (platform !== 'win32' || expectedSeen)) return { identity, unavailable: null }
        const captured = inspect(pid, { platform, captureCwd: true })
        if (platform === 'darwin') return { identity: captured ?? identity, unavailable: null }
      }
    } else if (candidate) return { identity: candidate, unavailable: null }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  } while (Date.now() < deadline)
  if (candidate && platform !== 'win32') return { identity: candidate, unavailable: null }
  const source = platform === 'darwin' ? 'ps' : platform === 'win32' ? 'powershell' : 'proc'
  return { identity: null, unavailable: `unavailable (${source})`, ...(candidate ? { observed: candidate } : {}) }
}

export function inspectLauncherProcess(inspect, pid, { platform = process.platform, ...options } = {}) {
  return inspect(pid, {
    ...options,
    platform,
    ...(platform === 'win32' ? { singlePid: true, timeoutMs: WINDOWS_PROCESS_READ_TIMEOUT_MS } : {}),
  })
}

function captureTimeoutReason(capture) {
  const observed = capture.observed
    ? `last observed argv=${JSON.stringify(capture.observed.argv)} startTime=${capture.observed.startTime}`
    : 'no process identity observed'
  return `process identity capture timed out (${capture.unavailable}; ${observed})`
}

function terminateWindowsTree(pid) {
  const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
  spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { timeout: 5_000, windowsHide: true, stdio: 'ignore' })
}

function briefEvidenceLines(receipt, upper = false) {
  if (!upper) return [`brief=${receipt.path}`, `brief_age=${receipt.age}`, `brief_heading=${receipt.heading}`, `brief_sha256=${receipt.sha256}`]
  return [
    `BRIEF_PATH=${receipt.path}`,
    `BRIEF_AGE=${receipt.age}`,
    `BRIEF_HEADING=${receipt.heading}`,
    `BRIEF_SHA256=${receipt.sha256}`,
  ]
}

function checkGitWorktree(dir) {
  const result = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  if (result.error?.code === 'ENOENT') {
    process.stderr.write(`wt-lane: git is unavailable; cannot verify --dir: ${dir}\n`)
    return false
  }
  if (result.stdout.trim() !== 'true') {
    process.stderr.write(`wt-lane: --dir is not inside a git work tree: ${dir}\n`)
    process.stderr.write('wt-lane: expected a directory inside a git work tree.\n')
    process.stderr.write(`wt-lane: remedy: git worktree add ${dir} <branch>, or pass --allow-no-git for a deliberate non-repo lane.\n`)
    return false
  }
  return true
}

function writeEnvLog(dir) {
  const lines = [`CLAUDE_CODE_SESSION_ID=${process.env.CLAUDE_CODE_SESSION_ID ?? ''}`, `SSH_AUTH_SOCK=${process.env.SSH_AUTH_SOCK ? 'present' : 'absent'}`]
  try {
    const result = spawnSync('ssh-add', ['-l'], { timeout: 3000, stdio: 'pipe', encoding: 'utf8' })
    if (result.error) {
      lines.push(`ssh-add -l: unavailable: ${result.error.code === 'ETIMEDOUT' ? 'timeout' : result.error.message}`)
    } else {
      // Count only on success: a failing `ssh-add -l` still prints a sentence ("The agent has no identities.").
      const keys = result.status === 0 ? result.stdout.split('\n').filter((line) => line.trim()).length : 0
      lines.push(`ssh-add -l: exit=${result.status ?? 1} keys=${keys}`)
    }
  } catch (error) {
    lines.push(`ssh-add -l: unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  lines.push(`HOME=${process.env.HOME ? 'present' : 'absent'} USER=${process.env.USER ? 'present' : 'absent'}`)
  lines.push(`node=${process.version}`)
  lines.push(`at=${new Date().toISOString()}`)
  try { writeFileSync(path.join(dir, '.lane', 'env.log'), `${lines.join('\n')}\n`) } catch { /* best effort diagnostic */ }
}

function writeLaneStage(file, stage, { reset = false, runId = null, header = [] } = {}) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const line = `${new Date().toISOString()} stage=${stage}\n`
    if (!reset) { appendFileSync(file, line); return }
    let receiptPrefix = ''
    try {
      const first = readFileSync(file, 'utf8').split(/\r?\n/, 1)[0]
      if (/^LANE_NONCE=/.test(first)) receiptPrefix = `${first}\n`
    } catch { receiptPrefix = '' }
    let initial = receiptPrefix
    if (runId) initial += `LANE_RUN_ID=${runId}\n`
    if (header.length) initial += `${header.join('\n')}\n`
    writeFileSync(file, `${initial}${line}`)
  } catch { /* best effort diagnostic */ }
}

async function main() {
  const worker = process.argv[2] === '--worker'
  const opts = parse(process.argv.slice(worker ? 3 : 2))
  if (opts.help) { process.stdout.write(`${usage()}\n`); return 0 }
  if (opts.error) { process.stderr.write(`wt-lane: ${opts.error}\n${usage()}\n`); return 2 }
  let workerSpawnedChild = false
  if (worker && opts.runId && opts.dir) process.once('beforeExit', () => {
    if (workerSpawnedChild) return
    const stateFile = path.join(opts.dir, '.lane', 'supervision', `${opts.runId}.json`)
    let current = null
    try { current = JSON.parse(readFileSync(stateFile, 'utf8')) } catch {}
    if (current && current.state !== 'launching') return
    try {
      mkdirSync(path.dirname(stateFile), { recursive: true })
      const temporary = `${stateFile}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ ...current, version: 1, runId: opts.runId, state: 'launch-failed', worktree: opts.dir, reason: 'worker returned before spawning opencode' }, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, stateFile)
    } catch {}
  })
  if (!existsSync(opts.dir) || !statSync(opts.dir).isDirectory()) { process.stderr.write(`wt-lane: --dir is not a directory: ${opts.dir}\n`); return 2 }
  if (!existsSync(opts.brief)) { process.stderr.write(`wt-lane: --brief does not exist: ${opts.brief}\n`); return 2 }
  let briefEvidence
  if (worker) {
    briefEvidence = parseBriefReceipt(opts.briefReceipt)
    if (!briefEvidence) { process.stderr.write('wt-lane: internal brief receipt is missing or malformed\n'); return 2 }
    let workerBytes
    try { workerBytes = readFileSync(opts.brief) } catch (error) {
      process.stderr.write(`wt-lane: brief snapshot is unreadable: ${opts.brief} (${error instanceof Error ? error.message : String(error)})\n`)
      return 1
    }
    const workerSha256 = createHash('sha256').update(workerBytes).digest('hex')
    if (workerSha256 !== briefEvidence.sha256) {
      process.stderr.write(`wt-lane: Refused: brief snapshot sha256 mismatch for ${opts.brief}; refusing to obey bytes other than those announced by the launcher.\n`)
      return 1
    }
    process.once('beforeExit', () => { if (!workerSpawnedChild) rmSync(opts.brief, { force: true }) })
  } else {
    try { briefEvidence = readBriefEvidence(opts.brief) } catch (error) {
      process.stderr.write(`wt-lane: --brief is unreadable: ${opts.brief} (${error instanceof Error ? error.message : String(error)})\n`)
      return 2
    }
    if (briefEvidence.ageMs > opts.maxBriefAge * 1000 && !opts.acknowledgeStaleBrief) {
      process.stderr.write(`wt-lane: Refused: brief ${opts.brief} is stale (age=${briefEvidence.age}; maximum=${formatAge(opts.maxBriefAge * 1000)}); refresh or rewrite it for a new round, or add --acknowledge-stale-brief when intentionally resuming this old round.\n`)
      return 1
    }
  }
  if (!opts.allowNoGit && !checkGitWorktree(opts.dir)) return 2

  // Invoke the same consent resolver and wording as the PreToolUse gate before a node wrapper
  // can bypass its text matcher.
  let consentModules
  try {
    consentModules = await loadConsentModules()
  } catch (error) {
    process.stderr.write(`wt-lane: Refused: ${error instanceof Error ? error.message : String(error)}; refusing to launch.\n`)
    return 1
  }
  if (typeof consentModules.writeJsonAtomic !== 'function' || typeof consentModules.claimCurrentSupervision !== 'function' || typeof consentModules.classifyLane !== 'function' || typeof consentModules.terminateLane !== 'function') {
    process.stderr.write('wt-lane: Refused: the installed workflow-toolbox plugin is too old for this adopted launcher; update the plugin and re-adopt wt-lane.mjs.\n')
    return 1
  }
  let launchLock = null
  let releaseLaunchLock = () => {}
  if (!worker) {
    const runId = opts.runId ?? `${process.pid}-${Date.now()}`
    opts.runId = runId
    const paths = consentModules.supervisionPaths(opts.dir, runId)
    launchLock = path.join(paths.dir, 'launch.lock')
    const recoveryLock = path.join(paths.dir, 'launch.lock.recovery')
    mkdirSync(paths.dir, { recursive: true })
    writeLaneStage(opts.log, 'inspect-launcher-start', { reset: true, runId, header: briefEvidenceLines(briefEvidence, true) })
    const launcherInspect = (pid, options = {}) => inspectLauncherProcess(consentModules.inspectProcess, pid, { ...options, platform: process.platform })
    const identity = launcherInspect(process.pid) ?? { argv: process.argv, startTime: null }
    writeLaneStage(opts.log, 'inspect-launcher-done')
    const lockOwner = { version: 1, runId, pid: process.pid, argv: identity.argv, startTime: identity.startTime, createdAt: new Date().toISOString() }
    const lockStatus = (lockPath) => {
      let owner = null
      try { owner = JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) } catch {}
      let age
      try { age = Date.now() - statSync(lockPath).mtimeMs } catch (error) { if (error?.code === 'ENOENT') return { retry: true }; throw error }
      if (!owner || !Number.isSafeInteger(owner.pid)) return age > LAUNCH_LOCK_MAX_AGE_MS
        ? { stale: true, owner, reason: `owner record is unreadable after ${LAUNCH_LOCK_MAX_AGE_MS}ms` }
        : { stale: false, owner, reason: 'owner record is not ready' }
      try { process.kill(owner.pid, 0) } catch (error) {
        if (error?.code === 'ESRCH') return { stale: true, owner, reason: 'owner process is gone' }
      }
      const actual = launcherInspect(owner.pid)
      if (actual && Number.isFinite(owner.startTime) && Number.isFinite(actual.startTime) && actual.startTime !== owner.startTime) return { stale: true, owner, reason: 'owner pid was reused' }
      if (actual && Number.isFinite(owner.startTime) && Number.isFinite(actual.startTime) && actual.startTime === owner.startTime) return { stale: false, owner, reason: 'owner process is still running' }
      return age > LAUNCH_LOCK_MAX_AGE_MS
        ? { stale: true, owner, reason: `owner process identity is unreadable after ${LAUNCH_LOCK_MAX_AGE_MS}ms` }
        : { stale: false, owner, reason: 'owner process identity is not ready' }
    }
    const removeOwnedLock = (lockPath, owner) => {
      let current = null
      try { current = JSON.parse(readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) } catch {}
      if (current?.runId === owner.runId && current.pid === owner.pid && current.startTime === owner.startTime) rmSync(lockPath, { recursive: true, force: true })
    }
    const refusal = (lockPath, status) => {
      const activity = lockPath === recoveryLock ? 'another lane launch is recovering an abandoned launch lock' : 'another lane launch is in progress'
      const condition = status.reason === 'owner process is still running'
        ? 'its recorded owner has exited or its PID start time has changed'
        : `its owner identity is readable or its age exceeds ${LAUNCH_LOCK_MAX_AGE_MS / 1000}s`
      process.stderr.write(`wt-lane: Refused: ${activity}: ${lockPath} (${status.reason}); the next launch recovers this path once ${condition}\n`)
    }
    const acquire = () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          mkdirSync(launchLock)
          writeFileSync(path.join(launchLock, 'owner.json'), `${JSON.stringify(lockOwner, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
          return true
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
          const status = lockStatus(launchLock)
          if (status.retry) continue
          if (!status.stale) {
            refusal(launchLock, status)
            return false
          }
          try {
            mkdirSync(recoveryLock)
            writeFileSync(path.join(recoveryLock, 'owner.json'), `${JSON.stringify(lockOwner, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
          } catch (recoveryError) {
            if (recoveryError?.code === 'EEXIST') {
              const recoveryStatus = lockStatus(recoveryLock)
              if (recoveryStatus.retry) continue
              if (!recoveryStatus.stale) {
                refusal(recoveryLock, recoveryStatus)
                return false
              }
              const abandonedRecovery = `${recoveryLock}.stale.${process.pid}.${Date.now()}`
              try { renameSync(recoveryLock, abandonedRecovery) } catch (renameError) {
                if (renameError?.code === 'ENOENT') continue
                throw renameError
              }
              rmSync(abandonedRecovery, { recursive: true, force: true })
              continue
            }
            removeOwnedLock(recoveryLock, lockOwner)
            throw recoveryError
          }
          const confirmed = lockStatus(launchLock)
          if (confirmed.retry || !confirmed.stale) {
            removeOwnedLock(recoveryLock, lockOwner)
            if (confirmed.retry) continue
            refusal(launchLock, confirmed)
            return false
          }
          const quarantine = `${launchLock}.stale.${process.pid}.${Date.now()}`
          try { renameSync(launchLock, quarantine) } catch { removeOwnedLock(recoveryLock, lockOwner); continue }
          rmSync(quarantine, { recursive: true, force: true })
          try {
            const dataDir = path.join(consentModules.resolvePluginDataDir({ env: process.env }).dir, 'lane-supervisor')
            consentModules.appendSupervisorJournal(dataDir, { event: 'launch-lock-recovered', runId, pid: status.owner?.pid ?? null, argv: consentModules.argvSummary(status.owner?.argv ?? []), worktree: opts.dir, owner: null, reason: status.reason })
          } catch {}
          removeOwnedLock(recoveryLock, lockOwner)
          continue
        }
      }
      process.stderr.write(`wt-lane: Refused: ${launchLock} or ${recoveryLock} changed ownership repeatedly; they clear when the competing launch or recovery finishes\n`)
      return false
    }
    if (!acquire()) return 1
    writeLaneStage(opts.log, 'launch-lock-acquired')
    let released = false
    releaseLaunchLock = () => {
      if (released) return
      released = true
      removeOwnedLock(launchLock, lockOwner)
    }
    process.once('exit', releaseLaunchLock)
    writeLaneStage(opts.log, 'current-supervision-start')
    const current = consentModules.readCurrentSupervision(opts.dir)
    writeLaneStage(opts.log, 'current-supervision-done')
    if (!current && existsSync(paths.pointer)) {
      process.stderr.write(`wt-lane: Refused: current lane supervision is unreadable; after verifying no lane process is live, remove ${consentModules.shellQuote(paths.pointer)} and retry\n`)
      return 1
    }
    if (current) {
      const verdict = consentModules.classifyLane(current, { platform: process.platform, inspect: launcherInspect })
      const hardBound = consentModules.laneHardBoundAt(current)
      if (verdict.status === 'unknown' && hardBound !== null && Date.now() > hardBound) {
        try {
          const dataDir = path.join(consentModules.resolvePluginDataDir({ env: process.env }).dir, 'lane-supervisor')
          consentModules.appendSupervisorJournal(dataDir, { event: 'superseded', runId: current.runId, pid: current.childPid, argv: consentModules.argvSummary(current.childArgv ?? []), worktree: opts.dir, owner: current.owner ?? null, reason: `unknown beyond hard bound ${new Date(hardBound).toISOString()}` })
        } catch {}
      } else if (!['terminal', 'gone'].includes(verdict.status)) {
        const token = current.ownerToken ? ` --owner-token ${consentModules.shellQuote(current.ownerToken)}` : ''
        const control = `node ${consentModules.shellQuote(path.join(path.dirname(process.argv[1]), 'wt-lane-control.mjs'))} --dir ${consentModules.shellQuote(opts.dir)} --decision abandon${token}`
        const remedy = ['decision-needed', 'worker-gone-child-alive'].includes(verdict.status)
          ? `abandon with ${control}`
          : verdict.status === 'unknown'
            ? `retry after the recorded hard bound${hardBound === null ? ' can be established from a readable record' : ` at ${new Date(hardBound).toISOString()}`}`
            : `wait until the lane reaches decision-needed, then abandon with ${control}`
        process.stderr.write(`wt-lane: Refused: current lane ${current.runId} is ${verdict.status}; ${remedy}\n`)
        return 1
      }
    }
  }
  writeLaneStage(opts.log, 'consent-check-start')
  const modelRefusal = consentModules.laneModelRefusal(opts.model, { env: process.env })
  if (modelRefusal) { process.stderr.write(`${modelRefusal}\n`); return 1 }
  const consent = consentModules.evaluateConsentGate(
    { tool_input: { command: 'opencode run' }, cwd: opts.dir },
    { resolveConsentImpl: consentModules.resolveConsent },
  )
  if (!consent.silent) { process.stderr.write(`${consent.message}\n`); return 1 }
  writeLaneStage(opts.log, 'consent-check-done')

  const allowlist = consentModules.resolveLaneSkillAllowlist({ env: process.env })
  if (allowlist.refusals.length) {
    process.stderr.write(`wt-lane: Refused: ${allowlist.refusals.map(({ reason }) => reason).join('; ')}; refusing to launch.\n`)
    return 1
  }
  let allowedSkills
  try {
    allowedSkills = consentModules.materialiseAllowedSkills({ names: allowlist.allowed, laneDir: opts.dir, env: process.env })
  } catch (error) {
    process.stderr.write(`wt-lane: Refused: skill materialisation failed (${error instanceof Error ? error.message : String(error)}); refusing to launch.\n`)
    return 1
  }
  if (allowedSkills.failures.length) {
    process.stderr.write(`wt-lane: Refused: ${allowedSkills.failures.map(({ name, reason, detail }) => `${name}: ${reason} (${detail})`).join('; ')}; refusing to launch.\n`)
    return 1
  }

  writeLaneStage(opts.log, 'skill-fence-start')
  const fence = consentModules.verifyOpencodeSkillFence('opencode', { platform: process.platform })
  if (!fence.ok) { process.stderr.write(`${consentModules.opencodeSkillFenceRefusal(fence.reason)}\n`); return 1 }
  if (allowlist.allowed.length && !fence.allowOk) {
    process.stderr.write(`${consentModules.opencodeSkillFenceRefusal(`the allow-list half failed for ${fence.mechanism}: ${fence.allowReason ?? 'the materialised skill was not visible'}`)}\n`)
    return 1
  }
  writeLaneStage(opts.log, 'skill-fence-done')

  const childEnv = { ...consentModules.opencodeChildEnv(process.env), ...(allowlist.allowed.length ? { OPENCODE_CONFIG: allowedSkills.configPath } : {}) }
  const opencodeBinary = fence.binary ?? 'opencode'
  writeLaneStage(opts.log, 'effective-discovery-start')
  const discovery = consentModules.verifyEffectiveOpencodeSkillDiscovery(opencodeBinary, { cwd: opts.dir, env: childEnv, platform: process.platform })
  if (!discovery.ok) {
    process.stderr.write(`${consentModules.effectiveSkillDiscoveryRefusal(discovery)}\n`)
    return 1
  }
  writeLaneStage(opts.log, 'effective-discovery-done')

  if (!worker) {
    mkdirSync(path.join(opts.dir, '.lane'), { recursive: true })
    const runId = opts.runId
    const paths = consentModules.supervisionPaths(opts.dir, runId)
    const briefSnapshotDir = path.join(opts.dir, '.lane', 'brief-snapshots')
    const briefSnapshot = path.join(briefSnapshotDir, `${runId}.md`)
    try {
      mkdirSync(briefSnapshotDir, { recursive: true, mode: 0o700 })
      chmodSync(briefSnapshotDir, 0o700)
      writeFileSync(briefSnapshot, briefEvidence.bytes, { flag: 'wx', mode: 0o400 })
      const briefReceipt = Buffer.from(JSON.stringify({ path: briefEvidence.path, age: briefEvidence.age, heading: briefEvidence.heading, sha256: briefEvidence.sha256 }), 'utf8').toString('base64url')
      const workerArgs = [process.argv[1], '--worker', '--dir', opts.dir, '--model', opts.model, '--brief', briefSnapshot, '--brief-receipt', briefReceipt, '--timeout', String(opts.timeout), '--decision-grace', String(opts.decisionGrace), '--max-extensions', String(opts.maxExtensions), '--owner', opts.owner, '--run-id', runId, ...(opts.ownerToken ? ['--owner-token', opts.ownerToken] : []), ...(opts.briefCleanupDir ? ['--brief-cleanup-dir', opts.briefCleanupDir] : []), '--log', opts.log, ...(opts.variant ? ['--variant', opts.variant] : []), ...(opts.allowNoGit ? ['--allow-no-git'] : [])]
      process.stdout.write(`${briefEvidenceLines(briefEvidence).join('\n')}\n`)
      writeLaneStage(opts.log, 'worker-spawn-start')
      const child = spawn(process.execPath, workerArgs, { detached: true, stdio: 'ignore' })
      writeLaneStage(opts.log, 'worker-identity-capture-start')
      const captured = consentModules.inspectStartedProcess(consentModules.inspectProcess, child.pid, { expectedCommand: process.execPath })
      if (process.platform === 'win32' && !captured.identity) {
        const reason = captureTimeoutReason(captured)
        writeLaneStage(opts.log, `worker-identity-capture-timeout ${reason}`)
        child.kill('SIGTERM')
        rmSync(briefSnapshot, { force: true })
        process.stderr.write(`wt-lane: ${reason}\n`)
        return 1
      }
      writeLaneStage(opts.log, 'worker-identity-capture-done')
      const identity = captured.identity
      const timeoutAt = new Date(Date.now() + opts.timeout * 1000).toISOString()
      try {
        writeFileSync(paths.record, `${JSON.stringify({ version: 1, runId, state: 'launching', owner: opts.owner, ownerSessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null, ownerToken: opts.ownerToken, workerPid: child.pid, workerArgv: identity?.argv ?? null, workerStartTime: identity?.startTime ?? null, ...(process.platform === 'darwin' ? { workerCwd: identity?.cwd ?? null } : {}), ...(captured.unavailable ? { workerIdentity: captured.unavailable } : {}), childPid: null, childArgv: null, childStartTime: null, ...(process.platform === 'darwin' ? { childCwd: null } : {}), worktree: opts.dir, timeoutAt, timeoutSeconds: opts.timeout, decisionGraceSeconds: opts.decisionGrace, decisionTransitionBoundMs: DECISION_TRANSITION_BOUND_MS, maxExtensions: opts.maxExtensions, extensionCount: 0 }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        child.kill('SIGTERM')
        rmSync(briefSnapshot, { force: true })
        if (error?.code === 'EEXIST') { process.stderr.write(`wt-lane: Refused: supervision record ${paths.record} already exists\n`); return 1 }
        throw error
      }
      if (!consentModules.claimCurrentSupervision(paths, runId)) {
        child.kill('SIGTERM')
        rmSync(briefSnapshot, { force: true })
        process.stderr.write('wt-lane: Refused: another lane launch owns the current supervision pointer\n')
        return 1
      }
      child.unref()
      writeFileSync(path.join(opts.dir, '.lane', 'pid'), `${child.pid}\n`)
      process.stdout.write(`pid=${child.pid}\nrun=${runId}\nlog=${opts.log}\n`)
      return 0
    } finally { releaseLaunchLock() }
  }

  const runId = opts.runId ?? `${process.pid}-${Date.now()}`
  const statePaths = consentModules.supervisionPaths(opts.dir, runId)
  mkdirSync(path.dirname(opts.log), { recursive: true })
  writeEnvLog(opts.dir)
  writeLaneStage(opts.log, 'worker-log-open-start')
  const fd = openSync(opts.log, 'a')
  let terminateWorker = null
  let pendingTermination = null
  process.on('SIGTERM', () => { if (terminateWorker) terminateWorker(143); else pendingTermination = 143 })
  process.on('SIGINT', () => { if (terminateWorker) terminateWorker(130); else pendingTermination = 130 })
  const args = ['run', `Read and execute the complete brief at ${opts.brief}.`, '--auto', '--dir', opts.dir, '--model', opts.model, ...(opts.variant ? ['--variant', opts.variant] : [])]
  // OpenCode honours this runtime flag by skipping ~/.claude/skills and project .claude/skills,
  // preserving its own and .agents skills while fencing the harness's single-writer memory skills.
  let child
  let earlyChildClose = null
  // A first line BEFORE the spawn and the identity capture: a launcher that is alive but still
  // waiting on capture must never read as `<no output>` to a bounded caller (Windows runs 19–20).
  const progress = `wt-lane: starting ${opencodeBinary} in ${opts.dir}`
  process.stdout.write(`${progress}\n`)
  appendFileSync(fd, `${new Date().toISOString()} stage=opencode-spawn-start ${progress}\n`)
  try {
    child = consentModules.spawnOpencode(spawn, opencodeBinary, args, { cwd: opts.dir, env: childEnv, stdio: ['ignore', fd, fd] }, process.platform)
    child.once('close', (code, signal) => { earlyChildClose = [code, signal] })
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    workerSpawnedChild = true
  } catch (error) {
    const reason = `opencode spawn failed: ${error instanceof Error ? error.message : String(error)}`
    consentModules.writeJsonAtomic(statePaths.record, { version: 1, runId, state: 'launch-failed', worktree: opts.dir, reason })
    return 1
  }
  const stateFile = statePaths.record
  const decisionFile = statePaths.decision
  const dataDir = path.join(consentModules.resolvePluginDataDir({ env: process.env }).dir, 'lane-supervisor')
  const journal = (event) => { try { consentModules.appendSupervisorJournal(dataDir, event) } catch { /* supervision must remain bounded when its audit sink is unavailable */ } }
  const appendWorkerStage = (stage) => {
    try {
      const tail = readLaneLog(opts.log, 'utf8').split(/\r?\n/).filter(Boolean).at(-1) ?? ''
      if (/^EXIT=\d+$/.test(tail)) return
    } catch { /* append the diagnostic below when the existing log is unreadable */ }
    appendFileSync(fd, `${new Date().toISOString()} stage=${stage}\n`)
  }
  appendWorkerStage('child-identity-capture-start')
  const childCapture = consentModules.inspectStartedProcess(consentModules.inspectProcess, child.pid, { expectedCommand: opencodeBinary })
  if (process.platform === 'win32' && !childCapture.identity) {
    const reason = captureTimeoutReason(childCapture)
    appendWorkerStage(`child-identity-capture-timeout ${reason}`)
    consentModules.writeJsonAtomic(statePaths.record, { version: 1, runId, state: 'launch-failed', worktree: opts.dir, reason })
    terminateWindowsTree(child.pid)
    rmSync(opts.brief, { force: true })
    appendFileSync(fd, 'EXIT=1\n')
    process.stderr.write(`wt-lane: ${reason}\n`)
    return 1
  }
  appendWorkerStage('child-identity-capture-done')
  appendWorkerStage('worker-identity-capture-start')
  const workerCapture = consentModules.inspectStartedProcess(consentModules.inspectProcess, process.pid, { expectedCommand: process.execPath })
  if (process.platform === 'win32' && !workerCapture.identity) {
    const reason = captureTimeoutReason(workerCapture)
    appendWorkerStage(`worker-identity-capture-timeout ${reason}`)
    consentModules.writeJsonAtomic(statePaths.record, { version: 1, runId, state: 'launch-failed', worktree: opts.dir, reason })
    terminateWindowsTree(child.pid)
    rmSync(opts.brief, { force: true })
    appendFileSync(fd, 'EXIT=1\n')
    process.stderr.write(`wt-lane: ${reason}\n`)
    return 1
  }
  appendWorkerStage('worker-identity-capture-done')
  const childIdentity = childCapture.identity
  const workerIdentity = workerCapture.identity
  const baseState = { version: 1, runId, state: 'running', owner: opts.owner, ownerSessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null, ownerToken: opts.ownerToken, workerPid: process.pid, workerArgv: workerIdentity?.argv ?? null, workerStartTime: workerIdentity?.startTime ?? null, ...(process.platform === 'darwin' ? { workerCwd: workerIdentity?.cwd ?? null } : {}), ...(workerCapture.unavailable ? { workerIdentity: workerCapture.unavailable } : {}), childPid: child.pid, childArgv: childIdentity?.argv ?? null, childStartTime: childIdentity?.startTime ?? null, ...(process.platform === 'darwin' ? { childCwd: childIdentity?.cwd ?? null } : {}), ...(childCapture.unavailable ? { childIdentity: childCapture.unavailable } : {}), worktree: opts.dir, log: opts.log, launchedAt: new Date().toISOString(), timeoutSeconds: opts.timeout, decisionGraceSeconds: opts.decisionGrace, decisionTransitionBoundMs: DECISION_TRANSITION_BOUND_MS, maxExtensions: opts.maxExtensions, extensionCount: 0, defaultDecision: 'extend' }
  let currentState = baseState
  const writeState = (extra) => {
    currentState = { ...currentState, ...extra }
    consentModules.writeJsonAtomic(stateFile, currentState)
    return true
  }
  rmSync(decisionFile, { force: true })
  const firstTimeoutAt = new Date(Date.now() + opts.timeout * 1000).toISOString()
  writeState({ timeoutAt: firstTimeoutAt, decisionTransitionDueAt: new Date(Date.parse(firstTimeoutAt) + DECISION_TRANSITION_BOUND_MS).toISOString() })
  consentModules.writeJsonAtomic(statePaths.pointer, { version: 1, runId })
  journal({ event: 'launched', pid: child.pid, argv: consentModules.argvSummary(['opencode', ...args]), worktree: opts.dir, owner: opts.owner })
  let finished = false
  const finish = (code) => {
    if (finished) return
    finished = true
    // The lane's own terminal line wins: when opencode already wrote `EXIT=<n>` and the group is
    // ended from outside afterwards (the lifecycle server reaps the group at receipt), a second
    // line would change the attested receipt. Append only when no terminal line exists yet.
    try {
      const tail = readLaneLog(opts.log, 'utf8').split(/\r?\n/).filter(Boolean).at(-1) ?? ''
      if (/^EXIT=\d+$/.test(tail)) return
    } catch { /* unreadable log: append below */ }
    try { appendFileSync(opts.log, `EXIT=${code}\n`) } catch { /* best effort after a log write failure */ }
  }
  // Ending the lane, from either the timeout or an external signal, ends the whole process group:
  // the worker is the group leader (detached) and opencode lives in that group, so a signal sent to
  // the worker's pid alone used to kill the launcher and leave the lane running, invisible.
  const endGroup = (code, { writeReceipt = true, terminal = null } = {}) => {
    if (writeReceipt) finish(code)
    process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT')
    process.on('SIGTERM', () => {}); process.on('SIGINT', () => {})
    consentModules.terminateLane(currentState, { graceMs: GRACE_MS, journal, source: 'worker', ownedChild: child, ...(terminal ? { markTerminal: (stage) => writeState(stage === 'terminal' ? terminal : { ...terminal, state: 'terminating' }) } : {}) })
  }
  terminateWorker = (code) => {
    clearTimeout(timer); clearTimeout(graceTimer); cleanupBrief()
    let ownerDecision = false
    try { const recorded = JSON.parse(readFileSync(stateFile, 'utf8')); ownerDecision = ['terminating', 'abandoned'].includes(recorded.state) && recorded.decisionSource === 'owner' } catch {}
    endGroup(code, { terminal: ownerDecision ? null : { state: 'abandoned', decision: 'abandon', decisionSource: 'signal', decidedAt: new Date().toISOString() } })
  }
  const cleanupBrief = () => {
    if (opts.briefReceipt) rmSync(opts.brief, { force: true })
    if (opts.briefCleanupDir && briefEvidence.path.startsWith(`${opts.briefCleanupDir}${path.sep}`)) rmSync(opts.briefCleanupDir, { recursive: true, force: true })
  }
  let timer
  let graceTimer
  if (pendingTermination !== null) terminateWorker(pendingTermination)
  let extensionCount = 0
  const enterDecision = (reason = 'timeout-bound', extra = {}) => {
    clearTimeout(graceTimer)
    const timeoutAt = scheduledTimeoutAt ?? new Date().toISOString()
    const activity = consentModules.latestWorktreeWrite(opts.dir)
    const evidence = { lastWriteAt: activity.status === 'known' && activity.at ? new Date(activity.at).toISOString() : 'unknown', activityStatus: activity.status, activityBounded: activity.bounded, logTail: consentModules.readLogTail(opts.log), process: consentModules.processEvidenceStatus(child.pid) }
    const defaultDecision = extensionCount < opts.maxExtensions ? 'extend' : 'abandon'
    writeState({ state: 'decision-needed', timeoutAt, decisionDueAt: new Date(Date.now() + opts.decisionGrace * 1000).toISOString(), extensionCount, defaultDecision, evidence, reason, ...extra })
    journal({ event: 'decision-needed', pid: child.pid, argv: consentModules.argvSummary(['opencode', ...args]), worktree: opts.dir, owner: opts.owner, reason, evidence: { ...evidence, timeoutAt, extensionCount, defaultDecision } })
    graceTimer = setTimeout(() => {
      try {
        const current = JSON.parse(readFileSync(stateFile, 'utf8'))
        if (current.runId !== runId || current.state !== 'decision-needed' || current.timeoutAt !== timeoutAt) return
        if (defaultDecision === 'extend') {
          extensionCount += 1
          writeState({ state: 'running', decision: 'extend', decisionSource: 'grace-default', decidedAt: new Date().toISOString(), extensionCount, evidence })
          journal({ event: 'decision', decision: 'extend', source: 'grace-default', pid: child.pid, argv: consentModules.argvSummary(['opencode', ...args]), worktree: opts.dir, owner: opts.owner, reason: 'no owner decision within grace' })
          armTimeout(opts.timeout)
        } else {
          journal({ event: 'decision', decision: 'abandon', source: 'grace-default', pid: child.pid, argv: consentModules.argvSummary(['opencode', ...args]), worktree: opts.dir, owner: opts.owner, reason: 'extension ceiling reached' })
          cleanupBrief()
          endGroup(126, { terminal: { state: 'abandoned', decision: 'abandon', decisionSource: 'grace-default', decidedAt: new Date().toISOString(), extensionCount, evidence } })
        }
      } catch {}
    }, opts.decisionGrace * 1000)
    graceTimer.unref()
  }
  const armTimeout = (seconds) => {
    clearTimeout(timer)
    clearTimeout(graceTimer)
    scheduledTimeoutAt = new Date(Date.now() + seconds * 1000).toISOString()
    writeState({ state: 'running', timeoutAt: scheduledTimeoutAt, decisionTransitionDueAt: new Date(Date.parse(scheduledTimeoutAt) + DECISION_TRANSITION_BOUND_MS).toISOString(), extensionCount })
    timer = setTimeout(enterDecision, seconds * 1000)
    timer.unref()
  }
  let scheduledTimeoutAt = firstTimeoutAt
  armTimeout(opts.timeout)
  const decisions = setInterval(() => {
    let decision
    try { decision = JSON.parse(readFileSync(decisionFile, 'utf8')) } catch { return }
    let current
    try { current = JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return }
    if (decision.runId !== runId || decision.timeoutAt !== current.timeoutAt || current.state !== 'decision-needed' || !['extend', 'abandon'].includes(decision.decision)) return
    rmSync(decisionFile, { force: true })
    clearTimeout(graceTimer)
    if (decision.decision === 'extend') {
      const effective = extensionCount < opts.maxExtensions ? 'extend' : 'abandon'
      journal({ event: 'decision', decision: effective, source: effective === 'extend' ? 'owner' : 'extension-ceiling', pid: child.pid, argv: consentModules.argvSummary(['opencode', ...args]), worktree: opts.dir, owner: opts.owner, reason: decision.reason ?? null })
      if (effective === 'extend') {
        extensionCount += 1
        writeState({ state: 'running', decision: 'extend', decisionSource: 'owner', decidedAt: new Date().toISOString(), extensionCount })
        armTimeout(Number.isFinite(decision.extendSeconds) && decision.extendSeconds > 0 ? decision.extendSeconds : opts.timeout)
      } else {
        cleanupBrief(); endGroup(126, { terminal: { state: 'abandoned', decision: 'abandon', decisionSource: 'extension-ceiling', decidedAt: new Date().toISOString(), extensionCount } })
      }
    } else {
      journal({ event: 'decision', decision: 'abandon', source: 'owner', pid: child.pid, argv: consentModules.argvSummary(['opencode', ...args]), worktree: opts.dir, owner: opts.owner, reason: decision.reason ?? null })
      clearInterval(decisions)
      cleanupBrief(); endGroup(126, { terminal: { state: 'abandoned', decision: 'abandon', decisionSource: 'owner', decidedAt: new Date().toISOString(), extensionCount } })
    }
  }, 100)
  decisions.unref()
  child.on('error', () => { clearTimeout(timer); clearTimeout(graceTimer); clearInterval(decisions); cleanupBrief(); finish(1) })
  let closeHandled = false
  const onChildClose = (code, signal) => {
    if (closeHandled) return
    closeHandled = true
    clearTimeout(timer); clearTimeout(graceTimer); clearInterval(decisions)
    const exit = signal ? 124 : (code ?? 1)
    try {
      const current = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (['terminating', 'abandoned'].includes(current.state)) return
    } catch {}
    writeState({ state: 'exited', exit, exitedAt: new Date().toISOString() })
    journal({ event: 'exited', pid: child.pid, argv: consentModules.argvSummary(['opencode', ...args]), worktree: opts.dir, owner: opts.owner, reason: signal ?? `exit ${exit}` })
    cleanupBrief()
    endGroup(exit)
  }
  child.on('close', onChildClose)
  if (earlyChildClose) onChildClose(...earlyChildClose)
  else if (child.exitCode !== null || child.signalCode !== null) onChildClose(child.exitCode, child.signalCode)
  return 0
}

let isMain = false
try { isMain = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch {}
if (isMain) main().then((code) => { process.exitCode = code }).catch((error) => { process.stderr.write(`wt-lane: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
