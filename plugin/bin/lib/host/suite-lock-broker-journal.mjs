import { acquireSuiteLock, lightRunCommand, releaseSuiteLock } from '../suite-lock.mjs'
import { staticLaneEnabled, staticRunCommand } from '../suite-lock-static.mjs'

const callbacks = new WeakMap()
const leases = new WeakMap()

function observeHoldBound(socket, state) {
  const write = socket.write
  socket.write = function (chunk, ...args) {
    const text = String(chunk)
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
  socket.on('data', (chunk) => {
    if (state.text.length > 128) return
    state.text += String(chunk)
    if (!state.text.includes('\n')) return
    try {
      const message = JSON.parse(state.text.slice(0, state.text.indexOf('\n')))
      if (Number.isInteger(message.exit) && !state.expired) state.outcome = { exit: message.exit }
    } catch { /* An invalid terminal message remains a lost lease. */ }
  })
  callbacks.set(handlers.onWait, state)
  return handlers
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
  return releaseSuiteLock(lease, leases.get(lease)?.outcome ?? { lost: true, reason: 'broker shutdown' })
}
