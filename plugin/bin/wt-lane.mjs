#!/usr/bin/env node
// wt-lane.mjs -- detached, one-command external opencode lane launcher.

import { appendFileSync, mkdirSync, openSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFileSync as readLaneLog } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { resolveConsent } from './lib/lane-consent-check-core.mjs'
import { evaluateConsentGate } from './lib/lane-consent-gate-core.mjs'
import { effectiveSkillDiscoveryRefusal, materialiseAllowedSkills, opencodeChildEnv, opencodeSkillFenceRefusal, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence } from './lib/opencode-skill-fence.mjs'
import { resolveLaneSkillAllowlist } from './lib/lane-skill-allowlist.mjs'
import { laneModelRefusal } from './lib/lane-model-allowlist.mjs'
import { appendSupervisorJournal, argvSummary, classifyLane, inspectProcess, laneHardBoundAt, latestWorktreeWrite, processEvidenceStatus, readCurrentSupervision, readLogTail, shellQuote, supervisionPaths, terminateLane, writeJsonAtomic } from './lib/lane-supervisor-core.mjs'
import { resolvePluginDataDir } from './lib/plugin-data-dir.mjs'

const DEFAULT_TIMEOUT = 5400
const GRACE_MS = 250
const DEFAULT_DECISION_GRACE = 300
const DEFAULT_MAX_EXTENSIONS = 3
const DECISION_TRANSITION_BOUND_MS = 5_000

async function loadConsentModules() {
  return { resolveConsent, evaluateConsentGate, effectiveSkillDiscoveryRefusal, materialiseAllowedSkills, opencodeChildEnv, opencodeSkillFenceRefusal, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence, resolveLaneSkillAllowlist, laneModelRefusal, appendSupervisorJournal, argvSummary, classifyLane, inspectProcess, laneHardBoundAt, latestWorktreeWrite, processEvidenceStatus, readCurrentSupervision, readLogTail, shellQuote, supervisionPaths, terminateLane, writeJsonAtomic, resolvePluginDataDir }
}

function usage() {
  return 'Usage: node wt-lane.mjs --dir <project-root>/.claude/worktrees/<name> --model <provider/model> --brief <file> [--timeout 5400] [--decision-grace 300] [--max-extensions 3] [--owner session|pilot] [--owner-token <token>] [--log <path>] [--variant <name>] [--allow-no-git]'
}

