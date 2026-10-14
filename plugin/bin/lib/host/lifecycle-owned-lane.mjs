// Continues the lifecycle's one wait/publication path across owner decisions.
import fs from 'node:fs'
import { supervisionPaths, shellQuote } from '../lane-supervisor-core.mjs'

const PREFLIGHT_MS = 100_000
const SETTLE_MS = 5_000
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const terminal = (verdict) => ['terminal', 'gone'].includes(verdict.status)
const errorText = (error) => error instanceof Error ? error.message : String(error)

export function aggregateSelectedCritic(args, result, aggregate) {
  return args?.kind === 'lane' && args.phase === 'critic' && args.criticLane ? aggregate([result]) : result
}

function owns(context, identity, phase) {
  return context.state.ownedLanes.has(identity.slot ?? phase)
}

function register(context, record) {
  context.state.ownedLanes.set(record.key, record)
  return record
}

function finishLaunch(context, record) {
  if (!record.workerPid || !context.state.ownedLanes.has(record.key)) context.finalize(record)
}

function supervision(root, record, readRegularFile, classify) {
  let saved = null
  try { saved = JSON.parse(readRegularFile(supervisionPaths(root, record.runId, record.slot).record)) } catch {}
  return { saved, verdict: classify(saved) }
}

function decisionDetail(saved) {
  return `owner=${saved.owner} decision required; lane remains live; last write ${saved.evidence?.lastWriteAt ?? 'unknown'}; process ${saved.evidence?.process ?? 'unknown'}; log tail ${JSON.stringify(saved.evidence?.logTail ?? '')}; default=${saved.defaultDecision} at ${saved.decisionDueAt}`
}

function timeoutDetail(saved, verdict) {
  if (verdict.status === 'decision-needed') return decisionDetail(saved)
  if (verdict.status === 'running') return `liveness=running; owner=${saved.owner}; live worker is still completing its bounded timeout transition; wait for the decision point before choosing; no process was killed`
  if (verdict.status === 'worker-gone-child-alive') return `worker-gone-child-alive; surviving child pid=${saved.childPid}; no process was killed`
  if (verdict.status === 'unknown') return saved === null
    ? 'unknown liveness; no process was killed'
    : `unknown liveness (${verdict.reason}); no process was killed`
  return `${verdict.status}; no process was killed`
}

function settling(saved, verdict) {
  const childExiting = verdict.child === 'gone' ? verdict.reason === 'inconsistent-record'
    : verdict.child === 'unknown' && /^identity-unreadable/.test(verdict.reason)
  return (verdict.status === 'unknown' && childExiting && verdict.worker === 'running'
    && ['running', 'decision-needed'].includes(saved.state))
    || (verdict.status === 'terminal' && ['exited', 'abandoned'].includes(verdict.reason) && verdict.worker === 'running')
}

function answeredDeadline(record, observation, bounds) {
  if (record.answeredAt === undefined) return null
  const { saved, verdict } = observation
  if (saved.state === 'terminating') return bounds.answer
  return verdict.status === 'decision-needed' && (saved.timeoutAt ?? null) === record.answeredAt ? bounds.answer : null
}

function pollDeadline(record, observation, bounds) {
  const { saved, verdict } = observation
  if (!saved || saved.workerPid !== record.workerPid || saved.owner !== 'pilot') return null
  const answered = answeredDeadline(record, observation, bounds)
  if (answered !== null) return answered
  if (verdict.status === 'running') return Date.parse(saved.decisionTransitionDueAt)
  if (!settling(saved, verdict)) return null
  bounds.settle ??= Date.now() + SETTLE_MS
  return Math.max(Date.parse(saved.decisionTransitionDueAt) || 0, bounds.settle)
}

export function createOwnedLaneWait(context) {
  const { root, state, readRegularFile, readAttestation, waitForLaneReceipt, classify, lanePollMs, refusal, controlPath } = context
  const observe = (record) => supervision(root, record, readRegularFile, classify)
  const receipt = (record, timeoutMs) => waitForLaneReceipt({ log: record.log, nonce: record.nonce, timeoutMs, pollMs: lanePollMs, readAttestation, readRegularFile })
  const bound = { ...context, root, state, refusal, controlPath, observe, receipt }
  for (const [name, operation] of Object.entries({ owns, register, finishLaunch, reconcile, timeout, finalize, preflight, poll, copyPair, publish, awaitOwnedLane })) {
    bound[name] = (...args) => operation(bound, ...args)
  }
  return bound
}

async function reconcile(context, record) {
  const logEntry = await context.receipt(record, 0)
  const observation = context.observe(record)
  return { ...observation, terminal: terminal(observation.verdict) || (!record.runId && Boolean(logEntry)) }
}

function timeout(context, record, detail) {
  const { state, root, controlPath } = context
  state.ownedLanes.set(record.key, record)
  const slot = record.slot ? ` --slot ${shellQuote(record.slot)}` : ''
  const selector = record.criticLane ? `, criticLane: '${record.criticLane}'` : ''
  const remedy = `pilot: run { kind: 'control', decision: 'abandon'${selector} } or run { kind: 'control', decision: 'extend'${selector} }; human: extend with node ${shellQuote(controlPath)} --dir ${shellQuote(root)} --decision extend --owner-token ${shellQuote(record.nonce)}${slot}, or abandon with node ${shellQuote(controlPath)} --dir ${shellQuote(root)} --decision abandon --owner-token ${shellQuote(record.nonce)}${slot}`
  return `lane ${record.phase} TIMEOUT: ${detail}; ${remedy}; after abandon completes, re-run this lifecycle lane phase to launch a fresh owner-bound lane and brief`
}

