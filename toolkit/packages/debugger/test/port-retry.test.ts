import { describe, it, expect, vi } from 'vitest'
import { retryCanonicalPort } from '../src/port-retry.js'

// port-retry.ts — card #1826418086278858660 (silent ephemeral-port fallback). The scripted
// probe sequences below stand in for a REAL health probe cycle without any real socket/timer.

describe('retryCanonicalPort', () => {
  it('returns free immediately when the very first probe is unreachable (zero extra latency)', async () => {
    const probe = vi.fn().mockResolvedValue('unreachable')
    const sleep = vi.fn().mockResolvedValue(undefined)
    const out = await retryCanonicalPort({ probe, now: () => 0, sleep, timeoutMs: 5000, intervalMs: 500 })
    expect(out).toEqual({ outcome: 'free' })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('treats a probe that resolves to "ours" as free too (re-decide from scratch)', async () => {
    const probe = vi.fn().mockResolvedValue('ours')
    const out = await retryCanonicalPort({ probe, now: () => 0, sleep: vi.fn(), timeoutMs: 5000, intervalMs: 500 })
    expect(out).toEqual({ outcome: 'free' })
  })

  it('retries a foreign/inconclusive port and reports free once it releases within the window', async () => {
    let calls = 0
    let clock = 0
    const probe = vi.fn().mockImplementation(async () => {
      calls++
      return calls < 3 ? 'foreign' : 'unreachable'
    })
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      clock += ms
    })
    const out = await retryCanonicalPort({ probe, now: () => clock, sleep, timeoutMs: 5000, intervalMs: 500 })
    expect(out).toEqual({ outcome: 'free' })
    expect(probe).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('gives up as still-occupied once the bounded window elapses, naming the last observed identity', async () => {
    let clock = 0
    const probe = vi.fn().mockResolvedValue('foreign')
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      clock += ms
    })
    const out = await retryCanonicalPort({ probe, now: () => clock, sleep, timeoutMs: 2000, intervalMs: 500 })
    expect(out).toEqual({ outcome: 'still-occupied', identity: 'foreign' })
    // deadline = 2000; ticks at clock 0,500,1000,1500,2000,2500(>2000 stop) — bounded, not infinite
    expect(probe.mock.calls.length).toBeGreaterThan(1)
    expect(probe.mock.calls.length).toBeLessThan(10)
  })

  it('gives up as still-occupied for a persistently inconclusive (timing-out) port', async () => {
    let clock = 0
    const probe = vi.fn().mockResolvedValue('inconclusive')
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      clock += ms
    })
    const out = await retryCanonicalPort({ probe, now: () => clock, sleep, timeoutMs: 1000, intervalMs: 500 })
    expect(out).toEqual({ outcome: 'still-occupied', identity: 'inconclusive' })
  })

  it('a mixed foreign-then-inconclusive tail reports the LAST observed identity, not the first', async () => {
    let clock = 0
    let calls = 0
    const probe = vi.fn().mockImplementation(async () => {
      calls++
      return calls === 1 ? 'foreign' : 'inconclusive'
    })
    const sleep = vi.fn().mockImplementation(async (ms: number) => {
      clock += ms
    })
    const out = await retryCanonicalPort({ probe, now: () => clock, sleep, timeoutMs: 1000, intervalMs: 500 })
    expect(out).toEqual({ outcome: 'still-occupied', identity: 'inconclusive' })
  })
})
