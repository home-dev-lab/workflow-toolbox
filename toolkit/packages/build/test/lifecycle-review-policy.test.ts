import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { adaptiveRoundDecision, reviewConvergenceDecision, verdictFromReport } from '../../../../plugin/bin/lib/lifecycle-review-policy.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { independentBrief } from '../../../../plugin/bin/lib/lifecycle-brief.mjs'

describe('lifecycle review stop policy', () => {
  it('blocks anchored CRITICAL, HIGH, and MEDIUM review findings but routes LOW', () => {
    const report = `VERDICT: changes-requested
FINDINGS:
- [CRITICAL][anchor: DoD 1][location: src/a.ts:10] critical defect
- [HIGH][anchor: plan task T2][location: src/b.ts:20] high defect
- [MEDIUM][anchor: DoD 3][location: src/c.ts:30] medium defect
- [LOW][anchor: DoD 4][location: src/d.ts:40] low defect
`
    const verdict = verdictFromReport('review', report, { validAnchors: ['DoD 1', 'plan task T2', 'DoD 3', 'DoD 4'] })
    expect(verdict.findingDetails.map((finding: { severity: string; blocks: boolean }) => [finding.severity, finding.blocks])).toEqual([
      ['critical', true], ['high', true], ['medium', true], ['low', false],
    ])
  })

  it('routes an unanchored HIGH finding from the archived review-2 shape only in legacy mode', () => {
    const report = `VERDICT: changes-requested
FINDINGS:
- [HIGH][Confirmed][A/E] \`plugin/bin/lib/critic-blockage.mjs:159\` invokes recovery before reconciliation.
`
    const verdict = verdictFromReport('review', report, { legacy: true })
    expect(verdict.findingDetails[0]).toMatchObject({ severity: 'high', anchor: null, blocks: false, location: 'plugin/bin/lib/critic-blockage.mjs:159' })
  })

  it('refuses structured MEDIUM+ and blocking critic findings with no anchor field', () => {
    const review = verdictFromReport('review', `VERDICT: changes-requested
FINDINGS:
- [HIGH][location: src/a.ts:1] first defect
- [LOW][location: src/b.ts:2] typo
- [MEDIUM][location: src/c.ts:3] third defect
`)
    const critic = verdictFromReport('critic', `VERDICT: changes-requested
FINDINGS:
- [blocking][location: plan.md:4] missing task
`)
    const refutation = verdictFromReport('refutation', `VERDICT: changes-requested
FINDINGS:
- [MEDIUM][location: src/d.ts:4] surviving defect
`)
    expect(review).toEqual({ problem: 'findings 1, 3 have no anchor field' })
    expect(critic).toEqual({ problem: 'finding 1 has no anchor field' })
    expect(refutation).toEqual({ problem: 'finding 1 has no anchor field' })
  })

  it('allows LOW and non-blocking critic findings to omit an anchor', () => {
    const review = verdictFromReport('review', `VERDICT: changes-requested
FINDINGS:
- [LOW][location: src/a.ts:1] typo
`)
    const critic = verdictFromReport('critic', `VERDICT: changes-requested
FINDINGS:
- [non-blocking][location: plan.md:4] wording
`)
    expect(review.findingDetails[0]).toMatchObject({ blocks: false, routeReason: 'LOW severity never blocks' })
    expect(critic.findingDetails[0]).toMatchObject({ blocks: false, routeReason: 'critic marked non-blocking' })
  })

  it('accepts the critic tag with or without whitespace after it', () => {
    const compact = verdictFromReport('critic', `VERDICT: changes-requested
FINDINGS:
- [non-blocking][anchor: DoD 1][location: plan.md:10] wording only
`, { validAnchors: ['DoD 1'] })
    const spaced = verdictFromReport('critic', `VERDICT: changes-requested
FINDINGS:
- [non-blocking] [anchor: DoD 1][location: plan.md:10] wording only
`, { validAnchors: ['DoD 1'] })
    expect(compact.findingDetails[0]).toMatchObject({ severity: 'non-blocking', blocks: false })
    expect(spaced.findingDetails[0]).toMatchObject({ severity: 'non-blocking', blocks: false })
  })

  it.each([
    'LOW: typo',
    '**[LOW]** typo',
    '(low) typo',
    'untagged typo',
  ])('never blocks legacy LOW or unanchored shape %s', (finding) => {
    const verdict = verdictFromReport('review', `VERDICT: changes-requested\nFINDINGS:\n- ${finding}\n`, { legacy: true, validAnchors: ['DoD 1'] })
    expect(verdict.findingDetails[0].blocks).toBe(false)
  })

  it.each([
    '[anchor: none]',
    '[anchor: n/a]',
    '[anchor: ]',
    '[anchor: DoD 99]',
  ])('does not accept a missing or nonexistent anchor %s', (anchor) => {
    const verdict = verdictFromReport('review', `VERDICT: changes-requested\nFINDINGS:\n- [HIGH]${anchor}[location: src/a.ts:1] defect\n`, { validAnchors: ['DoD 1', 'plan task T2'] })
    expect(verdict.findingDetails[0]).toMatchObject({ blocks: false })
  })

  it.each([
    ['[anchor: none]', 'explicit anchor none'],
    ['[anchor: DoD 99]', 'explicit anchor DoD 99 does not resolve'],
  ])('routes an explicitly unresolvable MEDIUM+ anchor with its reason: %s', (anchor, routeReason) => {
    const verdict = verdictFromReport('review', `VERDICT: changes-requested\nFINDINGS:\n- [MEDIUM]${anchor}[location: src/a.ts:1] defect\n`, { validAnchors: ['DoD 1'] })
    expect(verdict.findingDetails[0]).toMatchObject({ blocks: false, routeReason })
  })

  it('routes a plan-task finding located only in the previous fix addition', () => {
    const patch = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -8,2 +8,3 @@
 existing
+added by fix
 existing
`
    const ownCode = verdictFromReport('review', `VERDICT: changes-requested
FINDINGS:
- [HIGH][anchor: plan task T2][location: src/a.ts:9] fix-created defect
`, { validAnchors: ['plan task T2'], previousFixPatch: patch })
    const cardCriterion = verdictFromReport('review', `VERDICT: changes-requested
FINDINGS:
- [HIGH][anchor: DoD 1][location: src/a.ts:9] card defect
`, { validAnchors: ['DoD 1'], previousFixPatch: patch })
    expect(ownCode.findingDetails[0]).toMatchObject({ blocks: false, routeReason: 'located only in previous fix code and anchored to no card criterion' })
    expect(cardCriterion.findingDetails[0]).toMatchObject({ blocks: true })
  })

  it('never infers an anchor from finding prose', () => {
    const report = `VERDICT: changes-requested
FINDINGS:
- [HIGH][anchor: none][location: src/a.ts:1] Not covered by any DoD criterion, T2, gate, lint, or validation.
`
    const verdict = verdictFromReport('review', report, { validAnchors: ['DoD 1', 'plan task T2'] })
    expect(verdict.findingDetails[0]).toMatchObject({ anchor: null, blocks: false })
  })

  it('refuses a structured finding whose severity field cannot be parsed', () => {
    const verdict = verdictFromReport('review', `VERDICT: changes-requested
FINDINGS:
- [urgent][anchor: DoD 1][location: src/a.ts:1] defect
`, { validAnchors: ['DoD 1'] })
    expect(verdict).toEqual({ problem: 'finding 1 has no recognized severity in its severity field' })
  })

  it('refuses clear with a blocking finding but retains LOW findings under clear', () => {
    const blocking = verdictFromReport('review', `VERDICT: clear
FINDINGS:
- [HIGH][anchor: DoD 1][location: src/a.ts:1] defect
`, { validAnchors: ['DoD 1'] })
    const low = verdictFromReport('review', `VERDICT: clear
FINDINGS:
- [LOW][anchor: DoD 1][location: src/a.ts:1] typo
`, { validAnchors: ['DoD 1'] })
    expect(blocking).toEqual({ problem: 'clear verdict carries 1 blocking finding' })
    expect(low.findingDetails[0]).toMatchObject({ severity: 'low', blocks: false })
  })

  it('keeps the archived terminal-path critic defect blocking because it cites plan task T2', () => {
    const report = `VERDICT: changes-requested
FINDINGS:
- [blocking] Existing post-bound terminal paths overwrite the diagnosed critic partial. T2 exercises successful report completion only (toolkit/packages/build/test/pilot-runner.test.ts:722-755).
`
    const verdict = verdictFromReport('critic', report.replace('[blocking]', '[blocking][anchor: plan task T2]'), { validAnchors: ['plan task T2'] })
    expect(verdict.findingDetails[0]).toMatchObject({ anchor: 'plan task T2', blocks: true })
  })

  it('counts an explicit extension as recurrence without exact finding text', () => {
    const rounds = [
      { findings: ['inventory misses final files'], blockingFindings: ['inventory misses final files'], findingDetails: [{ blocks: true, extendsPrior: null }] },
      { findings: ['regenerate manifest after publication'], blockingFindings: ['regenerate manifest after publication'], findingDetails: [{ blocks: true, extendsPrior: 1 }] },
      { findings: ['include retention file too'], blockingFindings: ['include retention file too'], findingDetails: [{ blocks: true, extendsPrior: 1 }] },
    ]
    expect(adaptiveRoundDecision(rounds, 3, 6, false)).toEqual({ continue: false, plateauUsed: false })
  })

  it('uses only the exact extension declaration as recurrence under review bounds', () => {
    const loose = [
      { findings: ['first'], blockingFindings: ['first'], findingDetails: [{ blocks: true, extendsPrior: null }] },
      { findings: ['unlike the round-1 finding'], blockingFindings: ['unlike the round-1 finding'], findingDetails: [{ blocks: true, extendsPrior: null }] },
    ]
    const explicit = [
      loose[0],
      { findings: ['extends prior finding 1: narrower evidence'], blockingFindings: ['extends prior finding 1: narrower evidence'], findingDetails: [{ blocks: true, extendsPrior: 1 }] },
    ]
    expect(adaptiveRoundDecision(loose, 1, 3, false)).toEqual({ continue: true, plateauUsed: true })
    expect(adaptiveRoundDecision(explicit, 1, 3, false)).toEqual({ continue: false, plateauUsed: false })
  })

  it('identifies a recurring review finding by anchor plus normalized claim', () => {
    const rounds = [
      { blockingFindings: ['Original text'], findingDetails: [{ blocks: true, anchor: 'DoD 1', text: 'Original text', extendsPrior: null }] },
      { blockingFindings: ['  original   TEXT '], findingDetails: [{ blocks: true, anchor: 'dod criterion #1', text: '  original   TEXT ', extendsPrior: null }] },
    ]
    expect(reviewConvergenceDecision(rounds)).toEqual({ continue: false, signal: 'same finding returned: DoD 1 — original TEXT' })
    rounds[1]!.findingDetails[0]!.anchor = 'DoD 2'
    expect(reviewConvergenceDecision(rounds)).toEqual({ continue: true, signal: null })
  })

  it('stops review after two consecutive rounds without a blocking-count drop, with no fixed ceiling', () => {
    const round = (prefix: string, count: number) => ({
      blockingFindings: Array.from({ length: count }, (_, index) => `${prefix}-${index}`),
      findingDetails: Array.from({ length: count }, (_, index) => ({ blocks: true, anchor: `DoD ${index + 1}`, text: `${prefix}-${index}`, extendsPrior: null })),
    })
    expect(reviewConvergenceDecision([round('a', 3), round('b', 3)])).toEqual({ continue: true, signal: null })
    expect(reviewConvergenceDecision([round('a', 3), round('b', 3), round('c', 3)])).toEqual({ continue: false, signal: 'blocking count did not drop for two consecutive rounds: 3 -> 3 -> 3' })
    expect(reviewConvergenceDecision([round('a', 9), round('b', 8), round('c', 7), round('d', 6), round('e', 5), round('f', 4), round('g', 3)])).toEqual({ continue: true, signal: null })
  })

  it('treats an explicit prior-finding extension as immediate review non-convergence', () => {
    const rounds = [
      { blockingFindings: ['first'], findingDetails: [{ blocks: true, anchor: 'DoD 1', text: 'first', extendsPrior: null }] },
      { blockingFindings: ['narrower'], findingDetails: [{ blocks: true, anchor: 'DoD 1', text: 'narrower', extendsPrior: 1 }] },
    ]
    expect(reviewConvergenceDecision(rounds)).toEqual({ continue: false, signal: 'finding extends prior finding 1' })
  })

  it('does not parse loose round prose as an extension declaration', () => {
    const verdict = verdictFromReport('review', `VERDICT: changes-requested
FINDINGS:
- [HIGH][anchor: DoD 1][location: src/a.ts:1] Unlike the round-1 finding, this has new evidence.
`, { validAnchors: ['DoD 1'] })
    expect(verdict.findingDetails[0].extendsPrior).toBeNull()
  })

  it('asks every independent lane for severity and an anchor and gives later reviews prior findings', () => {
    const brief = independentBrief({
      phase: 'review', context: 'review this', artifacts: ['fix.diff'], reportPath: 'report.md', constructionBase: 'previous-reviewed-tree',
      priorRounds: [{ round: 1, findings: ['first finding'] }],
    })
    expect(brief).toContain('[CRITICAL|HIGH|MEDIUM|LOW][anchor: DoD <n>|plan task <id>][location: <path:line>]')
    expect(brief).toContain('Omitting it makes the whole report invalid')
    expect(brief).toContain('Use `[anchor: none]` explicitly when no anchor resolves')
    expect(brief).toContain('### Round 1\n- Prior finding 1: first finding')
    expect(brief).toContain('fix since previously reviewed tree')
  })

  it('requires a per-section attack account when a critic has no findings', () => {
    const brief = independentBrief({ phase: 'critic', context: 'criticise', artifacts: ['plan.md'], reportPath: 'report.md' })
    expect(brief).toContain('MUST find issues')
    expect(brief).toContain('anchor field is mandatory for every `[blocking]` finding')
    expect(brief).toContain('## No-finding attack account')
    expect(brief).toContain('failed critic round and is re-run once')
  })
})
