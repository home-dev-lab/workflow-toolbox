// dev-review-fix.test.ts — end-to-end composition test for the dev-review-fix workflow.
// Uses FakeRuntime with onAgent handler routing on prompt content.
// TDD: written before the implementation (RED step).

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf from '../dev-review-fix.workflow.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_INPUT = {
  projectDir: '.',
  testCommand: 'pnpm test',
  diffCommand: 'git diff main...HEAD',
  dimensions: ['correctness', 'tests'],
}

// Default consolidated findings: LOW severity listed FIRST on purpose — the
// workflow must sort by severity IN CODE before assigning ids (the verify cap
// is positional, so the low-severity tail must be the part that gets capped).
const CONSOLIDATED = {
  findings: [
    {
      file: 'src/parse.ts',
      location: 'line 10',
      summary: 'stale comment above parse()',
      detail: 'the comment describes a removed parameter',
      severity: 'low',
      dimensions: ['tests'],
    },
    {
      file: 'src/cli.ts',
      location: 'line 42',
      summary: 'unvalidated input reaches dispatch',
      detail: 'main() forwards raw argv without calling validate()',
      severity: 'high',
      dimensions: ['correctness', 'tests'],
    },
  ],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a FakeRuntime whose onAgent handler responds based on prompt content.
 * Routing uses UNIQUE phrases from the actual workflow prompts — in priority
 * order, most-specific first to avoid cross-matching:
 *   1. Checker:  "independent fix checker"
 *   2. Fixer:    "the fixer for"
 *   3. Verifier: "adversarially verify" (the pattern's own prompt prefix)
 *   4. Dedup:    "consolidate the per-dimension findings"
 *   5. Reviewer: "code reviewer focused on"
 */
function makeRuntime(overrides?: {
  review?: (prompt: string) => unknown
  dedup?: (prompt: string) => unknown
  verify?: (prompt: string, callIndex: number) => unknown
  fix?: (prompt: string, callIndex: number) => unknown
  check?: (prompt: string, callIndex: number) => unknown
}): FakeRuntime {
  let verifyCalls = 0
  let fixCalls = 0
  let checkCalls = 0
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt.toLowerCase()

      // (1) Checker — independent fresh-evidence verification of ALL findings
      if (p.includes('independent fix checker')) {
        const i = checkCalls++
        if (overrides?.check) return overrides.check(prompt, i)
        return {
          green: true,
          findings: [
            { id: 'F1', fixed: true },
            { id: 'F2', fixed: true },
          ],
          evidence: 'suite green: 12/12',
          failureSummary: '',
        }
      }

      // (2) Fixer — addresses the remaining unfixed findings
      if (p.includes('the fixer for')) {
        const i = fixCalls++
        if (overrides?.fix) return overrides.fix(prompt, i)
        return { fixed: true, filesTouched: ['src/cli.ts'], note: 'validated input before dispatch' }
      }

      // (3) Verifier — adversarialVerification's own prompt prefix
      if (p.includes('adversarially verify')) {
        const i = verifyCalls++
        if (overrides?.verify) return overrides.verify(prompt, i)
        return { verdict: 'confirmed', reason: 're-derived from the actual code' }
      }

      // (4) Dedup / consolidation agent
      if (p.includes('consolidate the per-dimension findings')) {
        if (overrides?.dedup) return overrides.dedup(prompt)
        return CONSOLIDATED
      }

      // (5) Reviewer — one per dimension
      if (p.includes('code reviewer focused on')) {
        if (overrides?.review) return overrides.review(prompt)
        return {
          findings: [
            {
              file: 'src/cli.ts',
              location: 'line 42',
              summary: 'unvalidated input reaches dispatch',
              detail: 'main() forwards raw argv without calling validate()',
              severity: 'medium',
            },
          ],
        }
      }

      // Fallback
      return { note: 'unrouted' }
    },
  })
}

type ReportFinding = {
  id: string
  summary: string
  severity: string
  verdict: string
  status: string
  evidence: string
  note?: string
}

