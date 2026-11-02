import { PassThrough, Writable } from 'node:stream'
import { planTsLaunch, runTsLaunch } from './ts-language-server.mjs'
import { tsFrame, tsFrameReader } from './ts-lsp-wire.mjs'
import { rememberTsState, tsReplayState } from './ts-session-state.mjs'
import { spawnTsProcess } from './ts-process.mjs'
import { randomUUID } from 'node:crypto'
import { acceptTsRegistration, consumeTsUnregisterReply, releaseTsRegistrations } from './ts-session-registrations.mjs'

const TS_IDLE_MS = 60_000
const STOP_MS = 5000
const QUEUE_LIMIT = 16 * 1024 * 1024

function idleSetting(value) {
  const ms = Number(value)
  return Number.isSafeInteger(ms) && ms >= 1000 && ms <= 3_600_000 ? ms : TS_IDLE_MS
}

function send(state, message) {
  if (state.backend.input.write(tsFrame(message))) return
  state.streams.input.pause()
  state.backend.input.once('drain', () => state.streams.input.resume())
}
function publish(state, message) { state.streams.output.write(tsFrame(message)) }

function finish(state, code, signal) {
  if (state.phase === 'closed') return
  state.phase = 'closed'
  clearTimeout(state.idleTimer); clearTimeout(state.stopTimer); clearTimeout(state.killTimer)
  state.streams.input.off('data', state.receive)
  if (signal) state.streams.exitSignal(signal)
  else state.streams.output.write('', () => state.streams.exit(code))
}

function fail(state, error) {
  state.streams.stderr.write(`wt-tsls: ${error.message}\n`)
  state.backend?.input.end()
  finish(state, 1)
}

function exitIdleBackend(state) {
  const backend = state.backend
  if (backend.input.writableEnded) return
  send(state, { jsonrpc: '2.0', method: 'exit' })
  backend.input.end()
}

function retire(state) {
  if (state.phase !== 'active' || state.requests.size || state.serverRequests.size) return
  state.phase = 'stopping'
  state.shutdownId = `wt-tsls-idle-${state.generation}`
  const backend = state.backend
  releaseTsRegistrations(state)
  state.streams.stderr.write(`wt-tsls: idle for ${state.idleMs}ms; shutting down backend\n`)
  state.stopTimer = setTimeout(() => {
    if (state.backend !== backend || state.phase !== 'stopping') return
    exitIdleBackend(state)
    backend.child?.kill('SIGTERM')
    state.killTimer = setTimeout(() => {
      if (state.backend === backend && state.phase === 'stopping') backend.child?.kill('SIGKILL')
    }, 1000)
    state.killTimer.unref()
  }, state.stopMs)
  state.stopTimer.unref()
  send(state, { jsonrpc: '2.0', id: state.shutdownId, method: 'shutdown' })
}

function armIdle(state) {
  clearTimeout(state.idleTimer)
  if (state.phase !== 'active' || state.requests.size || state.serverRequests.size || state.ended) return
  state.idleTimer = setTimeout(() => retire(state), state.idleMs)
  state.idleTimer.unref()
}

function trackClient(state, message) {
  if (message.method && message.id !== undefined) state.requests.add(message.id)
  if (!message.method && message.id !== undefined) acceptTsRegistration(state, message)
  if (message.id !== undefined) armIdle(state)
}

function replay(state) {
  for (const message of state.snapshot) send(state, message)
  state.snapshot = undefined
  state.phase = 'active'
  const queue = state.queue
  state.queue = []; state.queueBytes = 0
  for (const message of queue) { trackClient(state, message); send(state, message) }
  armIdle(state)
}

function initialized(state, message, restarting) {
  if (!restarting) {
    state.phase = 'active'
    publish(state, message)
  } else if (message.error) {
    for (const request of state.queue.filter(item => item.id !== undefined && item.method)) publish(state, { jsonrpc: '2.0', id: request.id, error: message.error })
    fail(state, new Error('replacement backend refused initialize'))
    return
  } else replay(state)
  armIdle(state)
}

