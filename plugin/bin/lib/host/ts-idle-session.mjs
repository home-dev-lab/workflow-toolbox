import { PassThrough, Writable } from 'node:stream'
import { planTsLaunch, runTsLaunch } from './ts-language-server.mjs'
import { tsFrame, tsFrameReader } from './ts-lsp-wire.mjs'
import { rememberTsState, tsReplayState } from './ts-session-state.mjs'
import { spawnTsProcess } from './ts-process.mjs'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { superviseTsStop, signalTsBackend } from './ts-idle-stop.mjs'
import { acceptTsRegistration, consumeTsUnregisterReply, releaseTsRegistrations } from './ts-session-registrations.mjs'

const TS_IDLE_MS = 60_000
const STOP_MS = 5000
const QUEUE_LIMIT = 16 * 1024 * 1024

function idleSetting(value) {
  const ms = Number(value)
  return Number.isSafeInteger(ms) && ms >= 1000 && ms <= 3_600_000 ? ms : TS_IDLE_MS
}

function send(state, message) {
  const backend = state.backend
  if (!backend || backend.input.writableEnded || backend.input.destroyed || state.phase === 'closed') return
  if (backend.input.write(tsFrame(message))) return
  state.streams.input.pause()
  backend.resume ??= () => state.streams.input.resume()
  backend.input.once('drain', backend.resume)
}
function publish(state, message) { state.streams.output.write(tsFrame(message)) }

function finish(state, code, signal) {
  if (state.phase === 'closed') return
  state.phase = 'closed'
  clearTimeout(state.idleTimer); clearTimeout(state.stopTimer); clearTimeout(state.killTimer)
  state.streams.input.off('data', state.receive)
  for (const [signal, handler] of state.signals ?? []) state.signalSource.off(signal, handler)
  if (signal) state.streams.exitSignal(signal)
  else state.streams.output.write('', () => state.streams.exit(code))
}

function fail(state, error) {
  state.streams.stderr.write(`wt-tsls: ${error.message}\n`)
  state.backend?.input.end()
  if (state.backend) signalTsBackend(state, state.backend, 'SIGKILL')
  finish(state, 1)
}

function exitIdleBackend(state) {
  const backend = state.backend
  if (backend.input.writableEnded) return
  send(state, { jsonrpc: '2.0', method: 'exit' })
  backend.input.end()
}

function retire(state) {
  if (state.phase !== 'active') return
  state.phase = 'stopping'
  state.shutdownId = `wt-tsls-idle-${state.generation}`
  for (const id of state.requests) publish(state, { jsonrpc: '2.0', id, error: { code: -32800, message: 'Backend retired after the unanswered-request deadline' } })
  state.requests.clear(); state.serverRequests.clear()
  releaseTsRegistrations(state)
  state.streams.stderr.write(`wt-tsls: idle for ${state.idleMs}ms; shutting down backend\n`)
  superviseTsStop(state, closedBackend)
  send(state, { jsonrpc: '2.0', id: state.shutdownId, method: 'shutdown' })
}

function armIdle(state) {
  if (state.phase !== 'active') return
  clearTimeout(state.idleTimer)
  if (state.ended) return
  const grace = state.requests.size || state.serverRequests.size ? state.idleMs : 0
  const remaining = Math.max(0, state.lastRequest + state.idleMs + grace - Date.now())
  state.idleTimer = setTimeout(() => retire(state), remaining)
  state.idleTimer.unref()
}

function trackClient(state, message) {
  if (message.method && message.id !== undefined) { state.requests.add(message.id); state.lastRequest = state.requestDates.get(message) ?? Date.now() }
  if (!message.method && message.id !== undefined) acceptTsRegistration(state, message)
  armIdle(state)
}

function dispatchClient(state, message) {
  const request = !message.method && state.serverRequests.get(message.id)
  const outbound = request ? { ...message, id: request.backendId } : message
  trackClient(state, message)
  send(state, outbound)
}

