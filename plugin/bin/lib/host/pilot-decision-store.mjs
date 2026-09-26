import { homedir } from 'node:os'
import { dirname, join, resolve, posix, win32 } from 'node:path'
import * as hostFs from 'node:fs'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { processStartTime } from './pid-namespace.mjs'

const RUN_ID = /^[A-Za-z0-9._-]+$/
let serial = 0

export function pilotDecisionStateRoot({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'workflow-toolbox', 'pilot-runs')
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'workflow-toolbox', 'pilot-runs')
  return posix.join(env.XDG_STATE_HOME || posix.join(home, '.local', 'state'), 'workflow-toolbox', 'pilot-runs')
}

export function pilotDecisionStateFile(runId, options = {}) {
  if (!RUN_ID.test(String(runId ?? '')) || runId === '.' || runId === '..') throw new Error(`invalid pilot run id: ${String(runId)}`)
  return join(resolve(options.root ?? pilotDecisionStateRoot(options)), runId, 'dod-decisions.json')
}

export function displayedDecisionStateRoot(root, computedDefault, { env = process.env, platform = process.platform, injected = false } = {}) {
  let environmentRoot = false
  if (platform === 'win32') environmentRoot = Boolean(env.LOCALAPPDATA)
  else if (platform === 'linux') environmentRoot = Boolean(env.XDG_STATE_HOME)
  return injected || root !== computedDefault || environmentRoot ? root : null
}

export function pilotDecisionCommand(cli, runId, execPath = process.execPath, root = null, platform = process.platform, suffix = '') {
  const posix = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
  const powershell = (value) => `'${String(value).replaceAll("'", "''")}'`
  const command = (quote) => {
    const stateRoot = root ? ' --state-root ' + quote(root) : ''
    return `${quote(execPath)} ${quote(cli)} decide --run ${quote(runId)}${stateRoot}${suffix}`
  }
  return platform === 'win32' ? `${command(posix)}\nPowerShell: & ${command(powershell)}` : command(posix)
}

export function pilotDecisionCli() {
  return fileURLToPath(new URL('../../wt-pilot-runner.mjs', import.meta.url))
}

function atomicJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${++serial}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function readState(file) {
  const state = JSON.parse(readFileSync(file, 'utf8'))
  if (state?.version !== 1 || typeof state.runId !== 'string' || !state.requests || !state.decisions) throw new Error(`invalid pilot decision state: ${file}`)
  return state
}

function lockRecord(text) {
  try {
    const record = JSON.parse(text)
    return typeof record.token === 'string' && Number.isSafeInteger(record.pid) && record.pid > 0 && (record.start === null || Number.isFinite(record.start)) ? record : null
  } catch { return null }
}