function finalize(context, record, exit = 'missing') {
  const { state, recordLaneEnd, now } = context
  if (record.finalized) return
  record.finalized = true
  state.ownedLanes.delete(record.key)
  try { if (record.laneRecord) recordLaneEnd(record.laneRecord, now(), exit) }
  finally { if (record.snapshot) fs.rmSync(record.snapshot, { recursive: true, force: true }) }
}

function pointerRun(readRegularFile, file, previous) {
  try { return JSON.parse(readRegularFile(file)).runId } catch { return previous }
}

function launching(raw) {
  try { return JSON.parse(raw).state === 'launching' } catch { return false }
}

async function preflight(context, record) {
  const { root, readRegularFile } = context
  if (!record.runId) return
  const file = supervisionPaths(root, record.runId, record.slot).record
  const pointerFile = supervisionPaths(root, null, record.slot).pointer
  let raw = readRegularFile(file)
  let pointer = pointerRun(readRegularFile, pointerFile, null)
  const deadline = Date.now() + PREFLIGHT_MS
  while ((!raw || pointer !== record.runId || launching(raw)) && Date.now() < deadline) {
    await pause(25)
    pointer = pointerRun(readRegularFile, pointerFile, pointer)
    raw = readRegularFile(file)
  }
}

async function poll(context, record, logEntry) {
  const { observe, receipt, lanePollMs } = context
  let observation = observe(record)
  const bounds = { answer: Date.now() + SETTLE_MS, settle: null }
  let deadline = pollDeadline(record, observation, bounds)
  while (!logEntry && deadline !== null && Date.now() <= deadline) {
    logEntry = await receipt(record, Math.min(25, Math.max(0, deadline - Date.now())))
    observation = observe(record)
    deadline = pollDeadline(record, observation, bounds)
  }
  logEntry ??= await receipt(record, 0)
  if (logEntry) {
    const settleDeadline = Date.now() + 1_000
    while (!terminal(observation.verdict) && Date.now() < settleDeadline) {
      await pause(lanePollMs)
      observation = observe(record)
    }
  }
  return { logEntry, ...observation }
}

function copyPair(context, record) {
  const { refusal, regularFile } = context
  const { canonicalLog, canonicalReport, log, report, phase } = record
  if (fs.existsSync(canonicalLog) && !regularFile(canonicalLog)) return refusal(`${phase}->next`, 'regular lane receipt', canonicalLog, 'receipt')
  fs.rmSync(canonicalLog, { force: true }); fs.rmSync(canonicalReport, { force: true })
  try {
    fs.copyFileSync(log, canonicalLog, fs.constants.COPYFILE_EXCL)
    fs.copyFileSync(report, canonicalReport, fs.constants.COPYFILE_EXCL)
  } catch (error) {
    fs.rmSync(canonicalLog, { force: true }); fs.rmSync(canonicalReport, { force: true })
    return refusal(`${phase}->next`, `publish lane pair (${errorText(error)})`, canonicalLog, 'receipt')
  }
  return null
}

function publish(context, record, logEntry) {
  const { refusal, copyPair, state, regularFile, maxReportBytes, assertLaneDir, attest, progress } = context
  const { phase, log, report, canonicalLog, canonicalReport } = record
  const reportStat = regularFile(report)
  if (!logEntry || !regularFile(log) || !reportStat) return `lane ${phase} EXIT=missing`
  if (reportStat.size > maxReportBytes) return refusal(`${phase}->next`, `lane report exceeds ${maxReportBytes}-byte limit`, report)
  assertLaneDir()
  const problem = copyPair(record)
  if (problem) return problem
  try {
    attest(canonicalReport)
    attest(canonicalLog, { group: record.group })
  } catch (error) {
    return refusal(`${phase}->next`, `publish lane pair (${errorText(error)})`, canonicalLog, 'receipt')
  }
  if (!record.criticLane) state.laneReceiptSeq += 1
  progress()
  return `lane ${phase} EXIT=${logEntry.exit}`
}

async function awaitOwnedLane(context, record) {
  const { receipt, preflight, poll, timeout, publish, finalize } = context
  const initialWait = record.initialWait
  record.initialWait = false
  let logEntry = await receipt(record, record.waitMs)
  if (record.runId) {
    if (!logEntry && initialWait) await preflight(record)
    const observed = await poll(record, logEntry)
    logEntry = observed.logEntry
    if (!terminal(observed.verdict)) return timeout(record, logEntry
      ? `receipt arrived while liveness is ${observed.verdict.status}; no process was killed`
      : timeoutDetail(observed.saved, observed.verdict))
    try {
      if (!logEntry) return `lane ${record.phase} ${observed.verdict.status === 'gone' ? 'EXIT=missing' : 'TERMINAL receipt=missing'}`
      return publish(record, logEntry)
    } finally { finalize(record, logEntry?.exit) }
  }
  if (!logEntry) return timeout(record, 'unknown liveness; no process was killed')
  try { return publish(record, logEntry) } finally { finalize(record, logEntry.exit) }
}
