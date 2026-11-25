import path from 'node:path'
import { heartbeatTicket, takeTicket as takeHostTicket } from './host/suite-lock-queue.mjs'
import { createSuiteLockLeaseId } from './host/suite-lock-host.mjs'
import { suiteJournalEvent, suiteJournalRequest } from './suite-lock-journal.mjs'
import { staticLaneEnabled, staticLockOptions } from './suite-lock-static.mjs'
import { staticWaitDeadline } from './suite-lock-static-deadline.mjs'
import { suiteLockRankOptions } from './suite-lock-priority.mjs'
import { suiteLockBootClock } from './host/platform.mjs'
import { suiteSignalExit } from './host/suite-lock-signals.mjs'
import { startSuiteResourceSampler } from './host/suite-lock-resources.mjs'
import { normalizeSuiteResources, unknownSuiteResources } from './suite-lock-resources.mjs'

const CONTEXT = Symbol('suite journal context')
const records = new WeakMap()

export function journalWaiterRecord(record, options, priority) {
  record.leaseId = createSuiteLockLeaseId()
  records.set(record, { options, priority })
  return record
}

function ticketJournalPriority(record, priority, resumedNumber) {
  if (resumedNumber === undefined) return priority
  return record.priority === 'release' ? 'release' : `P${record.level}`
}

const ticketJournalLight = (record, resumedNumber) => resumedNumber === undefined ? undefined : record.light === true

export function takeJournalTicket(queueDir, record, resumedNumber) {
  const ticket = resumedNumber ?? takeHostTicket(queueDir, record, { prepare: (number) => prepareJournalTicket(queueDir, record, number) })
  const metadata = records.get(record)
  if (metadata) {
    const journal = { base: record.journal, now: metadata.options.now?.bind(metadata.options) }
    suiteJournalEvent(journal, 'request')
    if (metadata.options[CONTEXT]) metadata.options[CONTEXT].journal = journal
  }
  return ticket
}

export function prepareJournalTicket(queueDir, source, ticket, resumedNumber, record = source) {
  const metadata = records.get(source)
  if (metadata) {
    const priority = ticketJournalPriority(record, metadata.priority, resumedNumber)
    const light = ticketJournalLight(record, resumedNumber)
    const journal = suiteJournalRequest(path.dirname(queueDir), ticket, record, priority, metadata.options, light, false)
    record.journal = journal?.base
  }
}

function journalAcquisition(options, domain, covered, inherit) {
  const env = options.env ?? process.env
  const staticRequest = options.static === true && options.priority !== 'release' && staticLaneEnabled(env)
  const id = covered(env, domain, options.static ? staticRequest : undefined)
  if (id) return { lease: inherit(options, domain, id) }
  const staticOptions = staticLockOptions(domain, options)
  if (staticOptions) options = staticOptions
  else if (options.static) options = { ...options, light: options.priority !== 'release' }
  return { options }
}

function journalWaitFailure(context, failure, signal) {
  const fields = { waitedS: (performance.now() - context.started) / 1000 }
  if (failure?.code === 'WT_SUITE_LOCK_TIMEOUT') return suiteJournalEvent(context.journal, 'timeout', fields)
  if (suiteSignalExit(signal?.reason)) Object.assign(fields, { cause: 'signal', signal: signal.reason.signal })
  else if (failure?.code !== 'ABORT_ERR') Object.assign(fields, { cause: 'error', code: failure?.code ?? 'unknown' })
  suiteJournalEvent(context.journal, 'abort', fields)
}

// Publication changes the terminal writer: even a later acquisition failure
// must claim and release the holder rather than report a waiting-ticket abort.
export function notePublishedLease(lease, options, release) {
  const context = options[CONTEXT]
  if (context) context.releasePublished = (outcome) => release({ ...lease, journal: context.journal, staticDomain: options.staticDomain }, outcome)
}

