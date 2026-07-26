// report-contract-lens.test.ts — TDD red/green demonstration for the
// report-contract lens (card #1827270233300141550).
//
// The card's acceptance gate is NOT "the lens runs" — it is that the lens
// has been SEEN to fail on a deliberately non-scoped report, and to pass a
// correctly-scoped one (the inverse check, so a green run means "compliant",
// not "the lens never complains"). Both fixtures live in
// scripts/test/fixtures/ and are reused by the manual CLI demonstration
// (see report-contract-lens.ts's own header for the invocation).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkReport } from '../report-contract-lens.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url))
const readFixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')

describe('report-contract-lens — the RED demonstration', () => {
  it('flags a deliberately non-scoped report on all 5 requirements', () => {
    const result = checkReport(readFixture('sample-noncompliant.md'))
    const reqsHit = new Set(result.findings.map((f) => f.requirement))
    expect(result.ok).toBe(false)
    expect(reqsHit).toEqual(new Set([1, 2, 3, 4, 5]))
  })

  it('lets a correctly-scoped report pass clean (the inverse check)', () => {
    const result = checkReport(readFixture('sample-compliant.md'))
    expect(result.findings).toEqual([])
    expect(result.ok).toBe(true)
  })
})

describe('report-contract-lens — per-requirement precision (no false positive on the compliant half)', () => {
  it('req 1: flags a single unnamed lane, passes two separately named lanes', () => {
    expect(checkReport('Lane: Claude a tout fait.').findings.some((f) => f.requirement === 1)).toBe(true)
    expect(
      checkReport(
        "Lane d'implémentation : sonnet.\nLane de review : opencode gpt-5.6-terra.",
      ).findings.some((f) => f.requirement === 1),
    ).toBe(false)
  })

  it('req 2: "aucun" alone is flagged; "aucun ... sur N ..., lu/exécuté via X" passes', () => {
    expect(checkReport('Aucun défaut trouvé.').findings.some((f) => f.requirement === 2)).toBe(true)
    expect(
      checkReport(
        'Aucun défaut trouvé sur les 12 tests, exécutés via vitest.',
      ).findings.some((f) => f.requirement === 2),
    ).toBe(false)
  })

  it('req 3: a bare percentage is flagged; a percentage with numerator/denominator passes', () => {
    expect(checkReport('Couverture : 92%.').findings.some((f) => f.requirement === 3)).toBe(true)
    expect(
      checkReport('Couverture : 100% (8 sur 8).').findings.some((f) => f.requirement === 3),
    ).toBe(false)
  })

  it('req 4: a deferred check with no location is flagged; one naming a card passes', () => {
    expect(checkReport('La review sera faite plus tard.').findings.some((f) => f.requirement === 4)).toBe(
      true,
    )
    expect(
      checkReport(
        'La review est reportée — point ouvert sur la carte #123, avant clôture.',
      ).findings.some((f) => f.requirement === 4),
    ).toBe(false)
  })

  it('req 5: a bare green claim is flagged; one stating the failure criterion passes', () => {
    expect(
      checkReport('Les gates sont passés, tout est vert.').findings.some((f) => f.requirement === 5),
    ).toBe(true)
    expect(
      checkReport(
        'Le gate est vert ; il aurait échoué si le fixture bad avait été raté — non observé ici.',
      ).findings.some((f) => f.requirement === 5),
    ).toBe(false)
  })
})

describe('report-contract-lens — adversarial cases found by cross-family review (opencode/gpt-5.6-terra, direct CLI call, card #1827270233300141550 evidence 09)', () => {
  it('req 1: a lane label with a PLACEHOLDER value ("à renseigner") is still flagged — the label alone is not naming', () => {
    expect(
      checkReport("Lane d'implémentation / lane de review : à renseigner.").findings.some(
        (f) => f.requirement === 1,
      ),
    ).toBe(true)
  })

  it('req 2: an unrelated fraction elsewhere in the same sentence must NOT excuse a scope-less absence claim', () => {
    expect(
      checkReport('No issues found, but the 1/1 smoke test passed.').findings.some(
        (f) => f.requirement === 2,
      ),
    ).toBe(true)
  })

  it('req 2: "in the N" (English scope form) must be recognized, not just "sur N"', () => {
    expect(
      checkReport(
        'No issues found in the 12 files, checked by the test script.',
      ).findings.some((f) => f.requirement === 2),
    ).toBe(false)
  })

  it('req 3: an unrelated fraction elsewhere in the same sentence must NOT excuse a bare percentage', () => {
    expect(
      checkReport('Coverage is 92%, and the 1/1 smoke test passed.').findings.some(
        (f) => f.requirement === 3,
      ),
    ).toBe(true)
  })

  it('req 3: "N of M" (English numerator/denominator form) must be recognized, not just "N/M" or "N sur M"', () => {
    expect(
      checkReport('Coverage is 92% (46 of 50).').findings.some((f) => f.requirement === 3),
    ).toBe(false)
  })

  it('req 2: scope AND instrument are each reported independently — a sentence missing both surfaces two things, not one masked by the other', () => {
    const result = checkReport('Aucun défaut trouvé.')
    // the mechanical scope finding always fires when scope is absent...
    expect(result.findings.some((f) => f.requirement === 2)).toBe(true)
    // ...and this must not be an accident of the instrument warning being
    // silently skipped by an `else if` — re-run on a scope-present,
    // instrument-absent sentence to confirm the warning path still fires
    // independently of the finding path.
    const partial = checkReport('Aucun défaut trouvé sur les 12 tests.')
    expect(partial.findings.some((f) => f.requirement === 2)).toBe(false)
    expect(partial.warnings.some((w) => w.requirement === 2)).toBe(true)
  })
})

describe('report-contract-lens — honest coverage self-report', () => {
  it('exposes which requirements are mechanical vs heuristic, for the pilot report to cite', () => {
    const { coverage } = checkReport('')
    expect(coverage[1]).toBe('mechanical')
    expect(coverage[2]).toBe('mechanical+heuristic')
    expect(coverage[3]).toBe('mechanical+heuristic')
    expect(coverage[4]).toBe('heuristic')
    expect(coverage[5]).toBe('heuristic')
  })
})
