import { expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper
import { createHostAdapter } from '../../../../plugin/bin/lib/host/adapter.mjs'

  it.each(['linux', 'darwin', 'win32'])('classifies liveness errors on %s without treating unknown as gone', (platform) => {
    const kill = vi.fn()
    const host = createHostAdapter({ platform, invoke: { kill } })
    expect(host.readProcessLiveness, 'single PID liveness operation').toBeTypeOf('function')
    expect(host.readProcessLiveness(42)).toEqual({ status: 'alive' })
    for (const [code, status] of [['EPERM', 'alive'], ['ESRCH', 'gone'], ['EIO', 'unknown']]) {
      kill.mockImplementation(() => { throw Object.assign(new Error(code), { code }) })
      expect(host.readProcessLiveness(42)).toMatchObject({ status })
    }
    expect(kill.mock.calls).toEqual(Array.from({ length: 4 }, () => [42, 0]))
  })

  it.each(['linux', 'darwin', 'win32'])('names every single-PID signal outcome on %s', (platform) => {
    const kill = vi.fn()
    const host = createHostAdapter({ platform, invoke: { kill } })
    expect(host.sendProcessSignal, 'single PID signal operation').toBeTypeOf('function')
    expect(host.sendProcessSignal(42, 'SIGTERM')).toEqual({ status: 'sent' })
    for (const [code, status] of [['EPERM', 'denied'], ['ESRCH', 'gone'], ['EIO', 'unknown']]) {
      kill.mockImplementation(() => { throw Object.assign(new Error(code), { code }) })
      expect(host.sendProcessSignal(42, 'SIGTERM')).toMatchObject({ status, reason: code })
    }
  })

  it('exports Linux force-family termination through the injected invocation', () => {
    const killGroup = vi.fn(() => ({ status: 'ended', kind: 'posix_process_group' }))
    const host = createHostAdapter({ platform: 'linux', invoke: { killGroup } })
    expect(() => host.forceEndProcessFamily(42)).not.toThrow()
    expect(killGroup).toHaveBeenCalledWith(42, 'SIGKILL')
  })

  it('uses the captured forced Windows process-tree operation for both family requests', () => {
    const killTree = vi.fn(() => ({ status: 'ended', kind: 'process_tree' }))
    const host = createHostAdapter({ platform: 'win32', invoke: { killTree } })
    host.endProcessFamily(42)
    host.forceEndProcessFamily(42)
    expect(killTree.mock.calls).toEqual([[42, true], [42, true]])
  })

  it('asks POSIX group liveness and never passes a negative PID on Windows', () => {
    const kill = vi.fn()
    const posix = createHostAdapter({ platform: 'linux', invoke: { kill } })
    expect(posix.readProcessGroupLiveness, 'group liveness operation').toBeTypeOf('function')
    expect(posix.readProcessGroupLiveness(42)).toEqual({ status: 'alive' })
    expect(kill).toHaveBeenCalledWith(-42, 0)
    for (const [code, status] of [['EPERM', 'alive'], ['ESRCH', 'gone'], ['EIO', 'unknown']]) {
      kill.mockImplementation(() => { throw Object.assign(new Error(code), { code }) })
      expect(posix.readProcessGroupLiveness(42)).toMatchObject({ status })
    }
    kill.mockClear()
    const windows = createHostAdapter({ platform: 'win32', invoke: { kill } })
    expect(windows.readProcessGroupLiveness(42)).toMatchObject({ status: 'unknown' })
    expect(windows.readProcessLiveness(-42)).toMatchObject({ status: 'unknown' })
    expect(kill).not.toHaveBeenCalled()
  })
