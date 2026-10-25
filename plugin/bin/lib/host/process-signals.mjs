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

// Existence includes unreaped zombies. Keep that contract for ownership callers;
// shutdown confirmation separately asks whether execution has actually ended.
export function readProcessExecutionState(platform, invoke, pid) {
  const result = readProcessLiveness(invoke, pid)
  if (result.status !== 'alive') return result
  if (platform !== 'linux') return { status: 'unknown', reason: `PROCESS_STATE_UNAVAILABLE on ${platform}` }
  return linuxExecutionState(invoke, pid)
}

function linuxExecutionState(invoke, pid) {
  try {
    const stat = invoke.read(`/proc/${pid}/stat`)
    if (stat.status !== 'read') return { status: 'unknown', reason: `PROCESS_STATE_UNAVAILABLE: ${stat.reason}` }
    const state = stat.value.slice(stat.value.lastIndexOf(')') + 1).match(/^ ([RSDZTtXxKWPI]) /)?.[1]
    if (!stat.value.startsWith(`${pid} (`) || !state) return { status: 'unknown', reason: 'PROCESS_STATE_INVALID' }
    if (state === 'Z' || state === 'X' || state === 'x') return { status: 'gone' }
    return { status: 'alive' }
  } catch (error) {
    return { status: 'unknown', reason: `PROCESS_STATE_UNAVAILABLE: ${signalFailure(error).reason}` }
  }
}

export function readProcessGroupLiveness(platform, invoke, pid) {
  if (platform === 'win32') return { status: 'unknown', reason: 'POSIX process groups are unavailable on win32' }
  if (!validPid(pid)) return { status: 'unknown', reason: 'EINVAL' }
  return liveness(invokeSignal(invoke, -pid, 0))
}
