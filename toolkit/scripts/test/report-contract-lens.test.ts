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

// Card #1827338294346647054 — "Étendre la lentille au COMPTE NU": req 3's
// general case (a bare count with an ambiguous unit noun, no percentage
// involved — "29 tours", "100 fichiers" — the actual shape of our five
// documented burns, none of which was a percentage). Calibrated against the
// 5 documented burns + the real wave-20260725-r2 report corpus (see the
// pilot's report for the measured recall/precision at each design point);
// the false-positive rate on free-form prose is too high to gate exit code
// on, so this is ADVISORY ONLY — it must NEVER appear in `findings`, only in
// `warnings`, and `ok`/exit code must stay unaffected by it.
describe('report-contract-lens — bare count, general case (ADVISORY ONLY, never blocking)', () => {
  it('a decisive bare count with no scope AND no named instrument produces a warning, never a finding', () => {
    // NOTE: req 1 also fires on any bare sentence lacking lane labels — that
    // is unrelated to this check and expected on a minimal fixture (see the
    // file's other per-requirement tests, which likewise scope assertions to
    // one requirement rather than the whole-report `ok`).
    const result = checkReport(
      '100 fichiers ont été modifiés en 25 minutes, ce qui montre qu’un bundle part dans le commit.',
    )
    expect(result.findings.some((f) => f.requirement === 3)).toBe(false)
    expect(result.warnings.some((w) => w.requirement === 3)).toBe(true)
  })

  it('the same bare count grounded by a SCOPE marker (sur N / N sur M) produces no warning', () => {
    const result = checkReport(
      '168 claims sur 493 votes individuels ont été agrégés, ce qui confirme le rendement réel de l’audit.',
    )
    expect(result.warnings.some((w) => w.requirement === 3)).toBe(false)
  })

  it('the same bare count grounded by a NAMED INSTRUMENT (no fraction, but a re-checkable source) produces no warning', () => {
    const result = checkReport(
      '146 fichiers, 3483 tests passés (pnpm test, exit 0).',
    )
    expect(result.warnings.some((w) => w.requirement === 3)).toBe(false)
  })

  it('the "lines mistaken for turns" burn shape is caught', () => {
    const result = checkReport("29 tours sans coupure, donc maxTurns n'est pas appliqué.")
    expect(result.warnings.some((w) => w.requirement === 3)).toBe(true)
  })

  it('the "static occurrences mistaken for executed tests" burn shape is caught', () => {
    const result = checkReport('Le fichier ne compte que 7 tests, ce qui confirme que le drift-lock est surévalué.')
    expect(result.warnings.some((w) => w.requirement === 3)).toBe(true)
  })

  it('a markdown header line is excluded (a count in a title is not a decisive claim)', () => {
    const result = checkReport('# Card #123 — fix round on the review’s 3 test-lock findings\n\nBody text.')
    expect(result.warnings.some((w) => w.requirement === 3)).toBe(false)
  })

  it('a percentage sentence is not double-reported by the bare-count check (already covered mechanically above)', () => {
    const result = checkReport('Couverture : 92%.')
    // req 3 already fires a mechanical FINDING for this — the advisory
    // bare-count warning must not ALSO fire on the same sentence.
    expect(result.findings.some((f) => f.requirement === 3)).toBe(true)
    expect(result.warnings.filter((w) => w.requirement === 3)).toHaveLength(0)
  })

  it('a word outside the closed burn-noun vocabulary is not flagged (documented limitation, not a bug)', () => {
    const result = checkReport('Le rapport cite 42 anomalies, ce qui confirme le diagnostic.')
    expect(result.warnings.some((w) => w.requirement === 3)).toBe(false)
  })
})

// Adversarial cases found by cross-family review (opencode/gpt-5.6-terra, direct
// CLI call, card #1827338294346647054 evidence 10) — re-verified against the
// reviewer's OWN repro strings, not just this file's author's assertions (same
// discipline as the parent card's evidence 12).
describe('report-contract-lens — bare count, adversarial cases found by cross-family review', () => {
  it('[Medium, fixed] an intervening modifier ("changed files") no longer defeats the noun match', () => {
    expect(
      checkReport('100 changed files were included in the commit.').warnings.some(
        (w) => w.requirement === 3,
      ),
    ).toBe(true)
  })

  it('[Medium, fixed] "N out of M" (English scope form) is now recognized, not just "of the N"', () => {
    expect(
      checkReport('100 files out of 120 changed files were reviewed.').warnings.some(
        (w) => w.requirement === 3,
      ),
    ).toBe(false)
  })

  it('[Medium, fixed] "git log" is recognized as a named tool, not just show/diff/stat', () => {
    expect(
      checkReport('100 commits were reviewed with git log --oneline.').warnings.some(
        (w) => w.requirement === 3,
      ),
    ).toBe(false)
  })

  it('[Medium, fixed] a multi-digit exit code ("exit 10") is recognized, not just a single digit', () => {
    expect(
      checkReport('100 tests passed, exit 10 observed on retry.').warnings.some(
        (w) => w.requirement === 3,
      ),
    ).toBe(false)
  })

  it('[Low, fixed] a header line immediately followed by prose on the SAME physical line is still excluded (markdown headers are whole-line)', () => {
    expect(
      checkReport('# Release. 100 tests').warnings.some((w) => w.requirement === 3),
    ).toBe(false)
  })

  it('[Low, fixed] the overly generic "runner" tool marker no longer masks a genuinely ungrounded count', () => {
    expect(
      checkReport('100 tests exercise the runner lifecycle.').warnings.some(
        (w) => w.requirement === 3,
      ),
    ).toBe(true)
  })

  it('[Medium, DECLINED — documented, not fixed] a semicolon splits what a human reads as one sentence; grounding after the ";" is not seen — sentencesOf() is a SHARED utility (req 1/2/4/5 also depend on its exact boundaries), so its splitting behavior is not changed by this card; the header comment is corrected instead of the code', () => {
    const result = checkReport('100 tests passed; pnpm test exited 0.')
    // Documented as a known false-positive class, not silently absent: this
    // assertion pins the CURRENT (imperfect) behavior so a future change to
    // sentencesOf() is a deliberate, visible decision, not an accident.
    expect(result.warnings.some((w) => w.requirement === 3)).toBe(true)
  })
})
