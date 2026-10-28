// File-backed shell execution, launch observations, and bounded fixture-child cleanup.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const POLL_MS = 20

function fileState(path) {
  try { return `exists=true bytes=${statSync(path).size}` } catch (error) {
    if (error.code === 'ENOENT') return 'exists=false bytes=0'
    return `state=${error.code}`
  }
}

export function launchDiagnostics(f) {
  const step = f.launch ?? {}
  return [`shell=${step.shell ?? 'not-started'}`, `shellExitMs=${step.exitMs ?? 'pending'}`,
    `shellStatus=${step.status ?? 'null'}`, `shellWaitMs=${step.waitMs ?? 'pending'}`, `shellSignal=${step.signal ?? 'none'}`,
    `shellError=${step.error ?? 'none'}`, `out(${fileState(f.out)})`,
    `launchLog(${fileState(`${f.out}.launch.log`)})`,
    `stdoutLog(${fileState(`${f.out}.launch.stdout.log`)})`,
    `elapsedMs=${Math.round(performance.now() - (f.started ?? performance.now()))}`].join(' ')
}

// Use real files, never pipes: shell exit must not wait for a descendant's pipe EOF.
export async function runShell(f, shell, args, { env, shellTimeoutMs }) {
  f.started = performance.now()
  f.launch = { shell }
  const stdout = openSync(`${f.out}.shell.stdout.log`, 'a')
  const stderr = openSync(`${f.out}.shell.stderr.log`, 'a')
  try {
    return await new Promise((resolve) => {
      const child = spawn(shell, args, { cwd: f.repo, env, stdio: ['ignore', stdout, stderr], windowsHide: true })
      f.shellChild = child
      let settled = false
      const finish = (status, signal, error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const waitMs = Math.round(performance.now() - f.started)
        Object.assign(f.launch, { status, signal, error, waitMs, exitMs: error ? 'not-observed' : waitMs })
        resolve(f.launch)
      }
      const timer = setTimeout(() => {
        // Keep a timed-out shell alive until cleanup can terminate its whole Windows tree.
        // Killing PowerShell first could orphan a cold launcher before it records its node PID.
        finish(null, null, 'ETIMEDOUT')
      }, shellTimeoutMs)
      child.once('error', (error) => finish(null, null, error.code))
      child.once('exit', (code, signal) => {
        if (!settled) finish(code, signal, null)
        Object.assign(f.launch, { status: code, signal, exitMs: Math.round(performance.now() - f.started) })
      })
    })
  } finally {
    closeSync(stdout)
    closeSync(stderr)
  }
}

export function completed(out) {
  if (existsSync(out) && /\nEXIT=\d+\r?\n?$/.test(readFileSync(out, 'utf8'))) return 'out'
  const log = `${out}.launch.log`
  return existsSync(log) && /Error|not found|No such file|REFUSED:/.test(readFileSync(log, 'utf8')) ? 'log' : null
}

export async function waitForLaunch(f, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  let state
  while (!(state = completed(f.out)) && performance.now() < deadline) await delay(POLL_MS)
  assert.ok(state, `launch completion timed out; ${launchDiagnostics(f)}`)
  return state
}

function isAlive(pid) {
  try { process.kill(pid, 0) } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
  // Detached POSIX children can remain zombies until their reaper runs; they hold no files.
  if (process.platform === 'linux') {
    try { return !/^ [ZX] /.test(readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1)) } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }
  return true
}

function recordedPid(path) {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim())
    return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid ? pid : null
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

function liveChildren(f) {
  const pids = new Set()
  if (f.shellChild?.pid && f.shellChild.exitCode === null && f.shellChild.signalCode === null) pids.add(f.shellChild.pid)
  for (const suffix of ['launch.pid', 'child.pid']) {
    const pid = recordedPid(`${f.out}.${suffix}`)
    if (pid) pids.add(pid)
  }
  return [...pids].filter(isAlive)
}

async function waitForChildren(f, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  let pids
  while ((pids = liveChildren(f)).length && performance.now() < deadline) await delay(POLL_MS)
  return pids
}

function terminationErrorCode(result) {
  return result.error?.code ?? 'none'
}

export function terminatePid(pid, { tree = process.platform === 'win32', run = spawnSync } = {}) {
  if (!tree) {
    try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    return
  }
  const result = run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore', windowsHide: true, timeout: 10_000,
  })
  assert.ok(!result.error && (result.status === 0 || !isAlive(pid)),
    `fixture process-tree termination failed: pid=${pid} status=${result.status} error=${terminationErrorCode(result)}`)
}

// The fixture runs only a bootstrap and a sealed refusal/stub: no model descendants.
export async function cleanupLaunch(f, { graceMs = 5_000, killWaitMs = 5_000, terminate = terminatePid } = {}) {
  const remaining = await waitForChildren(f, graceMs)
  for (const pid of remaining) terminate(pid)
  const survivors = await waitForChildren(f, killWaitMs)
  assert.equal(survivors.length, 0, `fixture children still alive (${survivors.join(',')}); ${launchDiagnostics(f)}`)
  return { killed: remaining.length }
}
