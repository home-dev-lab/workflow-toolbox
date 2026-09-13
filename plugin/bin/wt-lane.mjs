#!/usr/bin/env node
// wt-lane.mjs -- detached, one-command external opencode lane launcher.

import { appendFileSync, mkdirSync, openSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { readFileSync as readLaneLog } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { resolveConsent } from './lib/lane-consent-check-core.mjs'
import { evaluateConsentGate } from './lib/lane-consent-gate-core.mjs'
import { effectiveSkillDiscoveryRefusal, materialiseAllowedSkills, opencodeChildEnv, opencodeSkillFenceRefusal, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence } from './lib/opencode-skill-fence.mjs'
import { resolveLaneSkillAllowlist } from './lib/lane-skill-allowlist.mjs'

const DEFAULT_TIMEOUT = 5400
const GRACE_MS = 250

async function loadConsentModules() {
  return { resolveConsent, evaluateConsentGate, effectiveSkillDiscoveryRefusal, materialiseAllowedSkills, opencodeChildEnv, opencodeSkillFenceRefusal, verifyEffectiveOpencodeSkillDiscovery, verifyOpencodeSkillFence, resolveLaneSkillAllowlist }
}

function usage() {
  return 'Usage: node wt-lane.mjs --dir <project-root>/.claude/worktrees/<name> --model <provider/model> --brief <file> [--timeout 5400] [--log <path>] [--variant <name>] [--allow-no-git]'
}

function parse(argv) {
  const out = { dir: null, model: null, brief: null, timeout: DEFAULT_TIMEOUT, log: null, allowNoGit: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir') out.dir = argv[++i] ?? null
    else if (arg === '--model') out.model = argv[++i] ?? null
    else if (arg === '--brief') out.brief = argv[++i] ?? null
    else if (arg === '--timeout') out.timeout = Number(argv[++i])
    else if (arg === '--log') out.log = argv[++i] ?? null
    else if (arg === '--variant') out.variant = argv[++i] ?? null
    else if (arg === '--allow-no-git') out.allowNoGit = true
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `unknown argument: ${arg}` }
  }
  if (!out.dir || !out.model || !out.brief) return { error: 'missing required --dir, --model, or --brief' }
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) return { error: '--timeout must be a positive number of seconds' }
  // opencode's built-in effort axis; an unknown name falls back SILENTLY to the default on the opencode side, so it is validated here.
  if (out.variant !== undefined && out.variant !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out.variant)) return { error: '--variant must be a plain variant name' }
  out.dir = path.resolve(out.dir)
  out.brief = path.resolve(out.brief)
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
    const child = spawn(process.execPath, [process.argv[1], '--worker', '--dir', opts.dir, '--model', opts.model, '--brief', opts.brief, '--timeout', String(opts.timeout), '--log', opts.log, ...(opts.variant ? ['--variant', opts.variant] : []), ...(opts.allowNoGit ? ['--allow-no-git'] : [])], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    writeFileSync(path.join(opts.dir, '.lane', 'pid'), `${child.pid}\n`)
    process.stdout.write(`pid=${child.pid}\nlog=${opts.log}\n`)
    return 0
  }

  mkdirSync(path.dirname(opts.log), { recursive: true })
  writeEnvLog(opts.dir)
  const fd = openSync(opts.log, 'a')
  const args = ['run', `Read and execute the complete brief at ${opts.brief}.`, '--auto', '--dir', opts.dir, '--model', opts.model, ...(opts.variant ? ['--variant', opts.variant] : [])]
  // OpenCode honours this runtime flag by skipping ~/.claude/skills and project .claude/skills,
  // preserving its own and .agents skills while fencing the harness's single-writer memory skills.
  const child = spawn('opencode', args, {
    cwd: opts.dir,
    env: childEnv,
    stdio: ['ignore', fd, fd],
  })
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
  const endGroup = (code) => {
    finish(code)
    process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT')
    process.on('SIGTERM', () => {}); process.on('SIGINT', () => {})
    try { process.kill(-process.pid, 'SIGTERM') } catch { /* already exited */ }
    setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL') } catch { /* already exited */ } }, GRACE_MS).unref()
  }
  const timer = setTimeout(() => endGroup(124), opts.timeout * 1000)
  timer.unref()
  process.on('SIGTERM', () => { clearTimeout(timer); endGroup(143) })
  process.on('SIGINT', () => { clearTimeout(timer); endGroup(130) })
  child.on('error', () => { clearTimeout(timer); finish(1) })
  child.on('close', (code, signal) => { clearTimeout(timer); finish(signal ? 124 : (code ?? 1)) })
  return 0
}

main().then((code) => { process.exitCode = code })
