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
// ⚠ A SECOND, sharper shape of the same gap: the gap is not only at the file's boundary,
// it is INTERIOR too. A first version of this module only guarded the boundary (fromVersion
// vs the file's oldest heading) and, measured against the real changelog, presented a
// confident 17-entry span for a query that actually spanned ~75 versions of undocumented
// movement — a PARTIAL span dressed as a complete one, worse than the empty-span case
// because it doesn't even look suspicious. `missingVersionCount` below locks that a span
// reports its OWN coverage, computed only from the two requested versions.
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
    // 1.1.0 → 1.5.0 spans minors 2,3,4,5 (four expected slots); only 3,4,5 have headings —
    // the fixture's OWN documented gap (1.2.0, deliberately absent) must surface here as a
    // real, non-zero missing count, not silently pass as a "complete" span.
    expect(result.missingVersionCount).toBe(1)
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

describe('changelogSpan — coverage: a recorded span states whether it is COMPLETE', () => {
  it('no interior gap in range ⇒ missingVersionCount is exactly 0', () => {
    // 1.3.0 → 1.4.0: one expected slot, one heading present. No gap in THIS sub-range
    // (the fixture's gap, 1.2.0, sits entirely outside it).
    const result = changelogSpan(FIXTURE, '1.3.0', '1.4.0')
    expect(result.recorded).toBe(true)
    if (!result.recorded) return
    expect(result.missingVersionCount).toBe(0)
  })

  it('fromVersion AT the oldest heading, landing on a real interior gap further up, still counts it', () => {
    // 1.0.0 → 1.5.0 covers the WHOLE fixture, gap (1.2.0) included: minors 1..5 expected,
    // only {1,3,4,5} present via headings after 1.0 (1.1,1.3,1.4,1.5) ⇒ exactly 1 missing.
    const result = changelogSpan(FIXTURE, '1.0.0', '1.5.0')
    expect(result.recorded).toBe(true)
    if (!result.recorded) return
    expect(result.missingVersionCount).toBe(1)
  })

  it('a major-version mismatch between fromVersion and toVersion reports missingVersionCount as null (cannot determine), never a guess', () => {
    const crossMajor = `# Changelog\n\n## [2.0.0] - 2026-04-01\n\n- Entry.\n\n## [1.0.0] - 2026-02-28\n\n- Entry.\n`
    const result = changelogSpan(crossMajor, '1.0.0', '2.0.0')
    expect(result.recorded).toBe(true)
    if (!result.recorded) return
    expect(result.missingVersionCount).toBeNull()
  })

  // Replicates the exact class of defect found by the arbiter against the real changelog:
  // a query well ABOVE the file's oldest heading (so the boundary guard alone reports
  // recorded:true) can still span a large INTERIOR gap the boundary check cannot see.
  // Built at a smaller, fixture-controlled scale so the lock does not depend on the real
  // changelog's current shape.
  it('an interior gap FAR from the file boundary is still caught (the defect this section exists to close)', () => {
    const lines: string[] = ['# Changelog', '']
    // Headings at every minor from 40 to 50 (11 headings) — the "old, well-documented" era.
    for (let m = 50; m >= 40; m--) lines.push(`## [1.${m}.0] - 2026-01-01`, '', `- Entry ${m}.`, '')
    // A real interior gap: minors 51..99 carry NO heading at all (49 undocumented minors).
    // Headings resume at 100 and run to 110 (11 headings) — the "recent, gate-enforced" era.
    for (let m = 110; m >= 100; m--) lines.push(`## [1.${m}.0] - 2026-06-01`, '', `- Entry ${m}.`, '')
    const bigFixture = lines.join('\n') + '\n'

    // A query starting well ABOVE the oldest heading (1.40.0) — the boundary guard alone
    // reports recorded:true and would, pre-fix, present this as a complete span.
    const result = changelogSpan(bigFixture, '1.45.0', '1.110.0', { maxEntries: 100 })
    expect(result.recorded).toBe(true)
    if (!result.recorded) return
    // Present: minors 46..50 (5, the tail of the old era, still > 45) plus 100..110 (11) = 16
    // distinct. Expected: 110-45 = 65. Missing: 65-16 = 49 — the undocumented 51..99 band.
    expect(result.totalCount).toBe(16)
    expect(result.missingVersionCount).toBe(49)
  })
})
