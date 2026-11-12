import { pidAlive } from '../artifact-server.mjs'
import { currentPidNamespace, pidNamespaceHasProcesses, processStartTime } from './pid-namespace.mjs'
import { insideChildUserNamespace } from './lane-sandbox.mjs'

function localNamespace(namespace, holderNamespace, iAmSandboxed) {
  const foreign = namespace !== null && holderNamespace !== null && holderNamespace !== namespace
  return !foreign && !(iAmSandboxed && holderNamespace === null)
}

// A foreign PID is namespace-local. A sandbox cannot disprove a host holder's
// liveness; the host can reclaim only when the recorded namespace is empty.
export function foreignNamespaceStale(lock, options) {
  const namespace = options.pidNamespace ?? currentPidNamespace()
  const holderNamespace = lock.holder.pidNamespace ?? null
  const iAmSandboxed = options.insideSandbox ?? insideChildUserNamespace()
  if (localNamespace(namespace, holderNamespace, iAmSandboxed)) return null
  if (iAmSandboxed) {
    return false
  }
  return (options.namespaceHasProcesses ?? pidNamespaceHasProcesses)(holderNamespace) === false
}

export const platformOf = (options) => options.platform ?? process.platform

export function pidProvesGone(holder, options) {
  if (!pidAlive(holder.pid)) return true
  if (platformOf(options) === 'win32' || !Number.isFinite(holder.startTime)) return false
  const start = (options.processStartTime ?? processStartTime)(holder.pid)
  return start !== null && start !== holder.startTime
}

const UNREADABLE_TICKET_GRACE_MS = 10_000
export const TICKET_SILENCE_MS = 120_000

/** Acquisition, park-yield and journal snapshots share exactly one liveness rule. */
export function ticketIsStale(ticket, options = {}) {
  if (!Number.isSafeInteger(ticket.holder?.pid) || ticket.holder.pid <= 0) return ticket.ageMs >= UNREADABLE_TICKET_GRACE_MS
  if (ticket.ageMs >= TICKET_SILENCE_MS) return true
  const foreign = foreignNamespaceStale(ticket, options)
  return foreign ?? pidProvesGone(ticket.holder, options)
}
