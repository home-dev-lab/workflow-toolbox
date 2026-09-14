#!/usr/bin/env node
// wt-lane.mjs -- detached, one-command external opencode lane launcher.

import { appendFileSync, closeSync, mkdirSync, openSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFileSync as readLaneLog } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { resolveConsent } from './lib/lane-consent-check-core.mjs'
import { evaluateConsentGate } from './lib/lane-consent-gate-core.mjs'
import { effectiveSkillDiscoveryRefusal, materialiseAllowedSkills, opencodeChildEnv, opencodeSkillFenceRefusal, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence } from './lib/opencode-skill-fence.mjs'
import { resolveLaneSkillAllowlist } from './lib/lane-skill-allowlist.mjs'
import { laneModelRefusal } from './lib/lane-model-allowlist.mjs'
import { appendSupervisorJournal, argvSummary, inspectProcess, latestWorktreeWrite, processEvidenceStatus, readLogTail, supervisionPaths, writeJsonAtomic } from './lib/lane-supervisor-core.mjs'
import { resolvePluginDataDir } from './lib/plugin-data-dir.mjs'

const DEFAULT_TIMEOUT = 5400
const GRACE_MS = 250
const DEFAULT_DECISION_GRACE = 300
const DEFAULT_MAX_EXTENSIONS = 3
// Parent and worker each run ssh-add plus the three 30-second OpenCode probes.
const REPLACEMENT_PREFLIGHT_BOUND_MS = 2 * (3_000 + 3 * 30_000) + 10_000

function bootstrapSupervisionPaths(root, runId) {
  const dir = path.join(root, '.lane', 'supervision')
  return { record: path.join(dir, `${runId}.json`), handoff: path.join(dir, `${runId}.handoff.json`) }
}

function writeBootstrapState(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
}

async function loadConsentModules() {
  return { resolveConsent, evaluateConsentGate, effectiveSkillDiscoveryRefusal, materialiseAllowedSkills, opencodeChildEnv, opencodeSkillFenceRefusal, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence, resolveLaneSkillAllowlist, laneModelRefusal, appendSupervisorJournal, argvSummary, inspectProcess, latestWorktreeWrite, processEvidenceStatus, readLogTail, supervisionPaths, writeJsonAtomic, resolvePluginDataDir }
}

function usage() {
  return 'Usage: node wt-lane.mjs --dir <project-root>/.claude/worktrees/<name> --model <provider/model> --brief <file> [--timeout 5400] [--decision-grace 300] [--max-extensions 3] [--owner session|pilot] [--owner-token <token>] [--log <path>] [--variant <name>] [--allow-no-git]'
}

function parse(argv) {
  const out = { dir: null, model: null, brief: null, timeout: DEFAULT_TIMEOUT, decisionGrace: DEFAULT_DECISION_GRACE, maxExtensions: DEFAULT_MAX_EXTENSIONS, owner: 'session', ownerToken: null, briefCleanupDir: null, log: null, allowNoGit: false, runId: null, replacesRun: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir') out.dir = argv[++i] ?? null
    else if (arg === '--model') out.model = argv[++i] ?? null
    else if (arg === '--brief') out.brief = argv[++i] ?? null
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
    else if (arg === '--replaces-run') out.replacesRun = argv[++i] ?? null
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `unknown argument: ${arg}` }
  }
  if (!out.dir || !out.model || !out.brief) return { error: 'missing required --dir, --model, or --brief' }
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) return { error: '--timeout must be a positive number of seconds' }
  if (!Number.isFinite(out.decisionGrace) || out.decisionGrace < 0) return { error: '--decision-grace must be a non-negative number of seconds' }
  if (!Number.isSafeInteger(out.maxExtensions) || out.maxExtensions < 0) return { error: '--max-extensions must be a non-negative integer' }
  if (!['session', 'pilot'].includes(out.owner)) return { error: '--owner must be session or pilot' }
  if ((out.runId && !/^\d+-\d+$/.test(out.runId)) || (out.replacesRun && !/^\d+-\d+$/.test(out.replacesRun))) return { error: 'internal run ids are malformed' }
  // opencode's built-in effort axis; an unknown name falls back SILENTLY to the default on the opencode side, so it is validated here.
  if (out.variant !== undefined && out.variant !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out.variant)) return { error: '--variant must be a plain variant name' }
  out.dir = path.resolve(out.dir)
  out.brief = path.resolve(out.brief)
  if (out.briefCleanupDir) out.briefCleanupDir = path.resolve(out.briefCleanupDir)
  out.log = path.resolve(out.log ?? path.join(out.dir, '.lane', 'run.log'))
  return out
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

