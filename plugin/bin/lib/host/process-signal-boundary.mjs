import { hostAdapter } from './adapter.mjs'

// Legacy kill injection seams are throwing functions. Map every named adapter
// outcome here so a returned failure cannot be mistaken for a successful signal.
export function signalProcess(pid, signal, host = hostAdapter) {
  const result = processSignalResult(pid, signal, host)
  if (result.status === 'sent' || result.status === 'ended') return true
  throw result.error ?? Object.assign(new Error(result.reason ?? result.status), { code: result.reason ?? result.status })
}

function processSignalResult(pid, signal, host) {
  if (pid >= 0) return host.sendProcessSignal(pid, signal)
  if (host.platform === 'win32') return { status: 'unknown', reason: 'EINVAL' }
  if (signal === 'SIGTERM') return host.endProcessFamily(-pid)
  if (signal === 'SIGKILL') return host.forceEndProcessFamily(-pid)
  return { status: 'unknown', reason: 'unsupported process-group signal' }
}

export function retainProcessOwner(pid, readLiveness = hostAdapter.readProcessLiveness) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  return readLiveness(pid).status !== 'gone'
}

export function reapProcessFamily(pid, host = hostAdapter) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  host.forceEndProcessFamily(pid)
  if (host.platform === 'win32') return null
  const result = host.readProcessGroupLiveness(pid)
  if (result.status === 'alive') return 1
  if (result.status === 'gone') return 0
  return null
}
