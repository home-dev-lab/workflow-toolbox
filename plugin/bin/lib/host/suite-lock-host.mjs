import { randomUUID } from 'node:crypto'
import net from 'node:net'

export const createSuiteLockLeaseId = () => randomUUID()
export const connectSuiteLockBroker = (socketPath) => net.connect(socketPath)

// A command run under a BROKER lease (the Linux lane sandbox only) gets its own process group, so a
// lost lease stops its whole tree (`bash -c 'cd toolkit && pnpm test'` → vitest → workers), not just
// the wrapper. Never for a filesystem lease or an inherited-marker run: an interactive host run keeps
// its terminal's job control. Windows has no broker, so nothing changes there.
export function coveredCommandSpawnOptions({ broker = false, platform = process.platform } = {}) {
  return broker && platform !== 'win32' ? { detached: true } : {}
}

function groupSignalled(child, group) {
  return group && process.platform !== 'win32' && Number.isSafeInteger(child?.pid)
}

export function signalCoveredCommand(child, signal, { group = false } = {}) {
  if (groupSignalled(child, group)) {
    try { process.kill(-child.pid, signal); return true } catch (error) {
      if (error?.code === 'ESRCH') return false
    }
  }
  return child.kill(signal)
}

function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

// SIGTERM, then SIGKILL after this many ms, to the whole group: an early exit of the direct child
// (a wrapper that dies on SIGTERM while its grandchild ignores it) never cancels the SIGKILL.
export const LOST_LEASE_TERM_GRACE_MS = 5000
// How long after the SIGKILL the tree may take to vanish before the caller gives up waiting (a zombie
// nobody reaps would otherwise hold it forever); the broker's own stop grace bounds the lock anyway.
export const LOST_LEASE_KILL_WAIT_MS = 5000

/**
 * Stops a covered command after its lease was lost and resolves once its tree is gone: `true`, or
 * `false` when it was still visible LOST_LEASE_KILL_WAIT_MS after the SIGKILL. With `group`, the
 * signals and the liveness check address the process group (POSIX); otherwise the direct child only.
 */
export function stopCoveredCommandTree(child, { group = false, termGraceMs = LOST_LEASE_TERM_GRACE_MS, killWaitMs = LOST_LEASE_KILL_WAIT_MS, pollMs = 50 } = {}) {
  const useGroup = groupSignalled(child, group)
  const alive = () => (useGroup ? groupAlive(child.pid) : child.exitCode === null && child.signalCode === null)
  return new Promise((resolve) => {
    const started = Date.now()
    let killed = false
    signalCoveredCommand(child, 'SIGTERM', { group: useGroup })
    const tick = () => {
      if (!alive()) { resolve(true); return }
      const elapsed = Date.now() - started
      if (!killed && elapsed >= termGraceMs) { killed = true; signalCoveredCommand(child, 'SIGKILL', { group: useGroup }) }
      if (elapsed >= termGraceMs + killWaitMs) { resolve(false); return }
      setTimeout(tick, pollMs)
    }
    setTimeout(tick, pollMs)
  })
}
