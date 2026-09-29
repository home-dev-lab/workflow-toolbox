import { randomUUID } from 'node:crypto'
import net from 'node:net'

export const createSuiteLockLeaseId = () => randomUUID()
export const connectSuiteLockBroker = (socketPath) => net.connect(socketPath)

export function signalCoveredCommand(child, signal) {
  return child.kill(signal)
}

export function stopChildForLostSuiteLock(child) {
  signalCoveredCommand(child, 'SIGTERM')
  const timer = setTimeout(() => signalCoveredCommand(child, 'SIGKILL'), 5000)
  timer.unref?.()
  return () => clearTimeout(timer)
}