async function main() {
  const worker = process.argv[2] === '--worker'
  const opts = parse(process.argv.slice(worker ? 3 : 2))
  if (opts.help) { process.stdout.write(`${usage()}\n`); return 0 }
  if (opts.error) { process.stderr.write(`wt-lane: ${opts.error}\n${usage()}\n`); return 2 }
  if (!existsSync(opts.dir) || !statSync(opts.dir).isDirectory()) { process.stderr.write(`wt-lane: --dir is not a directory: ${opts.dir}\n`); return 2 }
  if (opts.replacesRun) writeBootstrapState(bootstrapSupervisionPaths(opts.dir, opts.runId).record, { version: 1, runId: opts.runId, state: 'launching', replacesRun: opts.replacesRun, worktree: opts.dir, launcherPid: process.pid, launchedAt: new Date().toISOString() })
  if (!existsSync(opts.brief)) { process.stderr.write(`wt-lane: --brief does not exist: ${opts.brief}\n`); return 2 }
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
  if (typeof consentModules.writeJsonAtomic !== 'function' || typeof consentModules.supervisionPaths !== 'function' || typeof consentModules.processEvidenceStatus !== 'function') {
    process.stderr.write('wt-lane: Refused: the installed workflow-toolbox plugin is too old for this adopted launcher; update the plugin and re-adopt wt-lane.mjs.\n')
    return 1
  }
  const modelRefusal = consentModules.laneModelRefusal(opts.model, { env: process.env })
  if (modelRefusal) { process.stderr.write(`${modelRefusal}\n`); return 1 }
  const consent = consentModules.evaluateConsentGate(
    { tool_input: { command: 'opencode run' }, cwd: opts.dir },
    { resolveConsentImpl: consentModules.resolveConsent },
  )
  if (!consent.silent) { process.stderr.write(`${consent.message}\n`); return 1 }

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

  const fence = consentModules.verifyOpencodeSkillFence('opencode')
  if (!fence.ok) { process.stderr.write(`${consentModules.opencodeSkillFenceRefusal(fence.reason)}\n`); return 1 }
  if (allowlist.allowed.length && !fence.allowOk) {
    process.stderr.write(`${consentModules.opencodeSkillFenceRefusal(`the allow-list half failed for ${fence.mechanism}: ${fence.allowReason ?? 'the materialised skill was not visible'}`)}\n`)
    return 1
  }

  const childEnv = { ...consentModules.opencodeChildEnv(process.env), ...(allowlist.allowed.length ? { OPENCODE_CONFIG: allowedSkills.configPath } : {}) }
  const discovery = consentModules.verifyEffectiveOpencodeSkillDiscovery('opencode', { cwd: opts.dir, env: childEnv })
  if (!discovery.ok) {
    process.stderr.write(`${consentModules.effectiveSkillDiscoveryRefusal(discovery)}\n`)
    return 1
  }

  if (!worker) {
    mkdirSync(path.join(opts.dir, '.lane'), { recursive: true })
    const runId = opts.runId ?? `${process.pid}-${Date.now()}`
    const child = spawn(process.execPath, [process.argv[1], '--worker', '--dir', opts.dir, '--model', opts.model, '--brief', opts.brief, '--timeout', String(opts.timeout), '--decision-grace', String(opts.decisionGrace), '--max-extensions', String(opts.maxExtensions), '--owner', opts.owner, '--run-id', runId, ...(opts.replacesRun ? ['--replaces-run', opts.replacesRun] : []), ...(opts.ownerToken ? ['--owner-token', opts.ownerToken] : []), ...(opts.briefCleanupDir ? ['--brief-cleanup-dir', opts.briefCleanupDir] : []), '--log', opts.log, ...(opts.variant ? ['--variant', opts.variant] : []), ...(opts.allowNoGit ? ['--allow-no-git'] : [])], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    writeFileSync(path.join(opts.dir, '.lane', 'pid'), `${child.pid}\n`)
    process.stdout.write(`pid=${child.pid}\nrun=${runId}\nlog=${opts.log}\n`)
    return 0
  }

  const runId = opts.runId ?? `${process.pid}-${Date.now()}`
  const statePaths = consentModules.supervisionPaths(opts.dir, runId)
  if (opts.replacesRun) {
    try {
      const lock = openSync(statePaths.handoff, 'wx', 0o600)
      writeFileSync(lock, `${JSON.stringify({ version: 1, runId, outcome: 'starting', workerPid: process.pid, workerArgv: process.argv })}\n`)
      closeSync(lock)
    } catch {
      consentModules.writeJsonAtomic(statePaths.record, { version: 1, runId, state: 'launch-failed', replacesRun: opts.replacesRun, worktree: opts.dir, reason: 'relaunch outcome was already concluded' })
      return 1
    }
  }
  mkdirSync(path.dirname(opts.log), { recursive: true })
  writeEnvLog(opts.dir)
  let receiptPrefix = ''
  try {
    const first = readFileSync(opts.log, 'utf8').split(/\r?\n/, 1)[0]
    if (/^LANE_NONCE=/.test(first)) receiptPrefix = `${first}\n`
  } catch {}
  writeFileSync(opts.log, `${receiptPrefix}LANE_RUN_ID=${runId}\n`)
  const fd = openSync(opts.log, 'a')
  let terminateWorker = null
  let pendingTermination = null
  process.on('SIGTERM', () => { if (terminateWorker) terminateWorker(143); else pendingTermination = 143 })
  process.on('SIGINT', () => { if (terminateWorker) terminateWorker(130); else pendingTermination = 130 })
  const args = ['run', `Read and execute the complete brief at ${opts.brief}.`, '--auto', '--dir', opts.dir, '--model', opts.model, ...(opts.variant ? ['--variant', opts.variant] : [])]
  // OpenCode honours this runtime flag by skipping ~/.claude/skills and project .claude/skills,
  // preserving its own and .agents skills while fencing the harness's single-writer memory skills.
  let child
  try {
    child = spawn('opencode', args, { cwd: opts.dir, env: childEnv, stdio: ['ignore', fd, fd] })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        reject(new Error('opencode spawn did not settle within 5 seconds'))
      }, 5_000)
      child.once('spawn', () => { clearTimeout(timer); resolve() })
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
    })
  } catch (error) {
    const reason = `opencode spawn failed: ${error instanceof Error ? error.message : String(error)}`
    consentModules.writeJsonAtomic(statePaths.record, { version: 1, runId, state: 'launch-failed', replacesRun: opts.replacesRun, worktree: opts.dir, reason })
    if (opts.replacesRun) consentModules.writeJsonAtomic(statePaths.handoff, { version: 1, runId, outcome: 'failed', reason })
    return 1
  }
  const stateFile = statePaths.record
  const decisionFile = statePaths.decision
  const dataDir = path.join(consentModules.resolvePluginDataDir({ env: process.env }).dir, 'lane-supervisor')
  const journal = (event) => { try { consentModules.appendSupervisorJournal(dataDir, event) } catch { /* supervision must remain bounded when its audit sink is unavailable */ } }
  const launcherArgs = ['--dir', opts.dir, '--model', opts.model, '--brief', opts.brief, '--timeout', String(opts.timeout), '--decision-grace', String(opts.decisionGrace), '--max-extensions', String(opts.maxExtensions), '--owner', opts.owner, ...(opts.ownerToken ? ['--owner-token', opts.ownerToken] : []), ...(opts.briefCleanupDir ? ['--brief-cleanup-dir', opts.briefCleanupDir] : []), '--log', opts.log, ...(opts.variant ? ['--variant', opts.variant] : []), ...(opts.allowNoGit ? ['--allow-no-git'] : [])]
  const childIdentity = consentModules.inspectProcess(child.pid) ?? { argv: ['opencode', ...args], cwd: opts.dir }
  const baseState = { version: 1, runId, state: 'running', replacesRun: opts.replacesRun, owner: opts.owner, ownerSessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null, ownerToken: opts.ownerToken, workerPid: process.pid, workerArgv: process.argv, childPid: child.pid, childArgv: childIdentity.argv, worktree: opts.dir, log: opts.log, launchedAt: new Date().toISOString(), timeoutSeconds: opts.timeout, decisionGraceSeconds: opts.decisionGrace, maxExtensions: opts.maxExtensions, extensionCount: 0, defaultDecision: 'extend', launcherArgs }
  const writeState = (extra) => {
    consentModules.writeJsonAtomic(stateFile, { ...baseState, ...extra })
    return true
  }
  rmSync(decisionFile, { force: true })
  const firstTimeoutAt = new Date(Date.now() + opts.timeout * 1000).toISOString()
  writeState({ timeoutAt: firstTimeoutAt })
  consentModules.writeJsonAtomic(statePaths.pointer, { version: 1, runId })
  if (opts.replacesRun) consentModules.writeJsonAtomic(statePaths.handoff, { version: 1, runId, outcome: 'started' })
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
  const endGroup = (code, { writeReceipt = true } = {}) => {
    if (writeReceipt) finish(code)
    process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT')
    process.on('SIGTERM', () => {}); process.on('SIGINT', () => {})
    if (process.platform === 'win32') {
      try { spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { detached: true, stdio: 'ignore' }).unref() } catch { /* child close or process exit remains the backstop */ }
      return
    }
    try { process.kill(-process.pid, 'SIGTERM') } catch { /* already exited */ }
    setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL') } catch { /* already exited */ } }, GRACE_MS).unref()
  }
  terminateWorker = (code) => { clearTimeout(timer); clearTimeout(graceTimer); cleanupBrief(); endGroup(code) }
  const cleanupBrief = () => {
    if (opts.briefCleanupDir && opts.brief.startsWith(`${opts.briefCleanupDir}${path.sep}`)) rmSync(opts.briefCleanupDir, { recursive: true, force: true })
  }
  let timer
  let graceTimer
  let handedOff = false
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
          writeState({ state: 'abandoned', decision: 'abandon', decisionSource: 'grace-default', decidedAt: new Date().toISOString(), extensionCount, evidence })
          journal({ event: 'decision', decision: 'abandon', source: 'grace-default', pid: child.pid, argv: consentModules.argvSummary(['opencode', ...args]), worktree: opts.dir, owner: opts.owner, reason: 'extension ceiling reached' })
          cleanupBrief()
          endGroup(126)
        }
      } catch {}
    }, opts.decisionGrace * 1000)
    graceTimer.unref()
  }
  const armTimeout = (seconds) => {
    clearTimeout(timer)
    clearTimeout(graceTimer)
    scheduledTimeoutAt = new Date(Date.now() + seconds * 1000).toISOString()
    writeState({ state: 'running', timeoutAt: scheduledTimeoutAt, extensionCount })
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
    if (decision.runId !== runId || decision.timeoutAt !== current.timeoutAt || current.state !== 'decision-needed' || !['extend', 'relaunch', 'abandon'].includes(decision.decision)) return
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
        writeState({ state: 'abandoned', decision: 'abandon', decisionSource: 'extension-ceiling', decidedAt: new Date().toISOString(), extensionCount })
        cleanupBrief(); endGroup(126)
      }
    } else if (decision.decision === 'relaunch') {
      const replacementRunId = `${process.pid}-${Date.now()}`
      const replacementPaths = consentModules.supervisionPaths(opts.dir, replacementRunId)
      const deadlineAt = new Date(Date.now() + REPLACEMENT_PREFLIGHT_BOUND_MS).toISOString()
      const relaunchDecisionAt = current.timeoutAt
      writeState({ state: 'relaunching', timeoutAt: current.timeoutAt, replacementRunId, relaunchDecisionAt, relaunchOutcome: 'pending', relaunchDeadlineAt: deadlineAt })
      const launch = spawnSync(process.execPath, [process.argv[1], ...launcherArgs, '--run-id', replacementRunId, '--replaces-run', runId], { encoding: 'utf8', env: process.env, timeout: REPLACEMENT_PREFLIGHT_BOUND_MS })
      let outcome = null
      while (true) {
        try { outcome = JSON.parse(readFileSync(replacementPaths.handoff, 'utf8')) } catch {}
        if (outcome?.outcome === 'started' || outcome?.outcome === 'failed') break
        try {
          const replacement = JSON.parse(readFileSync(replacementPaths.record, 'utf8'))
          if (replacement.state === 'launch-failed') { outcome = { outcome: 'failed', reason: replacement.reason }; break }
        } catch {}
        if (Date.now() > Date.parse(deadlineAt) && outcome?.outcome !== 'starting') break
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      }
      if (outcome?.outcome !== 'started') {
        const failure = outcome?.reason ?? (launch.stderr || launch.stdout || `replacement preflight exceeded its ${REPLACEMENT_PREFLIGHT_BOUND_MS}ms bound`).trim().slice(0, 500)
        try { writeFileSync(replacementPaths.handoff, `${JSON.stringify({ version: 1, runId: replacementRunId, outcome: 'failed', reason: failure })}\n`, { flag: 'wx', mode: 0o600 }) } catch {}
        journal({ event: 'relaunch-failed', decision: 'relaunch', source: 'owner', pid: child.pid, argv: consentModules.argvSummary(['opencode', ...args]), worktree: opts.dir, owner: opts.owner, reason: failure })
        scheduledTimeoutAt = new Date().toISOString()
        enterDecision('relaunch-failed', { replacementRunId, relaunchDecisionAt, relaunchOutcome: 'failed', relaunchFailure: failure })
        return
      }
      writeState({ state: 'relaunched', replacementRunId, relaunchDecisionAt, relaunchOutcome: 'started', decidedAt: new Date().toISOString() })
      journal({ event: 'decision', decision: 'relaunch', source: 'owner', pid: child.pid, argv: consentModules.argvSummary(['opencode', ...args]), worktree: opts.dir, owner: opts.owner, reason: decision.reason ?? null })
      clearInterval(decisions)
      handedOff = true
      endGroup(125, { writeReceipt: false })
    } else {
      journal({ event: 'decision', decision: 'abandon', source: 'owner', pid: child.pid, argv: consentModules.argvSummary(['opencode', ...args]), worktree: opts.dir, owner: opts.owner, reason: decision.reason ?? null })
      clearInterval(decisions)
      writeState({ state: 'abandoned', decision: 'abandon', decisionSource: 'owner', decidedAt: new Date().toISOString(), extensionCount })
      cleanupBrief(); endGroup(126)
    }
  }, 100)
  decisions.unref()
  child.on('error', () => { clearTimeout(timer); clearTimeout(graceTimer); clearInterval(decisions); cleanupBrief(); finish(1) })
  child.on('close', (code, signal) => {
    clearTimeout(timer); clearTimeout(graceTimer); clearInterval(decisions)
    if (handedOff) return
    const exit = signal ? 124 : (code ?? 1)
    writeState({ state: 'exited', exit, exitedAt: new Date().toISOString() })
    journal({ event: 'exited', pid: child.pid, argv: consentModules.argvSummary(['opencode', ...args]), worktree: opts.dir, owner: opts.owner, reason: signal ?? `exit ${exit}` })
    cleanupBrief()
    endGroup(exit)
  })
  return 0
}

main().then((code) => {
  if (code) {
    const worker = process.argv[2] === '--worker'
    const opts = parse(process.argv.slice(worker ? 3 : 2))
    if (!opts.error && opts.replacesRun && opts.runId && existsSync(opts.dir)) {
      const paths = bootstrapSupervisionPaths(opts.dir, opts.runId)
      const reason = `replacement ${worker ? 'worker' : 'launcher'} exited with code ${code}`
      try { writeBootstrapState(paths.record, { version: 1, runId: opts.runId, state: 'launch-failed', replacesRun: opts.replacesRun, worktree: opts.dir, reason }) } catch {}
      try { writeFileSync(paths.handoff, `${JSON.stringify({ version: 1, runId: opts.runId, outcome: 'failed', reason })}\n`, { flag: 'wx', mode: 0o600 }) } catch {}
    }
  }
  process.exitCode = code
}).catch((error) => { process.stderr.write(`wt-lane: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