function replay(state) {
  if (state.ended) return
  for (const message of state.snapshot) send(state, message)
  state.snapshot = undefined
  state.replayInitialize = undefined
  state.phase = 'active'
  const queue = state.queue
  state.queue = []; state.queueBytes = 0
  for (const message of queue) dispatchClient(state, message)
  armIdle(state)
}

function replacementMismatch(state, message) {
  return message.error || !isDeepStrictEqual(state.capabilities, message.result?.capabilities ?? {})
}

function initialized(state, message, restarting) {
  if (state.ended) return
  if (!restarting) {
    state.phase = 'active'
    state.capabilities = message.result?.capabilities ?? {}
    publish(state, message)
  } else if (replacementMismatch(state, message)) {
    const error = message.error ?? { code: -32603, message: 'Replacement backend capabilities changed; reconnect the language client' }
    for (const request of state.queue.filter(item => item.id !== undefined && item.method)) publish(state, { jsonrpc: '2.0', id: request.id, error })
    fail(state, new Error('replacement backend refused initialize'))
    return
  } else replay(state)
  armIdle(state)
}

function stoppingBackend(state, message) {
  if (message.id === state.shutdownId && !message.method) { exitIdleBackend(state); return true }
  if (state.ended && !state.shutdownId) return state.generation > 1 && message.id === state.initialize.id && !message.method
  return !message.method || message.id !== undefined
}

function backendLifecycle(state, message, restarting) {
  if (state.phase === 'closed') return true
  if (state.phase === 'stopping') return stoppingBackend(state, message)
  if (state.phase === 'starting' && message.id === state.initialize.id && !message.method) { initialized(state, message, restarting); return true }
  return false
}

function fromBackend(state, message, restarting) {
  if (backendLifecycle(state, message, restarting)) return
  if (message.method === 'client/registerCapability' || message.method === 'client/unregisterCapability') {
    const key = message.method === 'client/registerCapability' ? 'registrations' : 'unregisterations'
    message = { ...message, params: { ...message.params, [key]: message.params[key].map(item => ({ ...item, id: `wt-tsls-${state.nonce}-${state.generation}-${item.id}` })) } }
  }
  if (message.method && message.id !== undefined) {
    const backendId = message.id
    message = { ...message, id: `wt-tsls-request-${state.nonce}-${state.generation}-${backendId}` }
    state.serverRequests.set(message.id, { ...message, backendId })
  }
  if (!message.method && message.id !== undefined) state.requests.delete(message.id)
  publish(state, message)
  if (message.id !== undefined) armIdle(state)
}

function closedBackend(state, backend, code, signal) {
  if (state.backend !== backend || state.phase === 'closed') return
  if (backend.forced && !backend.killed) return
  if (backend.resume) backend.input.off('drain', backend.resume)
  state.streams.input.resume()
  clearTimeout(state.stopTimer); clearTimeout(state.killTimer)
  if (state.phase !== 'stopping' || state.ended) { finish(state, code, state.signal ?? signal); return }
  state.backend = undefined; state.phase = 'sleeping'
  if (state.queue.length) startBackend(state, true)
}

function startBackend(state, restarting) {
  state.phase = 'starting'; state.generation++; state.shutdownId = undefined
  const input = new PassThrough()
  input.on('error', error => { if (!state.ended && state.phase !== 'closed') fail(state, error) })
  const receive = tsFrameReader(message => fromBackend(state, message, restarting))
  const output = new Writable({ write(chunk, _encoding, done) {
    try {
      receive(chunk)
      if (state.streams.output.writableNeedDrain) state.streams.output.once('drain', done)
      else done()
    } catch (error) { fail(state, error); done() }
  } })
  const backend = { input, output, child: undefined }
  state.backend = backend
  state.idleTimer = setTimeout(() => {
    if (state.backend === backend && state.phase === 'starting') fail(state, new Error('backend initialize exceeded the unanswered-request deadline'))
  }, state.idleMs * 2)
  state.idleTimer.unref()
  const start = state.options.start ?? spawnTsProcess
  runTsLaunch({ ...state.options, input, output, forwardSignals: false, stderr: state.streams.stderr,
    select: params => { state.plan ??= (state.options.select ?? planTsLaunch)(params); return state.plan },
    start: (command, args, options) => { backend.child = start(command, args, { ...options, detached: process.platform !== 'win32' }); return backend.child },
    exit: code => closedBackend(state, backend, code), exitSignal: signal => closedBackend(state, backend, 1, signal) })
  send(state, state.replayInitialize ?? state.initialize)
}

