import { connectSuiteLockBroker } from './host/suite-lock-host.mjs'
import { brokerProgressPlace, isBrokerQueueEvent } from './suite-lock-progress.mjs'
import { brokerCompatibilityRefusal, filterSuiteOffloadLine } from './suite-lock-offload-client.mjs'

export function requestBrokerLease(socketPath, options, helpers) {
  const waitS = helpers.positiveSeconds(options.waitS ?? helpers.suiteLockWaitSeconds(options.env), '--wait-s')
  helpers.throwIfAborted(options.signal)
  return new Promise((resolve, reject) => {
    const socket = connectSuiteLockBroker(socketPath)
    const state = { socketPath, options, helpers, socket, resolve, reject, waitS, buffer: '', settled: false,
      granted: false, released: false, bestAhead: Infinity, lastHolderId: null, notifyHandover: false }
    state.lost = new Promise((done) => { state.resolveLost = done })
    state.fail = (error) => failBrokerClient(state, error)
    restartBrokerTimer(state, waitS)
    state.abort = () => state.fail(helpers.abortError())
    options.signal?.addEventListener?.('abort', state.abort, { once: true })
    socket.once('connect', () => sendBrokerRequest(state))
    socket.on('data', (chunk) => receiveBrokerData(state, chunk))
    socket.once('error', (error) => state.fail(new Error(`suite lock broker ${socketPath}: ${error.message}`)))
    socket.once('close', () => brokerClientClosed(state))
    if (options.signal?.aborted) state.fail(helpers.abortError())
  })
}

function loseBrokerLease(state, reason) {
  if (!state.released) state.resolveLost(reason)
}

function failBrokerClient(state, error) {
  state.socket.destroy()
  if (state.settled) { loseBrokerLease(state, 'broker gone'); return }
  state.settled = true
  clearTimeout(state.timer)
  state.options.signal?.removeEventListener?.('abort', state.abort)
  state.reject(error)
}

function restartBrokerTimer(state, seconds) {
  clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    const timeout = new Error(`timed out waiting for suite lock broker ${state.socketPath}: holder unknown; inspect with wt-suite-lock status`)
    timeout.code = 'WT_SUITE_LOCK_TIMEOUT'
    state.fail(timeout)
  }, seconds * 1000 + 2000)
}

function sendBrokerRequest({ settled, socket, options, waitS }) {
  if (!settled) socket.write(`${JSON.stringify({ argv: options.argv ?? process.argv, waitS,
    ...(options.light === true ? { light: true } : {}), ...(options.offloadRequest ? { offload: options.offloadRequest } : {}) })}\n`)
}

function completeBrokerOffload(state, offloaded) {
  state.settled = true; clearTimeout(state.timer)
  state.options.signal?.removeEventListener?.('abort', state.abort)
  state.socket.destroy()
  state.resolve({ broker: state.socketPath, offloaded })
}

function receiveBrokerData(state, chunk) {
  state.buffer += String(chunk)
  while (state.buffer.includes('\n')) {
    const end = state.buffer.indexOf('\n')
    const line = filterSuiteOffloadLine(state.buffer.slice(0, end), state.options, (frame) => completeBrokerOffload(state, frame), state.fail)
    state.buffer = state.buffer.slice(end + 1)
    if (state.settled && !state.granted) { state.socket.destroy(); return }
    receiveBrokerLine(state, line)
  }
}

function receiveBrokerLine(state, line) {
  if (line.startsWith('wait ')) state.options.onWait?.(line.slice(5))
  else if (isBrokerQueueEvent(line)) receiveQueueProgress(state, line)
  else if (line.startsWith('handover ')) receiveBrokerHandover(state, line)
  else if (line.startsWith('error ') && state.granted) loseBrokerLease(state, line.slice(6))
  else if (line.startsWith('error ')) receiveBrokerError(state, line)
  else if (line.startsWith('granted ') && !state.settled) receiveBrokerGrant(state, line)
}

function acceptsQueueProgress(state, place, renewed) {
  return !state.settled && place && (place.aheadExcludingRelease < state.bestAhead || state.notifyHandover || renewed)
}

function receiveQueueProgress(state, line) {
  const renewed = line.startsWith('renew ')
  const place = brokerProgressPlace(line.slice(line.indexOf(' ') + 1))
  if (!acceptsQueueProgress(state, place, renewed)) return
  const improved = place.aheadExcludingRelease < state.bestAhead
  if (improved) state.bestAhead = place.aheadExcludingRelease
  if (improved || renewed) restartBrokerTimer(state, brokerWaitBudget(state))
  state.notifyHandover = false
  state.options.onProgress?.(place)
}

function brokerWaitBudget(state) {
  return state.helpers.waiterBudget(state.waitS, Math.max(state.waitS, state.helpers.staleS), state.bestAhead, state.holderPriority)
}

function receiveBrokerHandover(state, line) {
  const [holderId, priority] = line.slice(9).split(' ')
  if (!state.settled && /^[A-Za-z0-9-]{1,128}$/.test(holderId)) {
    state.holderPriority = priority
    if (holderId !== state.lastHolderId && (state.lastHolderId || priority === 'release')) {
      restartBrokerTimer(state, brokerWaitBudget(state))
      state.notifyHandover = Boolean(state.lastHolderId)
    }
    state.lastHolderId = holderId
  }
}

function receiveBrokerError(state, line) {
  const error = new Error(`suite lock broker ${state.socketPath}: ${line.slice(6)}; inspect with wt-suite-lock status`)
  if (line.includes('timed out waiting')) error.code = 'WT_SUITE_LOCK_TIMEOUT'
  else if (brokerCompatibilityRefusal(line, state.options, state.helpers.isOlderBrokerRefusal)) error.code = 'WT_SUITE_LOCK_BROKER_OLDER'
  else if (line.startsWith('error busy: ')) error.code = 'WT_SUITE_LOCK_UNAVAILABLE'
  state.fail(error)
}

function receiveBrokerGrant(state, line) {
  state.settled = true; state.granted = true; clearTimeout(state.timer)
  state.options.signal?.removeEventListener?.('abort', state.abort)
  state.resolve({ broker: state.socketPath, socket: state.socket, holder: { leaseId: line.slice(8) }, lost: state.lost,
    markReleased: () => { state.released = true } })
}

function brokerClientClosed(state) {
  if (!state.settled) state.fail(new Error(`suite lock broker ${state.socketPath} closed before granting`))
  else loseBrokerLease(state, 'broker gone')
}
