import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { renameRetryingTransient, TRANSIENT_RENAME_ATTEMPTS } from '../../../../plugin/bin/lib/host/adopt-placement.mjs'

const coded = (code: string) => Object.assign(new Error(`refused ${code}`), { code })

function scripted(failures: (string | null)[]) {
  const calls: string[][] = []
  const pauses: number[] = []
  const rename = (from: string, to: string) => {
    calls.push([from, to])
    const code = failures[calls.length - 1]
    if (code) throw coded(code)
  }
  return { calls, pauses, rename, pause: (ms: number) => { pauses.push(ms) } }
}

describe('renameRetryingTransient', () => {
  it('renames once when the first attempt succeeds', () => {
    const seams = scripted([null])
    expect(renameRetryingTransient('a', 'b', seams)).toEqual({ renamed: true })
    expect(seams.calls).toEqual([['a', 'b']])
    expect(seams.pauses).toEqual([])
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries %s with a linear back-off', (code) => {
    const seams = scripted([code, code, null])
    expect(renameRetryingTransient('a', 'b', { ...seams, pauseMs: 10 })).toEqual({ renamed: true })
    expect(seams.calls).toHaveLength(3)
    expect(seams.pauses).toEqual([10, 20])
  })

})

describe('renameRetryingTransient — stopping', () => {
  it('rethrows a non-transient error without retrying', () => {
    const seams = scripted(['ENOENT'])
    expect(() => renameRetryingTransient('a', 'b', seams)).toThrow('refused ENOENT')
    expect(seams.calls).toHaveLength(1)
  })

  it('rethrows the last transient error once the attempts are spent', () => {
    const seams = scripted(Array(TRANSIENT_RENAME_ATTEMPTS).fill('EPERM'))
    expect(() => renameRetryingTransient('a', 'b', seams)).toThrow('refused EPERM')
    expect(seams.calls).toHaveLength(TRANSIENT_RENAME_ATTEMPTS)
    expect(seams.pauses).toHaveLength(TRANSIENT_RENAME_ATTEMPTS - 1)
  })

  it('stops without renaming when beforeRetry returns a value', () => {
    const seams = scripted(['EPERM', null])
    const seen: string[] = []
    const outcome = renameRetryingTransient('a', 'b', { ...seams, beforeRetry: (error: { code: string }) => { seen.push(error.code); return false } })
    expect(outcome).toEqual({ renamed: false, value: false })
    expect(seen).toEqual(['EPERM'])
    expect(seams.calls).toHaveLength(1)
    expect(seams.pauses).toEqual([25])
  })

})

describe('renameRetryingTransient — pausing', () => {
  it('asks beforeRetry after the pause, so a change made while waiting is seen', () => {
    const events: string[] = []
    const outcome = renameRetryingTransient('a', 'b', {
      rename: () => { events.push('rename'); if (events.length === 1) throw coded('EPERM') },
      pause: () => { events.push('pause') },
      beforeRetry: () => { events.push('check'); return undefined },
    })
    expect(outcome).toEqual({ renamed: true })
    expect(events).toEqual(['rename', 'pause', 'check', 'rename'])
  })

  it('pauses for real by default', () => {
    const seams = scripted(['EBUSY', null])
    const started = performance.now()
    expect(renameRetryingTransient('a', 'b', { rename: seams.rename, pauseMs: 30 })).toEqual({ renamed: true })
    expect(performance.now() - started).toBeGreaterThanOrEqual(25)
  })
})
