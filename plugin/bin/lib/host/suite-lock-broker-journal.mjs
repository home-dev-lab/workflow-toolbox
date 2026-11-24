import { acquireSuiteLock, lightRunCommand, releaseSuiteLock } from '../suite-lock.mjs'
import { staticLaneEnabled, staticRunCommand } from '../suite-lock-static.mjs'
import { validSuiteResources } from '../suite-lock-resources.mjs'

const callbacks = new WeakMap()
const leases = new WeakMap()
const BROKER_JOURNAL_FRAME_LIMIT = 2048

function observeHoldBound(socket, state) {
  const write = socket.write
  socket.write = function (chunk, ...args) {
    const text = String(chunk)
    if (text.startsWith('granted ')) state.startedMonotonic = performance.now()
    if (text.startsWith('granted ') && state.staticDomain) chunk = text.replace('granted ', 'granted static:')
    if (text.startsWith('error hold bound:')) {
      state.expired = true
      state.outcome = { lost: true, reason: text.slice(6).split(';')[0].trim() }
    }
    return write.call(this, chunk, ...args)
  }
}

/** Observe command exits without widening the broker request's admission-key whitelist. */
export function observeBrokerJournalSocket(socket, handlers) {
  const state = { text: '', outcome: { lost: true, reason: 'broker connection closed without command exit' } }
  observeHoldBound(socket, state)
  socket.on('data', (chunk) => readBrokerJournalChunk(state, chunk))
  callbacks.set(handlers.onWait, state)
  return handlers
}

function readBrokerJournalChunk(state, chunk) {
  const lines = (state.text + String(chunk)).split('\n')
  state.text = lines.pop()
  for (const line of lines) {
    if (state.overflow) { state.overflow = false; continue }
    if (line.length > BROKER_JOURNAL_FRAME_LIMIT) continue
    try { recordBrokerJournalMessage(state, JSON.parse(line)) }
    catch { /* An invalid frame supplies no exit or resource evidence. */ }
  }
  if (state.text.length > BROKER_JOURNAL_FRAME_LIMIT) { state.text = ''; state.overflow = true }
}

function recordBrokerJournalMessage(state, message) {
  if (state.expired) return
  // Duration stays host-measured: client timings are not trusted for S history.
  if (!Number.isInteger(state.outcome.exit) && Number.isInteger(message.exit)) state.outcome = { exit: message.exit, served: message.served !== false }
  if (Number.isInteger(state.outcome.exit) && validSuiteResources(message.resources)) state.outcome.resources = message.resources
}

export async function acquireBrokerJournalLease(options) {
  const argv = options.argv.slice(2) // Host-added sandbox label is display-only.
  // This is client-supplied argv, not authenticated execution. A non-cooperating
  // client can obtain a static grant for arbitrary work. Typed grants constrain
  // cooperative nesting only; refusing a static key is no trust boundary.
  const staticRun = staticLaneEnabled(options.env) && staticRunCommand(argv)
  const lease = await acquireSuiteLock({ ...options, static: staticRun, light: options.light || lightRunCommand(argv),
    commandArgv: argv, route: 'broker' })
  const state = callbacks.get(options.onWait)
  if (state) state.staticDomain = lease.staticDomain === true
  leases.set(lease, state)
  return lease
}

export function releaseBrokerJournalLease(lease) {
  const state = leases.get(lease)
  const outcome = state?.outcome ?? { lost: true, reason: 'broker shutdown' }
  const heldMs = Number.isFinite(state?.startedMonotonic) ? Math.max(0, performance.now() - state.startedMonotonic) : undefined
  return releaseSuiteLock(lease, { ...outcome, heldMs })
}