function queueRequest(state, message) {
  if (!state.snapshot) { state.snapshot = tsReplayState(state); state.replayInitialize = state.initialize }
  state.queueBytes += tsFrame(message).length
  if (state.queueBytes > QUEUE_LIMIT) throw new Error('pending LSP requests exceed the size limit')
  if (message.method && message.id !== undefined) state.requestDates.set(message, Date.now())
  state.queue.push(message)
  if (state.phase === 'sleeping') startBackend(state, true)
}

function inactiveClient(state, message) {
  if (message.method === 'exit') {
    state.ended = true
    if (state.backend) exitIdleBackend(state)
    else finish(state, 0)
    return
  }
  if (message.method === 'shutdown') { state.ended = true; publish(state, { jsonrpc: '2.0', id: message.id, result: null }); return }
  if ((message.id !== undefined && message.method) || state.queue.length) queueRequest(state, message)
}

function initializeClient(state, message) {
  if (message.method === 'exit') { finish(state, 0); return }
  if (message.method !== 'initialize') {
    if (message.id !== undefined) throw new Error('expected initialize before any request')
    return
  }
  state.initialize = message
  state.lastRequest = Date.now()
  startBackend(state, false)
}

function handleClientControl(state, message) {
  if (consumeTsUnregisterReply(state, message)) return true
  if (message.method === 'exit') { endClient(state, true); return true }
  if (!message.method && !state.serverRequests.has(message.id)) return true
  if (!message.method && state.phase === 'starting') { dispatchClient(state, message); return true }
  return false
}

function fromClient(state, message) {
  if (state.phase === 'closed') return
  if (!state.initialize) { initializeClient(state, message); return }
  if (handleClientControl(state, message)) return
  rememberTsState(state, message)
  if (['sleeping', 'stopping'].includes(state.phase)) { inactiveClient(state, message); return }
  if (state.phase === 'starting' && state.generation > 1) { queueRequest(state, message); return }
  if (message.method === 'shutdown' || message.method === 'exit') state.ended = true
  dispatchClient(state, message)
}

export function runTsIdleSession(options = {}) {
  const streams = { input: process.stdin, output: process.stdout, stderr: process.stderr,
    exit: code => process.exit(code), exitSignal: signal => process.kill(process.pid, signal), ...options }
  const state = { options, streams, phase: 'new', generation: 0, documents: new Map(), requests: new Set(), serverRequests: new Map(),
    signalSource: options.signalSource ?? process,
    registrations: new Map(), unregisterIds: new Set(), requestDates: new WeakMap(), nonce: randomUUID(),
    queue: [], queueBytes: 0, idleMs: options.idleMs ?? idleSetting(process.env.WT_TSLS_IDLE_MS), stopMs: options.stopMs ?? STOP_MS }
  const receive = tsFrameReader(message => fromClient(state, message))
  state.receive = chunk => { try { receive(chunk) } catch (error) { fail(state, error) } }
  streams.input.on('data', state.receive)
  streams.input.on('error', error => fail(state, error))
  streams.input.on('end', () => {
    endClient(state, false)
  })
  state.signals = ['SIGTERM', 'SIGINT'].map(signal => {
    const handler = () => { state.signal = signal; endClient(state, true) }
    state.signalSource.on(signal, handler)
    return [signal, handler]
  })
}

function endClient(state, sendExit) {
  state.ended = true; clearTimeout(state.idleTimer)
  if (!state.backend) { finish(state, 0, state.signal); return }
  const stopping = state.phase === 'stopping'
  state.phase = 'stopping'
  if (sendExit) exitIdleBackend(state)
  else state.backend.input.end()
  if (!stopping) superviseTsStop(state, closedBackend)
}
