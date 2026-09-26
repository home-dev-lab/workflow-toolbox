import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { classifyQuotaDrop, resetsAtToMs } from '../../../../plugin/bin/lib/quota-drop.mjs'

// The classifier the quota watcher applies to a percentage that FELL between two polls.
// Card 1860461290531588066: a 42 % → 32 % drop at 18:41 was printed as RESET while the
// previously reported reset time had not come — a window cannot reset before its own reset time.

const NOW = Date.parse('2026-09-09T17:41:00Z')
const NOW_LABEL = new Date(NOW).toISOString()

describe('resetsAtToMs', () => {
  it('reads ISO strings, epoch seconds and epoch milliseconds', () => {
    expect(resetsAtToMs('2026-09-14T19:00:00Z')).toBe(Date.parse('2026-09-14T19:00:00Z'))
    expect(resetsAtToMs(1789412400)).toBe(1789412400 * 1000)
    expect(resetsAtToMs(1789412400000)).toBe(1789412400000)
    expect(resetsAtToMs('1789412400')).toBe(1789412400 * 1000)
  })
  it('returns null for nothing and for garbage, never a fabricated time', () => {
    expect(resetsAtToMs(null)).toBeNull()
    expect(resetsAtToMs(undefined)).toBeNull()
    expect(resetsAtToMs('')).toBeNull()
    expect(resetsAtToMs('soon')).toBeNull()
    expect(resetsAtToMs({})).toBeNull()
  })
})

describe('classifyQuotaDrop', () => {
  it('a drop BEFORE the previously reported reset time is reset-unverified, and names both times', () => {
    const verdict = classifyQuotaDrop({ nowMs: NOW, previousResetsAt: '2026-09-14T19:00:00Z', currentResetsAt: '2026-09-16T07:27:00Z', previousPct: 42, currentPct: 32 })
    expect(verdict.kind).toBe('unverified')
    expect(verdict.detail).toContain('32% (was 42%)')
    expect(verdict.detail).toContain('reset unverified')
    expect(verdict.detail).toContain('manual reset')
    expect(verdict.detail).toContain('2026-09-14T19:00:00.000Z')
    expect(verdict.detail).toContain('2026-09-16T07:27:00.000Z')
    expect(verdict.detail).toContain('capacity not asserted')
    expect(verdict.detail).not.toContain('capacity available')
  })
  it('the printed "now" is always nowMs, never the new window\'s own reset time', () => {
    // Card 1872384706947844062: `(now …)` was built from currentResetsAt (the new window's own
    // reset time), not nowMs — a real event printed "now 2026-09-26T09:30:00.000Z" while the
    // actual clock read 04:32Z. nowMs and currentResetsAt are deliberately far apart here so a
    // regression (printing currentResetsAt's label) cannot coincide with the correct one.
    const verdict = classifyQuotaDrop({ nowMs: NOW, previousResetsAt: '2026-09-14T19:00:00Z', currentResetsAt: '2026-09-16T07:27:00Z', previousPct: 42, currentPct: 32 })
    expect(verdict.detail).toContain(`(now ${NOW_LABEL})`)
    expect(verdict.detail).not.toContain('(now 2026-09-16T07:27:00.000Z)')
  })
  it('a drop AT or AFTER the previous reset time is a reset ONLY with identity continuity', () => {
    const at = classifyQuotaDrop({ nowMs: NOW, previousResetsAt: NOW, currentResetsAt: NOW + 7 * 86400000, previousPct: 90, currentPct: 3, continuity: 'account fingerprint unchanged' })
    const after = classifyQuotaDrop({ nowMs: NOW + 60000, previousResetsAt: NOW, currentResetsAt: NOW + 7 * 86400000, previousPct: 90, currentPct: 3, continuity: 'account fingerprint unchanged' })
    expect(at.kind).toBe('reset')
    expect(after.kind).toBe('reset')
    expect(after.detail).toContain('account fingerprint unchanged')
    expect(after.detail).toContain('new window, capacity available')
    expect(after.detail).toContain(`(now ${new Date(NOW + 60000).toISOString()})`)
    expect(after.detail).not.toContain(new Date(NOW + 7 * 86400000).toISOString())
  })
  it('a drop past the previous reset time WITHOUT continuity stays unverified — an account switch drops the same way', () => {
    const verdict = classifyQuotaDrop({ nowMs: NOW + 60000, previousResetsAt: NOW, currentResetsAt: NOW + 7 * 86400000, previousPct: 90, currentPct: 3 })
    expect(verdict.kind).toBe('unverified')
    expect(verdict.detail).toContain('reset likely but unverified')
    expect(verdict.detail).toContain('source continuity not verified on this route')
    expect(verdict.detail).not.toContain('capacity available')
    expect(verdict.detail).toContain(`(now ${new Date(NOW + 60000).toISOString()})`)
  })
  it('a drop with no previous reset time stays undetermined', () => {
    const verdict = classifyQuotaDrop({ nowMs: NOW, previousResetsAt: null, currentResetsAt: '2026-09-16T07:27:00Z', previousPct: 42, currentPct: 32 })
    expect(verdict.kind).toBe('undetermined')
    expect(verdict.detail).toContain('cause undetermined')
    expect(verdict.detail).not.toContain('capacity available')
  })
  it('a current reset time that is missing does not turn a premature drop into a reset', () => {
    const verdict = classifyQuotaDrop({ nowMs: NOW, previousResetsAt: '2026-09-14T19:00:00Z', currentResetsAt: null, previousPct: 42, currentPct: 32 })
    expect(verdict.kind).toBe('unverified')
    expect(verdict.detail).toContain('next reported reset none')
    expect(verdict.detail).toContain(`(now ${NOW_LABEL})`)
  })
})
