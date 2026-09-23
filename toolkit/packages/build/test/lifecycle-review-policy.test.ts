import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { createLifecycleStateMachine } from '../../../../plugin/bin/lib/lifecycle-state-machine.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { independentBrief } from '../../../../plugin/bin/lib/lifecycle-brief.mjs'

const { adaptiveRoundDecision, verdictFromReport } = createLifecycleStateMachine.reviewPolicy

describe('lifecycle review stop policy', () => {
  it('blocks anchored CRITICAL, HIGH, and MEDIUM review findings but routes LOW', () => {
    const report = `VERDICT: changes-requested
FINDINGS:
- [CRITICAL][anchor: DoD 1][location: src/a.ts:10] critical defect
- [HIGH][anchor: plan task T2][location: src/b.ts:20] high defect
- [MEDIUM][anchor: DoD 3][location: src/c.ts:30] medium defect
- [LOW][anchor: DoD 4][location: src/d.ts:40] low defect
`
    const verdict = verdictFromReport('review', report)
    expect(verdict.findingDetails.map((finding: { severity: string; blocks: boolean }) => [finding.severity, finding.blocks])).toEqual([
      ['critical', true], ['high', true], ['medium', true], ['low', false],
    ])
  })

  it('routes an unanchored HIGH finding from the archived review-2 shape', () => {
    const report = `VERDICT: changes-requested
FINDINGS:
- [HIGH][Confirmed][A/E] \`plugin/bin/lib/critic-blockage.mjs:159\` invokes recovery before reconciliation.
`
    const verdict = verdictFromReport('review', report)
    expect(verdict.findingDetails[0]).toMatchObject({ severity: 'high', anchor: null, blocks: false, location: 'plugin/bin/lib/critic-blockage.mjs:159' })
  })

  it('keeps the archived terminal-path critic defect blocking because it cites plan task T2', () => {
    const report = `VERDICT: changes-requested
FINDINGS:
- [blocking] Existing post-bound terminal paths overwrite the diagnosed critic partial. T2 exercises successful report completion only (toolkit/packages/build/test/pilot-runner.test.ts:722-755).
`
    const verdict = verdictFromReport('critic', report)
    expect(verdict.findingDetails[0]).toMatchObject({ anchor: 'T2', blocks: true })
  })

  it('counts an explicit extension as recurrence without exact finding text', () => {
    const rounds = [
      { findings: ['inventory misses final files'], blockingFindings: ['inventory misses final files'], findingDetails: [{ blocks: true, extendsPrior: null }] },
      { findings: ['regenerate manifest after publication'], blockingFindings: ['regenerate manifest after publication'], findingDetails: [{ blocks: true, extendsPrior: 1 }] },
      { findings: ['include retention file too'], blockingFindings: ['include retention file too'], findingDetails: [{ blocks: true, extendsPrior: 1 }] },
    ]
    expect(adaptiveRoundDecision(rounds, 3, 6, false)).toEqual({ continue: false, plateauUsed: false })
  })

  it('asks every independent lane for severity and an anchor and gives later reviews prior findings', () => {
    const brief = independentBrief({
      phase: 'review', context: 'review this', artifacts: ['fix.diff'], reportPath: 'report.md', constructionBase: 'previous-reviewed-tree',
      priorRounds: [{ round: 1, findings: ['first finding'] }],
    })
    expect(brief).toContain('[CRITICAL|HIGH|MEDIUM|LOW][anchor: DoD <n>|plan task <id>][location: <path:line>]')
    expect(brief).toContain('### Round 1\n- first finding')
    expect(brief).toContain('fix since previously reviewed tree')
  })

  it('requires a per-section attack account when a critic has no findings', () => {
    const brief = independentBrief({ phase: 'critic', context: 'criticise', artifacts: ['plan.md'], reportPath: 'report.md' })
    expect(brief).toContain('MUST find issues')
    expect(brief).toContain('## No-finding attack account')
    expect(brief).toContain('failed critic round and is re-run once')
  })
})
