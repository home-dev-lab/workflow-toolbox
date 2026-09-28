import { randomUUID } from 'node:crypto'
import net from 'node:net'

export const createSuiteLockLeaseId = () => randomUUID()
export const connectSuiteLockBroker = (socketPath) => net.connect(socketPath)

export function stopChildForLostSuiteLock(child) {
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  timer.unref?.()
  return () => clearTimeout(timer)
}
