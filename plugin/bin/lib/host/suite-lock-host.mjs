import { randomUUID } from 'node:crypto'
import { rmSync, statSync } from 'node:fs'
import net from 'node:net'

export const createSuiteLockLeaseId = () => randomUUID()
export const connectSuiteLockBroker = (socketPath) => net.connect(socketPath)

export function removeStaleSuiteLockReclaim(reclaimDir, now = Date.now()) {
  let age
  try { age = now - statSync(reclaimDir).mtimeMs } catch { return false }
  if (age < 30_000) return false
  rmSync(reclaimDir, { recursive: true, force: true })
  return true
}

export function stopChildForLostSuiteLock(child) {
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  timer.unref?.()
  return () => clearTimeout(timer)
}