// ---------------------------------------------------------------------------
// Test: workflow metadata
// ---------------------------------------------------------------------------

describe('dev-review-fix workflow metadata', () => {
  it('has correct name and phases', () => {
    expect(wf.meta.name).toBe('dev-review-fix')
    expect(wf.meta.description).toBeTruthy()
    const titles = wf.meta.phases?.map((p) => p.title)
    expect(titles).toEqual(['Review', 'Verify', 'Fix', 'Report'])
  })
})

// ---------------------------------------------------------------------------
// Test: parseInput — fail fast with actionable errors
// ---------------------------------------------------------------------------

describe('dev-review-fix parseInput', () => {
  it('throws an actionable error for missing input', async () => {
    const rt = makeRuntime()
    await expect(wf.run(rt, undefined)).rejects.toThrow(/input|projectDir/i)
  })

  it('throws for a missing projectDir', async () => {
    const rt = makeRuntime()
    // JSON.stringify drops undefined-valued keys — same as omitting them.
    await expect(
      wf.run(rt, JSON.stringify({ ...VALID_INPUT, projectDir: undefined })),
    ).rejects.toThrow(/projectDir/i)
  })

  it('throws for a missing testCommand', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ ...VALID_INPUT, testCommand: undefined })),
    ).rejects.toThrow(/testCommand/i)
  })

  it('throws when BOTH diffCommand and changedFiles are given', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ ...VALID_INPUT, changedFiles: ['src/a.ts'] })),
    ).rejects.toThrow(/exactly one|not both/i)
  })

  it('throws when NEITHER diffCommand nor changedFiles is given', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ ...VALID_INPUT, diffCommand: undefined })),
    ).rejects.toThrow(/diffCommand|changedFiles/i)
  })

  it('throws for an empty changedFiles array', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ ...VALID_INPUT, diffCommand: undefined, changedFiles: [] })),
    ).rejects.toThrow(/changedFiles/i)
  })

  it('throws for an empty dimensions array', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ ...VALID_INPUT, dimensions: [] })),
    ).rejects.toThrow(/dimensions/i)
  })

  it('throws for maxFixIterations < 1', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ ...VALID_INPUT, maxFixIterations: 0 })),
    ).rejects.toThrow(/maxFixIterations/i)
  })

  it('accepts an explicit null for the unused diff source (the documented parsed shape)', async () => {
    // JSON has no undefined — the interface documents 'the other is null', so
    // { diffCommand: null, changedFiles: [...] } is ONE diff source, not two.
    const rt = makeRuntime()
    const result = await wf.run(
      rt,
      JSON.stringify({ ...VALID_INPUT, diffCommand: null, changedFiles: ['src/a.ts'] }),
    )
    expect(Array.isArray(result.findings)).toBe(true)
    const reviewer = rt.calls.find((c) => c.opts?.label === 'dev-review-fix:review:correctness')!
    expect(reviewer.prompt).toContain('src/a.ts')
  })

  it('defaults dimensions to the standard four when omitted', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify({ ...VALID_INPUT, dimensions: undefined }))
    const reviewers = rt.calls.filter((c) => c.opts?.label?.startsWith('dev-review-fix:review:'))
    expect(reviewers.length).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Test: happy path — review, verify, fix, report
// ---------------------------------------------------------------------------