// A provisional hand-back really ends that publication. A continued queue
// attempt keeps its position but gets a fresh identity and request, never a
// second terminal under the ended lease's ID.
export function handBackJournalLease(lease, state, options, release) {
  const context = options[CONTEXT]
  const released = release({ ...lease, journal: context?.journal }, { served: false })
  if (!released) throw Object.assign(new Error('could not hand back the published suite lease'), { code: 'WT_SUITE_LOCK_UNAVAILABLE' })
  if (context) context.terminal = true
  options.afterHandBack?.()
  if (context) renewJournalWaiter(state, context)
}

function renewJournalWaiter(state, context) {
  const { queueDir, ticket, record } = state
  record.leaseId = createSuiteLockLeaseId()
  prepareJournalTicket(queueDir, record, ticket, state.resumed ? ticket : undefined)
  context.journal = { ...context.journal, base: record.journal }
  context.started = performance.now()
  context.terminal = false
  context.releasePublished = undefined
  heartbeatTicket(queueDir, ticket, record, true)
  suiteJournalEvent(context.journal, 'request')
}

function journalAcquisitionFailure(context, failure, signal) {
  if (context.terminal) return
  if (context.releasePublished) context.releasePublished({ cause: 'error', code: failure?.code ?? 'unknown', served: false })
  else journalWaitFailure(context, failure, signal)
}

export async function acquireJournalLease(acquire, options, domain, covered, inherit) {
  const prepared = journalAcquisition(options, domain, covered, inherit)
  if (prepared.lease) return prepared.lease
  options = prepared.options
  const metadata = suiteLockRankOptions(options, options.env ?? process.env)
  options = { ...options, project: metadata.project, size: metadata.size }
  const context = { started: performance.now() }
  const deadline = staticWaitDeadline(options)
  try {
    const lease = await acquire({ ...deadline.options, [CONTEXT]: context })
    if (lease.inherited || lease.offloaded) return lease
    const resourceStarted = performance.now()
    const resourceSampler = startSuiteResourceSampler(options)
    if (lease.broker) return { ...lease, resourceSampler, resourceStarted }
    suiteJournalEvent(context.journal, 'grant', { project: lease.holder.project, rankLevel: lease.rankLevel,
      ...(lease.holder.reservation ? { reservation: lease.holder.reservation } : {}) })
    return { ...lease, resourceSampler, resourceStarted, journal: context.journal, staticDomain: options.staticDomain }
  } catch (error) {
    const failure = deadline.failure(error)
    journalAcquisitionFailure(context, failure, deadline.options.signal)
    throw failure
  } finally { deadline.close() }
}

function holderBootStart() {
  const { uptimeMs, bootId } = suiteLockBootClock()
  return { startedUptimeMs: uptimeMs, bootId }
}

export const journalHolder = (record, options, now) => ({ ...record, startedAt: options.startedAt ?? new Date(now).toISOString(), ...holderBootStart() })

export function finishSuiteResourceSample(lease, outcome) {
  let resources
  try {
    resources = lease?.resourceSampler?.stop()
  } catch {
    return resourceSampleFailure(lease, outcome, 'sampler-stop-failed')
  }
  if (resources === undefined) return outcome
  try { return { ...outcome, resources: normalizeSuiteResources(resources) } }
  catch { return resourceSampleFailure(lease, outcome, 'resources-unserializable') }
}

function resourceSampleFailure(lease, outcome, reason) {
  const elapsed = performance.now() - lease?.resourceStarted
  const wallMs = Number.isFinite(elapsed) ? Math.max(0, elapsed) : null
  return { ...outcome, resources: normalizeSuiteResources(unknownSuiteResources(wallMs, reason)) }
}

function brokerResourceFrame(outcome) {
  try { return outcome.resources ? `${JSON.stringify({ resources: outcome.resources })}\n` : '' }
  catch { return `${JSON.stringify({ resourcesError: 'resources-unserializable' })}\n` }
}

export function finishBrokerLease(lease, outcome) {
  lease.markReleased?.()
  if (!lease.socket.destroyed) {
    // Keep the first frame small: older hosts stop buffering after 128 characters.
    const terminal = `${JSON.stringify({ exit: outcome.exit ?? 0, served: outcome.served === true })}\n`
    const telemetry = brokerResourceFrame(outcome)
    lease.socket.end(terminal + telemetry)
  }
  return true
}
