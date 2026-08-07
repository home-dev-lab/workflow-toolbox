// adopt-changelog-span.test.ts — unit lock for the pure changelog-span logic
// (plugin/skills/adopt/scripts/changelog-span.mjs).
//
// Card 1836356654: a stale adopted copy's `adopt --check` report must show what the
// intervening plugin versions actually SHIPPED, sliced from plugin/CHANGELOG.md between
// the copy's installed version and the current one — not the whole changelog (buries the
// delta) and not a bare version bump (says nothing).
//
// The invariant this suite exists to lock, in BOTH directions (measured: plugin/CHANGELOG.md
// has 61 minor versions between 0.68 and 0.144 with NO matching `## [x.y.z]` heading at all —
// slicing a range that falls entirely inside that gap returns zero headings, and rendering
// that plainly reads as "nothing changed" at exactly the moment ~100 versions went past):
//
//   - "no changes recorded in this range" (the range IS inside the recorded span, genuinely
//     empty) must be a DIFFERENT, distinguishable output from
//   - "no record exists for this range" (the FROM version predates every heading the
//     changelog carries at all — the gap case above).
//
// Fixtures are hand-built here, never read off the repo's real CHANGELOG.md: a lock built on
// today's version numbers rots at the next release (rule: "lock the invariant, not an
// enumeration").

import { describe, it, expect } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/skills/adopt/scripts/
import { changelogSpan } from '../../../../plugin/skills/adopt/scripts/changelog-span.mjs'

const FIXTURE = `# Changelog

## [1.5.0] - 2026-03-05

### Added

- Entry E: the fifth thing.

## [1.4.0] - 2026-03-04

### Added

- Entry D: the fourth thing, with
  a second line of detail.

## [1.3.0] - 2026-03-03

### Fixed

- Entry C: the third thing.

## [1.1.0] - 2026-03-01

### Added

- Entry B: the second thing (note: 1.2.0 shipped with NO heading — the gap this fixture models).

## [1.0.0] - 2026-02-28

### Added

- Entry A: the first thing.
`

describe('changelogSpan — recorded range: entries between two versions', () => {
  it('returns every heading strictly after fromVersion, up to and including toVersion', () => {
    const result = changelogSpan(FIXTURE, '1.1.0', '1.5.0')
    expect(result.recorded).toBe(true)
    if (!result.recorded) return
    // newest-first is the useful reading order for "what changed since I last adopted"
    expect(result.entries.map((e: { version: string }) => e.version)).toEqual(['1.5.0', '1.4.0', '1.3.0'])
    expect(result.entries[0]?.version).toBe('1.5.0')
    expect(result.entries.some((e: { body: string }) => e.body.includes('Entry C'))).toBe(true)
    expect(result.entries.some((e: { body: string }) => e.body.includes('a second line of detail'))).toBe(true)
    expect(result.totalCount).toBe(3)
    expect(result.omittedCount).toBe(0)
  })

  it('fromVersion == toVersion yields a recorded, empty span (already current)', () => {
    const result = changelogSpan(FIXTURE, '1.5.0', '1.5.0')
    expect(result.recorded).toBe(true)
    if (!result.recorded) return
    expect(result.entries).toEqual([])
    expect(result.totalCount).toBe(0)
  })

  it('a range whose fromVersion is AT the oldest recorded heading is recorded, even if it lands on a real gap', () => {
    // 1.0.0 (fromVersion) is itself the oldest heading in the fixture — the record-keeping
    // reaches exactly that far back, so this is the "genuinely nothing else happened here"
    // case, not the "we never recorded that far back" case.
    const result = changelogSpan(FIXTURE, '1.0.0', '1.1.0')
    expect(result.recorded).toBe(true)
    if (!result.recorded) return
    expect(result.entries.map((e: { version: string }) => e.version)).toEqual(['1.1.0'])
  })
})

describe('changelogSpan — unrecorded range: fromVersion predates every heading', () => {
  it('reports recorded:false, distinguishably from a genuinely empty recorded span', () => {
    const result = changelogSpan(FIXTURE, '0.9.0', '1.5.0')
    expect(result.recorded).toBe(false)
    if (result.recorded) return
    expect(result.oldestRecordedVersion).toBe('1.0.0')
  })

  it('the two "nothing shown" shapes never carry the same discriminant', () => {
    // The whole point of the invariant: a caller must be able to tell these apart WITHOUT
    // knowing anything about the fixture's own gap (1.2.0) ahead of time.
    const genuinelyEmpty = changelogSpan(FIXTURE, '1.5.0', '1.5.0')
    const neverRecorded = changelogSpan(FIXTURE, '0.1.0', '1.5.0')
    expect(genuinelyEmpty.recorded).toBe(true)
    expect(neverRecorded.recorded).toBe(false)
  })

  it('a changelog with zero parseable headings is unrecorded for any range', () => {
    const result = changelogSpan('# Changelog\n\nnothing here yet.\n', '0.1.0', '1.0.0')
    expect(result.recorded).toBe(false)
  })
})

describe('changelogSpan — truncation of an enormous span stays explicit, never silent', () => {
  it('caps entries and reports the omitted count + version bound, never a silent drop', () => {
    const result = changelogSpan(FIXTURE, '1.0.0', '1.5.0', { maxEntries: 2 })
    expect(result.recorded).toBe(true)
    if (!result.recorded) return
    expect(result.entries).toHaveLength(2)
    // newest-first + capped ⇒ keep the two MOST RECENT, drop the older ones
    expect(result.entries.map((e: { version: string }) => e.version)).toEqual(['1.5.0', '1.4.0'])
    expect(result.totalCount).toBe(4)
    expect(result.omittedCount).toBe(2)
  })

  it('no truncation ⇒ omittedCount is exactly 0, not merely falsy-looking', () => {
    const result = changelogSpan(FIXTURE, '1.4.0', '1.5.0', { maxEntries: 20 })
    expect(result.recorded).toBe(true)
    if (!result.recorded) return
    expect(result.omittedCount).toBe(0)
    expect(result.entries).toHaveLength(1)
  })
})
