import { homedir } from 'node:os'
import { dirname, join, resolve, posix, win32 } from 'node:path'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

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

export function pilotDecisionCommand(cli, runId, execPath = process.execPath, root = null, platform = process.platform) {
  const posix = (value) => `'${String(value).replaceAll("'", "'\\''")}'`
  const powershell = (value) => `'${String(value).replaceAll("'", "''")}'`
  const command = (quote) => {
    const stateRoot = root ? ' --state-root ' + quote(root) : ''
    return `${quote(execPath)} ${quote(cli)} decide --run ${quote(runId)}${stateRoot}`
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

function releaseOwnedLock(lock, token) {
  try { if (readFileSync(lock, 'utf8') === token) rmSync(lock) } catch (error) { if (error.code !== 'ENOENT') throw error }
}

function withLock(file, update) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const lock = `${file}.lock`
  const start = Date.now()
  let fd
  const token = randomUUID()
  for (;;) {
    try { fd = openSync(lock, 'wx', 0o600); writeFileSync(fd, token); break } catch (error) {
      if (fd !== undefined) { closeSync(fd); throw error }
      if (error.code !== 'EEXIST') throw error
      try {
        const observed = statSync(lock)
        if (Date.now() - observed.mtimeMs > 30_000) {
          const stale = `${lock}.${token}.stale`
          renameSync(lock, stale)
          let reclaimed = true
          try {
            const moved = statSync(stale)
            if (moved.ino !== observed.ino || moved.dev !== observed.dev) {
              // Another contender replaced the observed lock. Do not reclaim its work.
              reclaimed = false
              if (!existsSync(lock)) renameSync(stale, lock)
            }
          } finally { if (reclaimed) rmSync(stale, { force: true }) }
        }
      } catch (statError) { if (statError.code !== 'ENOENT') throw statError }
      if (Date.now() - start > 35_000) throw new Error(`pilot decision lock timed out: ${lock}`, { cause: error })
      // The CLI's synchronous public API cannot yield an async retry without changing its callers.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  try { return update() } finally {
    closeSync(fd)
    releaseOwnedLock(lock, token)
  }
}

export function initializePilotDecisionStore(runId, options = {}) {
  const file = pilotDecisionStateFile(runId, options)
  withLock(file, () => atomicJson(file, { version: 1, runId, requests: {}, decisions: {}, bindings: {} }))
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
