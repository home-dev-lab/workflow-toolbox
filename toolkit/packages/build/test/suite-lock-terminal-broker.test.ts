import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
// @ts-expect-error plugin runtime module
import { runSuiteLockCli } from '../../../../plugin/bin/wt-suite-lock.mjs'

const connect = vi.hoisted(() => vi.fn())
vi.mock('../../../../plugin/bin/lib/host/suite-lock-host.mjs', async (original) => ({
  ...await original<object>(), connectSuiteLockBroker: connect,
}))

class Socket extends EventEmitter {
  destroyed = false
  write = vi.fn()
  end = vi.fn(() => { this.destroy() })
  destroy() { this.destroyed = true; this.emit('close') }
}

afterEach(() => { vi.unstubAllEnvs(); connect.mockReset() })

function brokerRun() {
  vi.stubEnv('WT_SUITE_LOCK', '1')
  vi.stubEnv('WT_SUITE_LOCK_BROKER', 'stubbed-broker')
  vi.stubEnv('WT_SUITE_LEASE', '')
  vi.stubEnv('WT_SUITE_LOCK_STATIC_LANE', '0')
  const socket = new Socket()
  connect.mockImplementation(() => { queueMicrotask(() => socket.emit('connect')); return socket })
  const result = runSuiteLockCli(['run', '--light', '--', 'never-spawn-this-command'])
  return { socket, result }
}

it('closes a waiting broker connection and returns the signal exit', async () => {
  const before = process.listenerCount('SIGTERM')
  const { socket, result } = brokerRun()
  await vi.waitFor(() => expect(socket.write).toHaveBeenCalled())
  try {
    expect(process.listenerCount('SIGTERM')).toBeGreaterThan(before)
    process.emit('SIGTERM')
    expect(await result).toBe(143)
    expect(socket.destroyed).toBe(true)
  } finally { socket.destroy(); await result.catch(() => {}) }
  expect(process.listenerCount('SIGTERM')).toBe(before)
})

it('closes a granted broker connection without spawning after a signal', async () => {
  const before = process.listenerCount('SIGHUP')
  const { socket, result } = brokerRun()
  await vi.waitFor(() => expect(socket.write).toHaveBeenCalled())
  try {
    expect(process.listenerCount('SIGHUP')).toBeGreaterThan(before)
    socket.emit('data', 'granted broker-lease\n')
    process.emit('SIGHUP')
    expect(await result).toBe(129)
    expect(socket.end).toHaveBeenCalledWith(`${JSON.stringify({ exit: 129, served: false })}\n`)
  } finally { socket.destroy(); await result.catch(() => {}) }
  expect(process.listenerCount('SIGHUP')).toBe(before)
})
