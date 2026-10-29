import { lightRunCommand } from '../suite-lock.mjs'
import { staticLaneEnabled, staticRunCommand } from '../suite-lock-static.mjs'
import { offloadWorkingDirectory } from './suite-lock-offload-config.mjs'
import { offloadFrame } from './suite-lock-offload-log.mjs'
import { startSuiteOffload } from './suite-lock-offload-process.mjs'

/** The event loop serializes every winner transition, including disconnect and acquisition failure. */
export async function acquireOffloadRace(acquire, release, options, { config, request, socket, deadlineS, completed }) {
  if (localOnlyRequest(config, request, options)) return acquire(options)
  let cwd
  try { cwd = offloadWorkingDirectory(config, request.offload.cwd) } catch (error) {
    offloadFrame(socket, request.offload.requestId, 'progress', { state: 'fallback', reason: error.message })
    return acquire(options)
  }
  const state = { winner: null, attempt: null, attempted: false }
  const controller = new AbortController()
  const abort = () => { state.winner ??= 'closed'; state.attempt?.stop(); controller.abort() }
  options.signal.addEventListener('abort', abort, { once: true })
  if (options.signal.aborted) abort()
  try {
    const lease = await raceAcquisition(acquire, release, options, { config, request, socket, deadlineS, cwd, state, controller })
    if (!lease.offloaded) return lease
    completed()
    throw Object.assign(new Error('offload completed'), { code: 'ABORT_ERR' })
  } finally { options.signal.removeEventListener('abort', abort) }
}

function localOnlyRequest(config, request, options) {
  return !config || !request.offload || request.light || lightRunCommand(request.argv) ||
    (staticLaneEnabled(options.env) && staticRunCommand(request.argv))
}

function raceAcquisition(acquire, release, options, context) {
  const { state, controller } = context
  return new Promise((resolve, reject) => {
    const complete = (result) => finishOffload(result, context, resolve, reject)
    const onQueuePlace = (place) => {
      options.onQueuePlace?.(place)
      if (state.winner || state.attempted || place.ahead < context.config.minAhead) return
      state.attempted = true
      try { state.attempt = startSuiteOffload(context.config, { requestId: context.request.offload.requestId, cwd: context.cwd,
        argv: context.request.argv, light: false, deadlineS: Math.max(1, Math.ceil(context.deadlineS)) }, context.socket, complete) }
      catch (error) { complete({ outcome: 'fallback', reason: `offload start failed: ${error.message}` }) }
    }
    acquire({ ...options, signal: controller.signal, onQueuePlace }).then((lease) => {
      if (state.winner) { release(lease); return }
      state.winner = 'local'; state.attempt?.stop(); resolve(lease)
    }, (error) => {
      if (state.winner === 'offload') return
      state.winner = 'failed'; state.attempt?.stop(); reject(error)
    })
  })
}

function finishOffload(result, { state, controller, socket, request }, resolve, reject) {
  if (state.winner) return
  const requestId = request.offload.requestId
  if (result.outcome !== 'completed') {
    offloadFrame(socket, requestId, 'progress', { state: 'fallback', reason: result.reason })
    state.attempt?.stop()
    return
  }
  state.winner = 'offload'; controller.abort()
  state.attempt.finish().then(() => {
    offloadFrame(socket, requestId, 'completed', { exit: result.exit, archive: result.archive, snapshot: result.snapshot })
    resolve({ offloaded: true })
  }, reject)
}
