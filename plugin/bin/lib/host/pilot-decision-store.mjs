import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const RUN_ID = /^[A-Za-z0-9._-]+$/
let serial = 0

export function pilotDecisionStateRoot({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'workflow-toolbox', 'pilot-runs')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'workflow-toolbox', 'pilot-runs')
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'workflow-toolbox', 'pilot-runs')
}

export function pilotDecisionStateFile(runId, options = {}) {
  if (!RUN_ID.test(String(runId ?? ''))) throw new Error(`invalid pilot run id: ${String(runId)}`)
  return join(resolve(options.root ?? pilotDecisionStateRoot(options)), runId, 'dod-decisions.json')
}

export function pilotDecisionCommand(cli, runId, execPath = process.execPath) {
  return `${execPath} ${cli} decide --run ${runId}`
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

export function initializePilotDecisionStore(runId, options = {}) {
  const file = pilotDecisionStateFile(runId, options)
  atomicJson(file, { version: 1, runId, requests: {}, decisions: {} })
  return file
}

export function registerPilotDecisionRequest(file, { requestId, criteria }) {
  const state = readState(file)
  for (const criterion of criteria) state.requests[String(criterion)] = requestId
  atomicJson(file, state)
}

// This is the sole decision reader. Both the lifecycle and the pilot use it, so they cannot
// disagree about parsing, precedence, or provenance.
export function readPilotDecisions(file) {
  const state = readState(file)
  return Object.values(state.decisions).map((decision) => ({ ...decision }))
}

export function decidePilotRun({ runId, criterion, reading, decidedAt = Date.now(), ...options }) {
  if (!Number.isSafeInteger(criterion) || criterion < 1) throw new Error('--dod must be a positive integer')
  if (typeof reading !== 'string' || !reading.trim()) throw new Error('--reading must be non-empty')
  const file = pilotDecisionStateFile(runId, options)
  const state = readState(file)
  const requestId = state.requests[String(criterion)]
  if (!requestId) throw new Error(`run ${runId} has no open decision request for DoD ${criterion}`)
  state.decisions[String(criterion)] = { requestId, criterion, reading: reading.trim(), decidedAt: new Date(decidedAt).toISOString() }
  atomicJson(file, state)
  return { file, decision: state.decisions[String(criterion)] }
}
