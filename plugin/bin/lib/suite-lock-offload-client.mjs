import { createOffloadRequest } from './host/suite-lock-offload-request.mjs'

/** Only command-running clients may opt in: generic lease consumers still need a local lease. */
export async function negotiateSuiteOffload(socketPath, options, status) {
  if (!options.offload || options.light) return options
  try {
    const reply = await status(socketPath)
    if (reply.capabilities?.offload === 1) return { ...options, offloadRequest: createOffloadRequest(options.cwd, options.env) }
  } catch { /* Unavailable/older status preserves the ordinary local queue route. */ }
  return options
}

export function olderOffloadRefusal(line, options) {
  return Boolean(options.offloadRequest && line.startsWith('error argv must be an array of strings') && !line.includes('offload'))
}

export function brokerCompatibilityRefusal(line, options, olderPriorityRefusal) {
  return olderOffloadRefusal(line, options) || (options.light === true && olderPriorityRefusal(line))
}

export function filterSuiteOffloadLine(line, options, completed, fail) {
  if (!line.startsWith('offload ')) return line
  try {
    const frame = receiveSuiteOffload(line, options)
    if (frame) completed(frame)
  } catch (error) { fail(error) }
  return ''
}

function completedFrame(frame) {
  const id = (value) => typeof value === 'string' && /^[A-Za-z0-9._:/@+-]{1,512}$/.test(value)
  return frame.type === 'completed' && Number.isInteger(frame.exit) && frame.exit >= 0 && frame.exit <= 255 && id(frame.archive) && id(frame.snapshot)
}

function readFrame(line, options) {
  const frame = JSON.parse(line.slice(8))
  if (!options.offloadRequest || frame.version !== 1 || frame.requestId !== options.offloadRequest.requestId) throw new Error('invalid offload frame request id or version')
  return frame
}

function logFrame(frame, options) {
  if (frame.type !== 'log') return false
  if (typeof frame.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new Error('invalid offload log frame')
  options.onOffloadLog?.(Buffer.from(frame.data, 'base64'))
  return true
}

function progressFrame(frame, options) {
  if (frame.type !== 'progress' || typeof frame.state !== 'string') return false
  options.onWait?.(`wt-suite-lock: offload ${frame.state}${frame.reason ? ` (${JSON.stringify(frame.reason)})` : ''}`)
  return true
}

/** JSON framing and an exact per-connection id keep log text and unrelated results out of control flow. */
export function receiveSuiteOffload(line, options) {
  if (!line.startsWith('offload ')) return null
  const frame = readFrame(line, options)
  if (logFrame(frame, options) || progressFrame(frame, options)) return null
  if (completedFrame(frame)) return frame
  throw new Error('invalid offload frame outcome')
}