describe('dev-review-fix happy path', () => {
  it('returns the deterministic report shape with tallies', async () => {
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(Array.isArray(result.findings)).toBe(true)
    expect(result.findings.length).toBe(2)
    expect(result.tallies).toEqual({
      findings: 2,
      confirmed: 2,
      rejected: 0,
      unverified: 0,
      fixed: 2,
      unfixed: 0,
    })
    // The final check's suite verdict is structured output, not prose.
    expect(result.suiteGreen).toBe(true)
    // The checker's actual-output evidence is threaded into each fixed finding.
    for (const f of result.findings as ReportFinding[]) {
      expect(f.evidence).toBe('suite green: 12/12')
    }
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('sorts findings by severity IN CODE before assigning ids (cap safety)', async () => {
    // The consolidated fake lists the LOW-severity finding first. The verify
    // cap is positional (slice), so the workflow must sort high→low BEFORE
    // assigning F-ids — F1 must be the HIGH finding, not the first-listed one.
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    const findings = result.findings as ReportFinding[]
    expect(findings[0]!.id).toBe('F1')
    expect(findings[0]!.severity).toBe('high')
    expect(findings[1]!.id).toBe('F2')
    expect(findings[1]!.severity).toBe('low')
  })

  it('records the Review, Verify, Fix and Report phases', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))
    expect(rt.phases).toContain('Review')
    expect(rt.phases).toContain('Verify')
    expect(rt.phases).toContain('Fix')
    expect(rt.phases).toContain('Report')
  })

  it('passes the diff command VERBATIM to reviewers and the test command to the checker', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))

    const reviewer = rt.calls.find((c) => c.opts?.label === 'dev-review-fix:review:correctness')!
    expect(reviewer.prompt).toContain('git diff main...HEAD')

    const checker = rt.calls.find((c) => c.opts?.label?.startsWith('dev-review-fix:check:'))!
    expect(checker.prompt).toContain('pnpm test')
  })

  it('threads buildCommand into the checker prompt when provided', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify({ ...VALID_INPUT, buildCommand: 'pnpm build' }))

    const checker = rt.calls.find((c) => c.opts?.label?.startsWith('dev-review-fix:check:'))!
    expect(checker.prompt).toContain('pnpm build')
    expect(checker.prompt).toMatch(/build break/i)
  })

  it('lists changedFiles in the reviewer prompt in no-git mode', async () => {
    const rt = makeRuntime()
    await wf.run(
      rt,
      JSON.stringify({ ...VALID_INPUT, diffCommand: undefined, changedFiles: ['src/a.ts', 'src/b.ts'] }),
    )

    const reviewer = rt.calls.find((c) => c.opts?.label === 'dev-review-fix:review:correctness')!
    expect(reviewer.prompt).toContain('src/a.ts')
    expect(reviewer.prompt).toContain('src/b.ts')
  })

  it('fixer prompt carries the escape hatch, the Do-NOT block and the location caveat', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))

    const fixer = rt.calls.find((c) => c.opts?.label?.startsWith('dev-review-fix:fix:'))!
    // Escape hatch: already-resolved findings are a SUCCESS, not a failure
    // (live-run lesson: nothing-to-do must never stall the loop).
    expect(fixer.prompt).toMatch(/already resolved/i)
    // Do-NOT boundary block.
    expect(fixer.prompt).toMatch(/do not weaken/i)
    // Locations were captured pre-fix and may have drifted.
    expect(fixer.prompt).toMatch(/approximate|may have shifted/i)
  })

  it('surfaces partially-confirmed verdicts distinctly in the report', async () => {
    const rt = makeRuntime({
      verify: () => ({ verdict: 'partially-confirmed', reason: 'partly reproducible' }),
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    const findings = result.findings as ReportFinding[]
    // partially-confirmed findings DO enter the fix queue…
    expect(result.tallies.fixed).toBe(2)
    // …but the report keeps the weaker verdict visible for the human.
    for (const f of findings) expect(f.verdict).toBe('partially-confirmed')
  })
})

// ---------------------------------------------------------------------------
// Test: verdict partition — rejected / unverified findings are NOT fixed
// ---------------------------------------------------------------------------

