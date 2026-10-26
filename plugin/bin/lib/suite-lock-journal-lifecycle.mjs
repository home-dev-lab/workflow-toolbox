import path from 'node:path'
import { takeTicket as takeHostTicket } from './host/suite-lock-queue.mjs'
import { createSuiteLockLeaseId } from './host/suite-lock-host.mjs'
import { suiteJournalEvent, suiteJournalRequest } from './suite-lock-journal.mjs'
import { staticLaneEnabled, staticLockOptions } from './suite-lock-static.mjs'
import { staticWaitDeadline } from './suite-lock-static-deadline.mjs'

const CONTEXT = Symbol('suite journal context')
const records = new WeakMap()

export function journalWaiterRecord(record, options, priority) {
  record.leaseId = createSuiteLockLeaseId()
  records.set(record, { options, priority })
  return record
}

export function takeJournalTicket(queueDir, record) {
  const ticket = takeHostTicket(queueDir, record)
  const metadata = records.get(record)
  if (metadata) {
    const journal = suiteJournalRequest(path.dirname(queueDir), ticket, record, metadata.priority, metadata.options)
    if (metadata.options[CONTEXT]) metadata.options[CONTEXT].journal = journal
  }
  return ticket
}

function journalAcquisition(options, domain, covered, inherit) {
  const env = options.env ?? process.env
  const staticOptions = staticLockOptions(domain, options)
  const staticRequest = options.static === true && options.priority !== 'release' && staticLaneEnabled(env)
  const id = options.static ? covered(env, domain, staticRequest) : null
  if (id) return { lease: inherit(options, domain, id) }
  if (staticOptions) options = staticOptions
  else if (options.static) options = { ...options, light: options.priority !== 'release' }
  return { options }
}

function journalWaitFailure(context, failure) {
  if (failure?.code === 'WT_SUITE_LOCK_TIMEOUT') suiteJournalEvent(context.journal, 'timeout', { waitedS: (performance.now() - context.started) / 1000 })
  if (failure?.code === 'ABORT_ERR') suiteJournalEvent(context.journal, 'abort', { waitedS: (performance.now() - context.started) / 1000 })
}

export async function acquireJournalLease(acquire, options, domain, covered, inherit) {
  const prepared = journalAcquisition(options, domain, covered, inherit)
  if (prepared.lease) return prepared.lease
  options = prepared.options
  const context = { started: performance.now() }
  const deadline = staticWaitDeadline(options)
  try {
    const lease = await acquire({ ...deadline.options, [CONTEXT]: context })
    if (lease.inherited || lease.broker) return lease
    suiteJournalEvent(context.journal, 'grant')
    return { ...lease, journal: context.journal, staticDomain: options.staticDomain }
  } catch (error) {
    const failure = deadline.failure(error)
    journalWaitFailure(context, failure)
    throw failure
  } finally { deadline.close() }
}

export const journalHolder = (record, options, now) => ({ ...record, startedAt: options.startedAt ?? new Date(now).toISOString() })

export function finishBrokerLease(lease, outcome) {
  lease.markReleased?.()
  if (!lease.socket.destroyed) lease.socket.end(`${JSON.stringify({ exit: outcome.exit ?? 0 })}\n`)
  return true
}
