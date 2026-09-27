import { homedir } from 'node:os'
import { dirname, join, resolve, posix, win32 } from 'node:path'
import * as hostFs from 'node:fs'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const RUN_ID = /^[A-Za-z0-9._-]+$/
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/
function assertRequestId(requestId) {
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new Error(`invalid pilot request id: ${String(requestId)}`)
}
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

function storeDir(file, kind) { return join(dirname(file), kind) }
function validCriterion(criterion) { return Number.isSafeInteger(criterion) && criterion > 0 }
// Hex retains stable filenames for existing ASCII ids; the validated alphabet makes UTF-8 encoding injective.
function requestFile(file, requestId) { return join(storeDir(file, 'requests'), `${Buffer.from(String(requestId)).toString('hex')}.json`) }
function bindingFile(file, requestId, criterion) { return join(storeDir(file, 'bindings'), `${Buffer.from(String(requestId)).toString('hex')}-${criterion}.json`) }
function requests(file) {
  return readdirSync(storeDir(file, 'requests')).filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(storeDir(file, 'requests'), name), 'utf8')))
}
function activeRequest(file, criterion) {
  return requests(file).find((request) => request.active && request.criteria.includes(criterion))
}
function bindings(file) {
  return readdirSync(storeDir(file, 'bindings')).filter((name) => name.endsWith('.json'))
    .map((name) => {
      const path = join(storeDir(file, 'bindings'), name)
      try { return readBinding(path) } catch (error) {
        return { error: { path, code: error.code ?? 'CORRUPT', message: error.message } }
      }
    })
}
function readBinding(path, fs = hostFs) {
  let record
  try { record = JSON.parse(fs.readFileSync(path, 'utf8')) } catch (error) {
    if (error instanceof SyntaxError) throw Object.assign(new Error(`corrupt pilot decision binding: ${path}`), { code: 'CORRUPT', cause: error })
    throw error
  }
  if (typeof record?.requestId !== 'string' || !REQUEST_ID.test(record.requestId) || !['parent', 'fallback', 'stopped'].includes(record?.source) || !record?.boundAt || !validCriterion(record.criterion) ||
    (record.source === 'parent' && (record.decision?.requestId !== record.requestId || record.decision?.criterion !== record.criterion || typeof record.decision?.reading !== 'string' || !record.decision.reading.trim() || !record.decision?.decidedAt)) ||
    (record.source !== 'parent' && !record.resolution)) throw Object.assign(new Error(`corrupt pilot decision binding: ${path}`), { code: 'CORRUPT' })
  return record
}

function claimBinding(file, record, { fs = hostFs, afterTempWrite = () => {} } = {}) {
  const final = bindingFile(file, record.requestId, record.criterion)
  const temporary = `${final}.${randomUUID()}.tmp`
  const text = `${JSON.stringify(record)}\n`
  fs.mkdirSync(dirname(final), { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
    afterTempWrite(temporary)
    try { fs.linkSync(temporary, final) } catch (error) {
      if (error.code === 'EEXIST') return readBinding(final, fs)
      throw new Error(`pilot decisions need hard links on the state filesystem: ${error.code ?? 'UNKNOWN'} at ${final}`, { cause: error })
    }
    return record
  } finally { fs.rmSync(temporary, { force: true }) }
}

function resolutionOf(record) {
  return record.source === 'parent'
    ? { source: 'parent', reading: record.decision.reading, requestId: record.requestId, at: record.boundAt }
    : record.resolution
}

export function readPilotBinding(file, requestId, criterion) {
  assertRequestId(requestId)
  if (!validCriterion(criterion)) throw new Error('invalid pilot decision criterion')
  try {
    const record = readBinding(bindingFile(file, requestId, criterion))
    if (record.requestId !== requestId || record.criterion !== criterion) throw new Error('binding identity mismatch')
    return resolutionOf(record)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export function initializePilotDecisionStore(runId, options = {}) {
  const file = pilotDecisionStateFile(runId, options)
  mkdirSync(dirname(dirname(file)), { recursive: true, mode: 0o700 })
  try { mkdirSync(dirname(file), { mode: 0o700 }) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`pilot decision run directory already exists: ${dirname(file)}`, { cause: error })
    throw error
  }
  atomicJson(file, { version: 1, runId, requests: {}, decisions: {}, bindings: {} })
  mkdirSync(storeDir(file, 'requests'), { recursive: true, mode: 0o700 })
  mkdirSync(storeDir(file, 'bindings'), { recursive: true, mode: 0o700 })
  return file
}

export function registerPilotDecisionRequest(file, { requestId, criteria, deadline }) {
  assertRequestId(requestId)
  if (!criteria.every(validCriterion)) throw new Error('invalid pilot decision criterion')
  for (const request of requests(file)) {
    if (request.active && request.criteria.some((criterion) => criteria.includes(criterion))) atomicJson(requestFile(file, request.requestId), { ...request, active: false })
  }
  atomicJson(requestFile(file, requestId), { requestId, criteria, deadline, active: true })
}

export function unregisterPilotDecisionRequest(file, { requestId, criteria }) {
  const path = requestFile(file, requestId)
  const request = JSON.parse(readFileSync(path, 'utf8'))
  if (request.requestId === requestId) atomicJson(path, { ...request, criteria: request.criteria.filter((criterion) => !criteria.includes(criterion)), active: request.active })
}

export function bindPilotDecision(file, { requestId, criterion, source, at, resolution }, options = {}) {
  assertRequestId(requestId)
  if (!validCriterion(criterion)) throw new Error('invalid pilot decision criterion')
  if (activeRequest(file, criterion)?.requestId !== requestId) throw new Error(`no open decision request for DoD ${criterion}`)
  const boundAt = new Date(at).toISOString()
  return resolutionOf(claimBinding(file, { requestId, criterion, source, boundAt, resolution: resolution ?? { source, at: boundAt } }, options))
}

export function readPilotDecisions(file) {
  return bindings(file).map((record) => {
    if (record.error) return record
    if (record.source === 'parent') return { ...record.decision }
    return null
  }).filter(Boolean)
}

export function decidePilotRun({ runId, requestId, criterion, reading, now = Date.now, decidedAt: injectedAt, bindingOptions, ...options }) {
  assertRequestId(requestId)
  if (!validCriterion(criterion)) throw new Error('--dod must be a positive integer')
  if (typeof reading !== 'string' || !reading.trim()) throw new Error('--reading must be non-empty')
  const file = pilotDecisionStateFile(runId, options)
  const decidedAt = injectedAt === undefined ? now() : injectedAt
  const request = activeRequest(file, criterion)
  if (!request || request.requestId !== requestId) throw new Error(`run ${runId} has no open decision request for DoD ${criterion} and request ${requestId}`)
  if (decidedAt > request.deadline) throw new Error(`late: deadline ${new Date(request.deadline).toISOString()}`)
  const decision = { requestId: request.requestId, criterion, reading: reading.trim(), decidedAt: new Date(decidedAt).toISOString(), boundAt: new Date(decidedAt).toISOString() }
  const winner = claimBinding(file, { requestId: request.requestId, criterion, source: 'parent', boundAt: decision.boundAt, decision }, bindingOptions)
  if (activeRequest(file, criterion)?.requestId !== requestId) throw new Error('request withdrawn after your decision was recorded')
  // Only the successful publisher receives its original object back.
  if (winner.decision === decision) return { file, decision }
  throw new Error(`already bound (${winner.source}) at ${winner.boundAt}`)
}