function backendLifecycle(state, message, restarting) {
  if (state.phase === 'closed') return true
  if (state.phase === 'stopping') {
    if (message.id === state.shutdownId && !message.method) exitIdleBackend(state)
    return true
  }
  if (state.phase === 'starting' && message.id === state.initialize.id && !message.method) { initialized(state, message, restarting); return true }
  return false
}

function fromBackend(state, message, restarting) {
  if (backendLifecycle(state, message, restarting)) return
  if (message.method && message.id !== undefined) state.serverRequests.set(message.id, message)
  if (!message.method && message.id !== undefined) state.requests.delete(message.id)
  publish(state, message)
  if (message.id !== undefined) armIdle(state)
}

function closedBackend(state, backend, code, signal) {
  if (state.backend !== backend || state.phase === 'closed') return
  clearTimeout(state.stopTimer); clearTimeout(state.killTimer)
  if (state.phase !== 'stopping' || state.ended) { finish(state, code, signal); return }
  state.backend = undefined; state.phase = 'sleeping'
  if (state.queue.length) startBackend(state, true)
}

function startBackend(state, restarting) {
  state.phase = 'starting'; state.generation++
  const input = new PassThrough()
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
  const start = state.options.start ?? spawnTsProcess
  runTsLaunch({ ...state.options, input, output, stderr: state.streams.stderr,
    select: params => { state.plan ??= (state.options.select ?? planTsLaunch)(params); return state.plan },
    start: (...args) => { backend.child = start(...args); return backend.child },
    exit: code => closedBackend(state, backend, code), exitSignal: signal => closedBackend(state, backend, 1, signal) })
  send(state, state.initialize)
}

function queueRequest(state, message) {
  if (!state.snapshot) state.snapshot = tsReplayState(state)
  state.queueBytes += tsFrame(message).length
  if (state.queueBytes > QUEUE_LIMIT) throw new Error('pending LSP requests exceed the size limit')
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
  if (message.method === 'shutdown' && state.phase === 'sleeping') { publish(state, { jsonrpc: '2.0', id: message.id, result: null }); return }
  if (message.id !== undefined && message.method) queueRequest(state, message)
  else if (state.queue.length) queueRequest(state, message)
}

function initializeClient(state, message) {
  if (message.method === 'exit') { finish(state, 0); return }
  if (message.method !== 'initialize') {
    if (message.id !== undefined) throw new Error('expected initialize before any request')
    return
  }
  state.initialize = message
  startBackend(state, false)
}

function fromClient(state, message) {
  if (state.phase === 'closed') return
  if (!state.initialize) { initializeClient(state, message); return }
  if (consumeTsUnregisterReply(state, message)) return
  rememberTsState(state, message)
  if (['sleeping', 'stopping'].includes(state.phase)) { inactiveClient(state, message); return }
  if (state.phase === 'starting' && state.generation > 1) { queueRequest(state, message); return }
  if (message.method === 'shutdown' || message.method === 'exit') state.ended = true
  trackClient(state, message)
  send(state, message)
}

export function runTsIdleSession(options = {}) {
  const streams = { input: process.stdin, output: process.stdout, stderr: process.stderr,
    exit: code => process.exit(code), exitSignal: signal => process.kill(process.pid, signal), ...options }
  const state = { options, streams, phase: 'new', generation: 0, documents: new Map(), requests: new Set(), serverRequests: new Map(),
    registrations: new Map(), unregisterIds: new Set(), nonce: randomUUID(),
    queue: [], queueBytes: 0, idleMs: options.idleMs ?? idleSetting(process.env.WT_TSLS_IDLE_MS), stopMs: options.stopMs ?? STOP_MS }
  const receive = tsFrameReader(message => fromClient(state, message))
  state.receive = chunk => { try { receive(chunk) } catch (error) { fail(state, error) } }
  streams.input.on('data', state.receive)
  streams.input.on('error', error => fail(state, error))
  streams.input.on('end', () => {
    state.ended = true; clearTimeout(state.idleTimer)
    if (state.backend) state.backend.input.end()
    else finish(state, 0)
  })
}
