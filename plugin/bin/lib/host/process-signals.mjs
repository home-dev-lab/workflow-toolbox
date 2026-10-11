// Signal zero observes existence, not identity. Permission denial proves existence;
// an unexpected error is explicitly unknown and must not authorise reclamation.
function signalFailure(error) {
  const code = error?.code
  const reason = code ?? String(error)
  if (code === 'ESRCH') return { status: 'gone', reason, error }
  return { status: code === 'EPERM' ? 'denied' : 'unknown', reason, error }
}

function validPid(pid) { return Number.isSafeInteger(pid) && pid > 0 }

export function sendProcessSignal(invoke, pid, signal) {
  if (!validPid(pid)) return { status: 'unknown', reason: 'EINVAL' }
  return invokeSignal(invoke, pid, signal)
}

function invokeSignal(invoke, pid, signal) {
  try { invoke.kill(pid, signal); return { status: 'sent' } } catch (error) { return signalFailure(error) }
}

function liveness(result) {
  if (result.status === 'sent' || result.status === 'denied') return { status: 'alive' }
  if (result.status === 'gone') return { status: 'gone' }
  return { status: 'unknown', reason: result.reason }
}

export function readProcessLiveness(invoke, pid) {
  return liveness(sendProcessSignal(invoke, pid, 0))
}

export function readProcessGroupLiveness(platform, invoke, pid) {
  if (platform === 'win32') return { status: 'unknown', reason: 'POSIX process groups are unavailable on win32' }
  if (!validPid(pid)) return { status: 'unknown', reason: 'EINVAL' }
  return liveness(invokeSignal(invoke, -pid, 0))
}
