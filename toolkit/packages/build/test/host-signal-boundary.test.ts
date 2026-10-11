import { expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper
const boundary = await import('../../../../plugin/bin/lib/host/process-signal-boundary.mjs').catch(() => null)

  it('keeps throwing failure outcomes and returns only for successful signals', () => {
    expect(boundary, 'throwing signal compatibility boundary').not.toBeNull()
    const sendProcessSignal = vi.fn()
    const host = { platform: 'linux', sendProcessSignal }
    sendProcessSignal.mockReturnValue({ status: 'sent' })
    expect(boundary!.signalProcess(42, 'SIGTERM', host)).toBe(true)
    for (const [status, code] of [['gone', 'ESRCH'], ['denied', 'EPERM'], ['unknown', 'EIO']]) {
      const error = Object.assign(new Error(code), { code })
      sendProcessSignal.mockReturnValue({ status, reason: code, error })
      expect(() => boundary!.signalProcess(42, 'SIGTERM', host)).toThrow(error)
    }
    expect(sendProcessSignal).toHaveBeenCalledWith(42, 'SIGTERM')
  })

  it('routes every legacy group signal through its family operation', () => {
    expect(boundary).not.toBeNull()
    const endProcessFamily = vi.fn(() => ({ status: 'ended' }))
    const forceEndProcessFamily = vi.fn(() => ({ status: 'unavailable', reason: 'EPERM' }))
    const host = { platform: 'linux', endProcessFamily, forceEndProcessFamily }
    expect(boundary!.signalProcess(-42, 'SIGTERM', host)).toBe(true)
    expect(() => boundary!.signalProcess(-42, 'SIGKILL', host)).toThrow('EPERM')
    expect(endProcessFamily).toHaveBeenCalledWith(42)
    expect(forceEndProcessFamily).toHaveBeenCalledWith(42)
    expect(() => boundary!.signalProcess(-42, 'SIGTERM', { platform: 'win32' })).toThrow('EINVAL')
  })

  it('reports unknown group survivors as unmeasurable and preserves Windows task-tree force', () => {
    expect(boundary).not.toBeNull()
    const forceEndProcessFamily = vi.fn()
    const readProcessGroupLiveness = vi.fn()
    const host = { platform: 'linux', forceEndProcessFamily, readProcessGroupLiveness }
    for (const [status, expected] of [['alive', 1], ['gone', 0], ['unknown', null]] as const) {
      readProcessGroupLiveness.mockReturnValue({ status })
      expect(boundary!.reapProcessFamily(42, host)).toBe(expected)
    }
    readProcessGroupLiveness.mockClear()
    expect(boundary!.reapProcessFamily(42, { ...host, platform: 'win32' })).toBeNull()
    expect(forceEndProcessFamily).toHaveBeenLastCalledWith(42)
    expect(readProcessGroupLiveness).not.toHaveBeenCalled()
  })