function observedLockText(fs, path) {
  try { return fs.readFileSync(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') throw error
    return null // Unreadable owner: only the age fallback can authorize reclamation.
  }
}

function holderGone(record, { startTime, pidExists }) {
  if (!record) return null
  if (pidExists(record.pid) === false) return true
  const current = startTime(record.pid)
  return record.start !== null && current !== null ? current !== record.start : false
}

function releaseOwnedLock(lock, token, fs) {
  try {
    if (lockRecord(fs.readFileSync(lock, 'utf8'))?.token === token) {
      // The read and unlink cannot be atomic in portable Node: a replacement between them remains possible.
      fs.rmSync(lock)
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}

function moveReclaimableLock(fs, lock, staleName, observed, observedText) {
  fs.renameSync(lock, staleName)
  let reclaimed = true
  try {
    const moved = fs.statSync(staleName)
    if (moved.ino !== observed.ino || moved.dev !== observed.dev || observedLockText(fs, staleName) !== observedText) {
      // A replacement was moved: publish it back only if the pathname is still vacant.
      // If another writer won it, retain the displaced live owner for that writer to see.
      reclaimed = false
      try { fs.linkSync(staleName, lock); fs.rmSync(staleName) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
  } finally { if (reclaimed) fs.rmSync(staleName, { force: true }) }
}

function hostPidExists(candidate) {
  try {
    process.kill(candidate, 0)
    return true
  } catch (error) {
    return error.code === 'ESRCH' ? false : null
  }
}

function withPilotDecisionLock(file, update, { fs = hostFs, startTime = processStartTime, pid = process.pid, pidExists = hostPidExists, now = Date.now, pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10), token = randomUUID() } = {}) {
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const lock = `${file}.lock`
  const start = now()
  let fd
  const owner = JSON.stringify({ token, pid, start: startTime(pid) })
  const staleName = `${lock}.${token}.stale`
  const owned = (path) => {
    try { return lockRecord(observedLockText(fs, path))?.token === token } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600)
      try { fs.writeFileSync(fd, owner) } catch (error) {
        fs.closeSync(fd)
        fd = undefined
        // This pathname was just created by our exclusive open; no other writer can own it yet.
        fs.rmSync(lock)
        throw error
      }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const observed = fs.statSync(lock)
        const observedText = observedLockText(fs, lock)
        const record = lockRecord(observedText)
        // A partial/unreadable owner cannot establish liveness; age is the bounded fallback only here.
        if (holderGone(record, { startTime, pidExists }) === true || (!record && now() - observed.mtimeMs > 30_000)) moveReclaimableLock(fs, lock, staleName, observed, observedText)
      } catch (statError) { if (statError.code !== 'ENOENT') throw statError }
      if (now() - start > 35_000) throw new Error(`pilot decision lock timed out: ${lock}`, { cause: error })
      // The CLI's synchronous public API cannot yield an async retry without changing its callers.
      pause()
    }
  }
  try {
    // A reclaimer may have moved a replacement lock. Its owner stays visible at .stale;
    // never enter while that displaced owner is still running.
    for (;;) {
      const live = fs.readdirSync(dirname(lock)).some((name) => {
        if (!name.startsWith(`${lock.slice(dirname(lock).length + 1)}.`) || !name.endsWith('.stale')) return false
        const path = join(dirname(lock), name)
        try {
          const record = lockRecord(observedLockText(fs, path))
          if (!record && now() - fs.statSync(path).mtimeMs > 30_000) { fs.rmSync(path); return false }
          return holderGone(record, { startTime, pidExists }) !== true
        } catch (error) { return error.code !== 'ENOENT' }
      })
      if (!live) break
      if (now() - start > 35_000) throw new Error(`pilot decision lock timed out: ${lock}`)
      pause()
    }
    return update()
  } finally {
    fs.closeSync(fd)
    releaseOwnedLock(lock, token, fs)
    if (owned(staleName)) fs.rmSync(staleName)
  }
}

const withLock = withPilotDecisionLock

export function initializePilotDecisionStore(runId, options = {}) {
  const file = pilotDecisionStateFile(runId, options)
  withLock(file, () => atomicJson(file, { version: 1, runId, requests: {}, decisions: {}, bindings: {} }), options.lockOptions)
  return file
}

export function registerPilotDecisionRequest(file, { requestId, criteria, deadline }) {
  withLock(file, () => {
    const state = readState(file)
    for (const criterion of criteria) state.requests[String(criterion)] = { requestId, deadline }
    atomicJson(file, state)
  })
}

export function unregisterPilotDecisionRequest(file, { requestId, criteria }) {
  withLock(file, () => {
    const state = readState(file)
    for (const criterion of criteria) if (state.requests[String(criterion)]?.requestId === requestId) delete state.requests[String(criterion)]
    atomicJson(file, state)
  })
}

export function bindPilotDecision(file, { requestId, criterion, source, at, resolution }) {
  return withLock(file, () => {
    const state = readState(file)
    const key = String(criterion)
    if (state.bindings?.[key]) {
      const binding = state.bindings[key]
      return binding.source === 'parent'
        ? { source: 'parent', reading: state.decisions[key].reading, requestId: binding.requestId, at: binding.boundAt }
        : binding.resolution
    }
    if (state.requests[key]?.requestId !== requestId) throw new Error(`no open decision request for DoD ${criterion}`)
    state.bindings ??= {}
    const bound = resolution ?? { source, at: new Date(at).toISOString() }
    state.bindings[key] = { requestId, source, boundAt: new Date(at).toISOString(), resolution: bound }
    atomicJson(file, state)
    return bound
  })
}

// The lifecycle reads parent answers here; bindings are recorded separately under the same lock.
export function readPilotDecisions(file) {
  const state = readState(file)
  return Object.values(state.decisions).map((decision) => ({ ...decision }))
}

export function decidePilotRun({ runId, criterion, reading, now = Date.now, decidedAt: injectedAt, ...options }) {
  if (!Number.isSafeInteger(criterion) || criterion < 1) throw new Error('--dod must be a positive integer')
  if (typeof reading !== 'string' || !reading.trim()) throw new Error('--reading must be non-empty')
  const file = pilotDecisionStateFile(runId, options)
  return withLock(file, () => {
    const decidedAt = injectedAt === undefined ? now() : injectedAt
    const state = readState(file)
    const key = String(criterion)
    const request = state.requests[key]
    if (!request) throw new Error(`run ${runId} has no open decision request for DoD ${criterion}`)
    if (state.bindings?.[key]) throw new Error(`already bound (${state.bindings[key].source}) at ${state.bindings[key].boundAt}`)
    if (state.decisions[key]) throw new Error(`already bound (parent) at ${state.decisions[key].decidedAt}`)
    if (decidedAt > request.deadline) throw new Error(`late: deadline ${new Date(request.deadline).toISOString()}`)
    const decision = { requestId: request.requestId, criterion, reading: reading.trim(), decidedAt: new Date(decidedAt).toISOString(), boundAt: new Date(decidedAt).toISOString() }
    state.decisions[key] = decision
    state.bindings ??= {}
    state.bindings[key] = { requestId: request.requestId, source: 'parent', boundAt: decision.boundAt }
    atomicJson(file, state)
    return { file, decision }
  })
}