function parse(argv) {
  const out = { dir: null, model: null, brief: null, timeout: DEFAULT_TIMEOUT, decisionGrace: DEFAULT_DECISION_GRACE, maxExtensions: DEFAULT_MAX_EXTENSIONS, owner: 'session', ownerToken: null, briefCleanupDir: null, log: null, allowNoGit: false, runId: null }
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
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `unknown argument: ${arg}` }
  }
  if (!out.dir || !out.model || !out.brief) return { error: 'missing required --dir, --model, or --brief' }
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) return { error: '--timeout must be a positive number of seconds' }
  if (!Number.isFinite(out.decisionGrace) || out.decisionGrace < 0) return { error: '--decision-grace must be a non-negative number of seconds' }
  if (!Number.isSafeInteger(out.maxExtensions) || out.maxExtensions < 0) return { error: '--max-extensions must be a non-negative integer' }
  if (!['session', 'pilot'].includes(out.owner)) return { error: '--owner must be session or pilot' }
  if (out.runId && !/^\d+-\d+$/.test(out.runId)) return { error: 'internal run id is malformed' }
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
  if (typeof consentModules.writeJsonAtomic !== 'function' || typeof consentModules.classifyLane !== 'function' || typeof consentModules.terminateLane !== 'function') {
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
    const paths = consentModules.supervisionPaths(opts.dir, runId)
    const lock = path.join(paths.dir, 'launch.lock')
    mkdirSync(paths.dir, { recursive: true })
    try { mkdirSync(lock) } catch {
      process.stderr.write(`wt-lane: Refused: another lane launch is in progress; abandon with node ${consentModules.shellQuote(path.join(path.dirname(process.argv[1]), 'wt-lane-control.mjs'))} --dir ${consentModules.shellQuote(opts.dir)} --decision abandon\n`)
      return 1
    }
    try {
      const current = consentModules.readCurrentSupervision(opts.dir)
      if (!current && existsSync(paths.pointer)) {
        process.stderr.write(`wt-lane: Refused: current lane supervision is unknown; abandon with node ${consentModules.shellQuote(path.join(path.dirname(process.argv[1]), 'wt-lane-control.mjs'))} --dir ${consentModules.shellQuote(opts.dir)} --decision abandon\n`)
        return 1
      }
      if (current) {
        const verdict = consentModules.classifyLane(current)
        const hardBound = consentModules.laneHardBoundAt(current)
        if (verdict.status === 'unknown' && hardBound !== null && Date.now() > hardBound) {
          try {
            const dataDir = path.join(consentModules.resolvePluginDataDir({ env: process.env }).dir, 'lane-supervisor')
            consentModules.appendSupervisorJournal(dataDir, { event: 'superseded', runId: current.runId, pid: current.childPid, argv: consentModules.argvSummary(current.childArgv ?? []), worktree: opts.dir, owner: current.owner ?? null, reason: `unknown beyond hard bound ${new Date(hardBound).toISOString()}` })
          } catch { /* a stale unknown lane may still be superseded when the audit sink is unavailable */ }
        } else if (!['terminal', 'gone'].includes(verdict.status)) {
          const token = current.ownerToken ? ` --owner-token ${consentModules.shellQuote(current.ownerToken)}` : ''
          process.stderr.write(`wt-lane: Refused: current lane ${current.runId} is ${verdict.status}; abandon with node ${consentModules.shellQuote(path.join(path.dirname(process.argv[1]), 'wt-lane-control.mjs'))} --dir ${consentModules.shellQuote(opts.dir)} --decision abandon${token}\n`)
          return 1
        }
      }
      const workerArgs = [process.argv[1], '--worker', '--dir', opts.dir, '--model', opts.model, '--brief', opts.brief, '--timeout', String(opts.timeout), '--decision-grace', String(opts.decisionGrace), '--max-extensions', String(opts.maxExtensions), '--owner', opts.owner, '--run-id', runId, ...(opts.ownerToken ? ['--owner-token', opts.ownerToken] : []), ...(opts.briefCleanupDir ? ['--brief-cleanup-dir', opts.briefCleanupDir] : []), '--log', opts.log, ...(opts.variant ? ['--variant', opts.variant] : []), ...(opts.allowNoGit ? ['--allow-no-git'] : [])]
      const child = spawn(process.execPath, workerArgs, { detached: true, stdio: 'ignore' })
      const identity = consentModules.inspectProcess(child.pid) ?? { argv: [process.execPath, ...workerArgs] }
      const timeoutAt = new Date(Date.now() + opts.timeout * 1000).toISOString()
      consentModules.writeJsonAtomic(paths.record, { version: 1, runId, state: 'launching', owner: opts.owner, ownerSessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null, ownerToken: opts.ownerToken, workerPid: child.pid, workerArgv: identity.argv, childPid: null, childArgv: null, worktree: opts.dir, timeoutAt, timeoutSeconds: opts.timeout, decisionGraceSeconds: opts.decisionGrace, decisionTransitionBoundMs: DECISION_TRANSITION_BOUND_MS, maxExtensions: opts.maxExtensions, extensionCount: 0 })
      consentModules.writeJsonAtomic(paths.pointer, { version: 1, runId })
      child.unref()
      writeFileSync(path.join(opts.dir, '.lane', 'pid'), `${child.pid}\n`)
      process.stdout.write(`pid=${child.pid}\nrun=${runId}\nlog=${opts.log}\n`)
      return 0
    } finally { rmSync(lock, { recursive: true, force: true }) }
  }

  const runId = opts.runId ?? `${process.pid}-${Date.now()}`
  const statePaths = consentModules.supervisionPaths(opts.dir, runId)
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
      child.once('spawn', resolve)
      child.once('error', reject)
    })
  } catch (error) {
    const reason = `opencode spawn failed: ${error instanceof Error ? error.message : String(error)}`
    consentModules.writeJsonAtomic(statePaths.record, { version: 1, runId, state: 'launch-failed', worktree: opts.dir, reason })
    return 1
  }
  const stateFile = statePaths.record
  const decisionFile = statePaths.decision
  const dataDir = path.join(consentModules.resolvePluginDataDir({ env: process.env }).dir, 'lane-supervisor')
  const journal = (event) => { try { consentModules.appendSupervisorJournal(dataDir, event) } catch { /* supervision must remain bounded when its audit sink is unavailable */ } }
  const childIdentity = consentModules.inspectProcess(child.pid) ?? { argv: ['opencode', ...args], cwd: opts.dir }
  const workerIdentity = consentModules.inspectProcess(process.pid) ?? { argv: process.argv }
  const baseState = { version: 1, runId, state: 'running', owner: opts.owner, ownerSessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null, ownerToken: opts.ownerToken, workerPid: process.pid, workerArgv: workerIdentity.argv, childPid: child.pid, childArgv: childIdentity.argv, worktree: opts.dir, log: opts.log, launchedAt: new Date().toISOString(), timeoutSeconds: opts.timeout, decisionGraceSeconds: opts.decisionGrace, decisionTransitionBoundMs: DECISION_TRANSITION_BOUND_MS, maxExtensions: opts.maxExtensions, extensionCount: 0, defaultDecision: 'extend' }
  let currentState = baseState
  const writeState = (extra) => {
    currentState = { ...baseState, ...extra }
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
    consentModules.terminateLane(currentState, { graceMs: GRACE_MS, journal, source: 'worker', ...(terminal ? { markTerminal: (stage) => writeState(stage === 'terminal' ? terminal : { ...terminal, state: 'terminating' }) } : {}) })
  }
  terminateWorker = (code) => { clearTimeout(timer); clearTimeout(graceTimer); cleanupBrief(); endGroup(code, { terminal: { state: 'abandoned', decision: 'abandon', decisionSource: 'signal', decidedAt: new Date().toISOString() } }) }
  const cleanupBrief = () => {
    if (opts.briefCleanupDir && opts.brief.startsWith(`${opts.briefCleanupDir}${path.sep}`)) rmSync(opts.briefCleanupDir, { recursive: true, force: true })
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
  child.on('close', (code, signal) => {
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
  })
  return 0
}

main().then((code) => { process.exitCode = code }).catch((error) => { process.stderr.write(`wt-lane: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
