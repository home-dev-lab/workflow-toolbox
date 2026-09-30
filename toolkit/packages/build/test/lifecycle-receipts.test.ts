import { afterEach, describe, expect, it, vi } from 'vitest'

// @ts-expect-error ESM runtime module
import { waitForLaneReceipt } from '../../../../plugin/bin/lib/lifecycle-receipts.mjs'

afterEach(() => { vi.restoreAllMocks() })

describe('waitForLaneReceipt', () => {
  // readAttestation reports the log's terminal EXIT= value as a string.
  const receipt = { exit: '0' }
  const reads = (content: string) => ({
    readAttestation: () => receipt,
    readRegularFile: () => content,
  })

  it('returns a receipt already on disk even when the deadline passed before the first read', async () => {
    // The clock jumps past the deadline between arming it and the first read, as it does when a
    // loaded host deschedules the process. A lane that already finished still counts.
    let calls = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (calls++ === 0 ? 1_000 : 100_000))
    const entry = await waitForLaneReceipt({ log: 'lane.log', nonce: 'n1', timeoutMs: 60_000, pollMs: 1, ...reads('LANE_NONCE=n1\nEXIT=0\n') })
    expect(entry).toBe(receipt)
  })

  it('still times out when the log never carries the launch nonce', async () => {
    let clock = 0
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 30_000))
    const entry = await waitForLaneReceipt({ log: 'lane.log', nonce: 'n1', timeoutMs: 60_000, pollMs: 1, ...reads('LANE_NONCE=other\nEXIT=0\n') })
    expect(entry).toBeNull()
  })
})
