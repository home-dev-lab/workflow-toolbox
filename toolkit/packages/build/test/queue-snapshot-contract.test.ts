import { describe, expect, it } from 'vitest'

// @ts-expect-error TS7016 -- shipped plain-JS plugin contract module.
import { parseQueueSnapshot } from '../../../../plugin/bin/lib/queue-snapshot-contract.mjs'

const NOW = 1_700_000_000_000
const STALE_AFTER_MS = 120 * 60_000

describe('queue snapshot contract', () => {
  it('classifies a complete v2 snapshot as known', () => {
    expect(parseQueueSnapshot(JSON.stringify({
      at: NOW,
      startable: 2,
      awaitingOwner: 3,
      unclassified: 1,
      next: 'CARD-1 implement the contract',
      source: 'example tracker',
    }), NOW, STALE_AFTER_MS)).toEqual({
      kind: 'known',
      at: NOW,
      startable: 2,
      awaitingOwner: 3,
      unclassified: 1,
      next: 'CARD-1 implement the contract',
    })
  })

  it('keeps an old open-only snapshot legible rather than treating it as empty', () => {
    expect(parseQueueSnapshot(JSON.stringify({ at: NOW, open: 4, next: 'CARD-2 legacy item' }), NOW, STALE_AFTER_MS)).toEqual({
      kind: 'legacy',
      at: NOW,
      open: 4,
      next: 'CARD-2 legacy item',
      reason: 'legacy snapshot: no startable field — treated as 4 open, classification unknown',
    })
  })

  it.each([
    ['missing', null],
    ['malformed JSON', '{not json'],
    ['negative count', JSON.stringify({ at: NOW, startable: -1, awaitingOwner: 0, unclassified: 0, next: '' })],
    ['fractional count', JSON.stringify({ at: NOW, startable: 1.5, awaitingOwner: 0, unclassified: 0, next: '' })],
    ['stale', JSON.stringify({ at: NOW - STALE_AFTER_MS - 1, startable: 0, awaitingOwner: 2, unclassified: 0, next: '' })],
  ])('returns unknown for %s snapshots', (_label, input) => {
    expect(parseQueueSnapshot(input, NOW, STALE_AFTER_MS).kind).toBe('unknown')
  })
})