describe('dev-review-fix verdict partition', () => {
  it('rejects refuted findings WITH the refuting reason and does not fix them', async () => {
    const rt = makeRuntime({
      verify: (prompt) =>
        prompt.includes('stale comment')
          ? { verdict: 'refuted', reason: 'the comment is accurate in the current tree' }
          : { verdict: 'confirmed', reason: 're-derived from the actual code' },
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    const findings = result.findings as ReportFinding[]
    const rejected = findings.find((f) => f.status === 'rejected')!
    expect(rejected.summary).toMatch(/stale comment/)
    // The refuting WHY must survive into the report (human arbitrates rejections).
    expect(rejected.note).toMatch(/comment is accurate/)
    expect(result.tallies).toMatchObject({ rejected: 1, fixed: 1, unfixed: 0 })
  })

  it('shunts unverifiable findings (all votes dead) to unverified and warns loudly', async () => {
    const rt = makeRuntime({ verify: () => null })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.tallies.unverified).toBe(2)
    expect(result.tallies.fixed).toBe(0)
    // NO fixer may run on unverified evidence.
    expect(rt.calls.some((c) => c.opts?.label?.startsWith('dev-review-fix:fix:'))).toBe(false)
    // Findings existed but none reached the fix queue — that must be LOUD.
    expect(result.warnings.some((w: string) => /fix queue/i.test(w))).toBe(true)
  })

  it('marks cap-truncated findings unverified-by-cap and never fixes them', async () => {
    // 13 findings, maxVerifyClaims is 12 → the 13th (lowest severity after the
    // in-code sort) is cap-truncated. All verifier votes die so nothing is
    // fixable — the cap-truncated finding must carry the DISTINCT verdict.
    const many = Array.from({ length: 13 }, (_, i) => ({
      file: `src/f${i}.ts`,
      location: `line ${i + 1}`,
      summary: `finding number ${i}`,
      detail: 'detail',
      severity: i === 12 ? 'low' : 'high',
      dimensions: ['correctness'],
    }))
    const rt = makeRuntime({
      dedup: () => ({ findings: many }),
      verify: () => null,
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    const findings = result.findings as ReportFinding[]
    const capped = findings.filter((f) => f.verdict === 'unverified-by-cap')
    expect(capped.length).toBe(1)
    expect(capped[0]!.severity).toBe('low')
    expect(result.tallies.unverified).toBe(13)
    expect(rt.calls.some((c) => c.opts?.label?.startsWith('dev-review-fix:fix:'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Test: severity-aware verification votes (F7) — low:1, medium/high:3
// ---------------------------------------------------------------------------

describe('dev-review-fix severity-aware votes', () => {
  it('spends 1 verifier vote on low findings and 3 on high', async () => {
    // Default CONSOLIDATED = 1 high + 1 low; after the severity sort the high
    // finding is claim 0 and the low finding is claim 1.
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))

    const verifyLabels = rt.calls
      .map((c) => c.opts?.label ?? '')
      .filter((l) => l.startsWith('adversarialVerification:verify:'))

    // high → 3 votes, low → 1 vote (was 3+3 before severity-aware votes)
    expect(verifyLabels.filter((l) => l.startsWith('adversarialVerification:verify:0:'))).toHaveLength(3)
    expect(verifyLabels.filter((l) => l.startsWith('adversarialVerification:verify:1:'))).toHaveLength(1)
    expect(verifyLabels).toHaveLength(4)

    // The single-vote claim really is the low finding (renderClaim prints it).
    const soloPrompt = rt.calls.find(
      (c) => c.opts?.label === 'adversarialVerification:verify:1:0',
    )?.prompt
    expect(soloPrompt).toContain('severity low')
  })

  it('medium findings keep 3 votes and a 2-of-3 refutation still rejects (regression)', async () => {
    const rt = makeRuntime({
      dedup: () => ({
        findings: [
          {
            file: 'src/api.ts',
            location: 'line 7',
            summary: 'missing error mapping on the fetch path',
            detail: 'errors bubble as raw exceptions instead of ApiError',
            severity: 'medium',
            dimensions: ['correctness'],
          },
        ],
      }),
      verify: (_prompt, i) =>
        i < 2
          ? { verdict: 'refuted', reason: 'the mapping exists in the wrapper' }
          : { verdict: 'confirmed', reason: 'looks missing' },
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    const verifyCount = rt.calls.filter((c) =>
      (c.opts?.label ?? '').startsWith('adversarialVerification:verify:'),
    ).length
    expect(verifyCount).toBe(3)
    expect(result.tallies).toMatchObject({ rejected: 1, fixed: 0 })
  })
})

// ---------------------------------------------------------------------------
// Test: model tiering — the consolidator runs on a cheaper model; every
// quality-critical agent stays on the session model
// ---------------------------------------------------------------------------

describe('dev-review-fix model tiering', () => {
  it('routes the consolidation agent to the cheaper merge model', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))

    const consolidate = rt.calls.find((c) => c.opts?.label === 'dev-review-fix:consolidate')
    expect(consolidate?.opts?.model).toBe('sonnet')
  })

  it('keeps verifiers on BEST_MODEL and everything else on the session model', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(VALID_INPUT))

    const others = rt.calls.filter((c) => c.opts?.label !== 'dev-review-fix:consolidate')
    expect(others.length).toBeGreaterThan(0)
    for (const call of others) {
      const label = call.opts?.label ?? ''
      if (label.startsWith('adversarialVerification:verify:')) {
        // §8 guardrail in the pattern — verification quality is model-sensitive.
        expect(call.opts?.model, `verifier ${label} must stay on BEST_MODEL`).toBe('fable')
      } else {
        expect(call.opts?.model, `unexpected model override on ${label}`).toBeUndefined()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Test: degradation — agents die, the workflow never throws
// ---------------------------------------------------------------------------

describe('dev-review-fix degradation', () => {
  it('survives one dead reviewer — warns, the other dimensions still flow', async () => {
    const rt = makeRuntime({
      review: (prompt) => (prompt.includes('correctness') ? null : {
        findings: [
          {
            file: 'src/cli.ts',
            location: 'line 42',
            summary: 'unvalidated input reaches dispatch',
            detail: 'main() forwards raw argv',
            severity: 'medium',
          },
        ],
      }),
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.warnings.some((w: string) => /reviewer/i.test(w))).toBe(true)
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it('survives ALL reviewers dead — warns and reports zero findings without dedup', async () => {
    const rt = makeRuntime({ review: () => null })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.findings.length).toBe(0)
    expect(result.warnings.some((w: string) => /review/i.test(w))).toBe(true)
    expect(rt.calls.some((c) => c.opts?.label === 'dev-review-fix:consolidate')).toBe(false)
  })

  it('falls back to an in-code concat when the dedup agent dies', async () => {
    const rt = makeRuntime({ dedup: () => null })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    // One default finding per dimension survives WITHOUT the dedup agent —
    // duplicates are possible and the warning says so.
    expect(result.findings.length).toBe(2)
    expect(result.warnings.some((w: string) => /consolidat/i.test(w))).toBe(true)
  })

  it('refuses a dedup agent that RETURNS but drops every finding (silent suppression guard)', async () => {
    // The consolidator sees text partly derived from the reviewed code — a
    // returning-but-suppressing consolidator must not zero out the review.
    const rt = makeRuntime({ dedup: () => ({ findings: [] }) })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    // Concat fallback: one default finding per dimension survives.
    expect(result.findings.length).toBe(2)
    expect(result.warnings.some((w: string) => /zero findings/i.test(w))).toBe(true)
  })

  it('warns when the dedup agent returns fewer findings than one dimension reported', async () => {
    // An honest dedup only merges ACROSS dimensions: it can never go below
    // the largest single-dimension count. 2 findings per dimension in, 1 out
    // → a partial drop, loudly warned.
    const rt = makeRuntime({
      review: () => ({
        findings: [
          { file: 'src/a.ts', location: 'line 1', summary: 'issue one', detail: 'd1', severity: 'high' },
          { file: 'src/b.ts', location: 'line 2', summary: 'issue two', detail: 'd2', severity: 'low' },
        ],
      }),
      dedup: () => ({
        findings: [
          { file: 'src/a.ts', location: 'line 1', summary: 'issue one', detail: 'd1', severity: 'high', dimensions: ['correctness', 'tests'] },
        ],
      }),
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.warnings.some((w: string) => /largest single-dimension|dropped/i.test(w))).toBe(true)
  })

  it('still runs the checker when the fixer dies — the tree may already be fixed', async () => {
    const rt = makeRuntime({ fix: () => null })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    // The default checker reports both findings fixed on the actual tree.
    expect(result.tallies.fixed).toBe(2)
    expect(result.warnings.some((w: string) => /fixer/i.test(w))).toBe(true)
  })

  it('treats a dead checker as not-done, exhausts the loop and reports unfixed', async () => {
    const rt = makeRuntime({ check: () => null })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.tallies.unfixed).toBe(2)
    expect(result.tallies.fixed).toBe(0)
    expect(result.warnings.some((w: string) => /checker/i.test(w))).toBe(true)
    // Unfixed findings push the resume hint.
    expect(result.warnings.some((w: string) => /resume/i.test(w))).toBe(true)
  })

  it('keeps the last failureSummary in unfixed findings (the re-run input)', async () => {
    const rt = makeRuntime({
      check: () => ({
        green: false,
        findings: [
          { id: 'F1', fixed: false },
          { id: 'F2', fixed: false },
        ],
        evidence: 'suite red',
        failureSummary: 'validate(null) test still fails',
      }),
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    const findings = result.findings as ReportFinding[]
    expect(result.tallies.unfixed).toBe(2)
    for (const f of findings) {
      expect(f.status).toBe('unfixed')
      expect(f.note).toMatch(/validate\(null\)/)
      // The checker's actual-output evidence is threaded into unfixed findings too.
      expect(f.evidence).toBe('suite red')
    }
  })

  it('recovers when the check goes green on a later iteration', async () => {
    const rt = makeRuntime({
      check: (_p, i) =>
        i === 0
          ? {
              green: false,
              findings: [
                { id: 'F1', fixed: true },
                { id: 'F2', fixed: false },
              ],
              evidence: 'suite red',
              failureSummary: 'F2 not addressed yet',
            }
          : {
              green: true,
              findings: [
                { id: 'F1', fixed: true },
                { id: 'F2', fixed: true },
              ],
              evidence: 'suite green after second pass',
              failureSummary: '',
            },
    })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.tallies.fixed).toBe(2)
    expect(result.tallies.unfixed).toBe(0)
  })

  it('REPLACES the fixed-set with each check — a re-broken finding ends unfixed, not merged away', async () => {
    // iter 0: F1 fixed, F2 not. iter 1: the F2 fix RE-BREAKS F1 while the
    // suite goes green. The checker verdict must REPLACE (not merge into) the
    // fixed-set: F1 ends unfixed even though an earlier check called it fixed.
    const rt = makeRuntime({
      check: (_p, i) =>
        i === 0
          ? {
              green: false,
              findings: [
                { id: 'F1', fixed: true },
                { id: 'F2', fixed: false },
              ],
              evidence: 'suite red',
              failureSummary: 'F2 not addressed yet',
            }
          : {
              green: true,
              findings: [
                { id: 'F1', fixed: false },
                { id: 'F2', fixed: true },
              ],
              evidence: 'suite green but F1 regressed',
              failureSummary: 'F1 re-broken by the F2 fix',
            },
    })
    const result = await wf.run(rt, JSON.stringify({ ...VALID_INPUT, maxFixIterations: 2 }))

    const findings = result.findings as ReportFinding[]
    expect(result.tallies.fixed).toBe(1)
    expect(result.tallies.unfixed).toBe(1)
    expect(findings.find((f) => f.id === 'F1')!.status).toBe('unfixed')
    expect(findings.find((f) => f.id === 'F1')!.note).toMatch(/re-broken/)
    expect(findings.find((f) => f.id === 'F2')!.status).toBe('fixed')
  })

  it('keeps looping while green if findings remain unfixed (green alone is not done)', async () => {
    // The loop's raison d'etre: a review finding can stay broken WHILE the
    // suite is green (review findings are the issues tests do not cover).
    const rt = makeRuntime({
      check: () => ({
        green: true,
        findings: [
          { id: 'F1', fixed: true },
          { id: 'F2', fixed: false },
        ],
        evidence: 'suite green — F2 is exactly what the tests do not cover',
        failureSummary: 'F2 still unaddressed',
      }),
    })
    const result = await wf.run(rt, JSON.stringify({ ...VALID_INPUT, maxFixIterations: 3 }))

    // green:true must NOT terminate the loop while a finding is unfixed —
    // every allowed iteration runs.
    const checks = rt.calls.filter((c) => c.opts?.label?.startsWith('dev-review-fix:check:'))
    expect(checks.length).toBe(3)
    expect(result.tallies.fixed).toBe(1)
    expect(result.tallies.unfixed).toBe(1)
    expect(result.warnings.some((w: string) => /resume/i.test(w))).toBe(true)
  })

  it('exposes a RED final suite even when every finding is individually fixed', async () => {
    // A fix can break an UNRELATED test or the build: all findings fixed but
    // green:false. The loop exhausts — the report must carry the red verdict
    // structurally (suiteGreen) and warn, not read as a full success.
    const rt = makeRuntime({
      check: () => ({
        green: false,
        findings: [
          { id: 'F1', fixed: true },
          { id: 'F2', fixed: true },
        ],
        evidence: 'findings addressed but an unrelated test broke',
        failureSummary: 'utils.spec.ts: formatDate test now fails',
      }),
    })
    const result = await wf.run(rt, JSON.stringify({ ...VALID_INPUT, maxFixIterations: 2 }))

    expect(result.tallies.fixed).toBe(2)
    expect(result.tallies.unfixed).toBe(0)
    expect(result.suiteGreen).toBe(false)
    expect(
      result.warnings.some((w: string) => /not green/i.test(w) && /formatDate/.test(w)),
    ).toBe(true)
  })

  it('flags fixed statuses when the checker died after the last fix iteration', async () => {
    // iter 0: F1 checked fixed. iter 1: the fixer mutates the tree again but
    // the checker DIES — F1's fixed status now predates an unchecked mutation
    // and must say so instead of presenting as confirmed-fixed.
    const rt = makeRuntime({
      check: (_p, i) =>
        i === 0
          ? {
              green: false,
              findings: [
                { id: 'F1', fixed: true },
                { id: 'F2', fixed: false },
              ],
              evidence: 'F1 done, F2 remains',
              failureSummary: 'F2 remains',
            }
          : null,
    })
    const result = await wf.run(rt, JSON.stringify({ ...VALID_INPUT, maxFixIterations: 2 }))

    const f1 = (result.findings as ReportFinding[]).find((f) => f.id === 'F1')!
    expect(f1.status).toBe('fixed')
    expect(f1.note).toMatch(/without a checker read|re-verify/i)
    expect(result.warnings.some((w: string) => /checker/i.test(w))).toBe(true)
  })

  it('threads maxFixIterations into the loop bound (exactly N fix/check rounds)', async () => {
    const rt = makeRuntime({
      check: () => ({
        green: false,
        findings: [
          { id: 'F1', fixed: false },
          { id: 'F2', fixed: false },
        ],
        evidence: 'suite red',
        failureSummary: 'still red',
      }),
    })
    await wf.run(rt, JSON.stringify({ ...VALID_INPUT, maxFixIterations: 1 }))

    expect(rt.calls.filter((c) => c.opts?.label?.startsWith('dev-review-fix:fix:')).length).toBe(1)
    expect(rt.calls.filter((c) => c.opts?.label?.startsWith('dev-review-fix:check:')).length).toBe(1)
  })

  it('reports clean and spawns NO verify/fix agents when the review finds nothing', async () => {
    const rt = makeRuntime({ review: () => ({ findings: [] }) })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.findings.length).toBe(0)
    // No checker ever ran — the suite verdict is honestly unknown, not green.
    expect(result.suiteGreen).toBeNull()
    expect(result.tallies).toEqual({
      findings: 0,
      confirmed: 0,
      rejected: 0,
      unverified: 0,
      fixed: 0,
      unfixed: 0,
    })
    // Only the 2 reviewers ran — no dedup, no verifiers, no fix loop.
    expect(rt.calls.length).toBe(2)
  })
})
