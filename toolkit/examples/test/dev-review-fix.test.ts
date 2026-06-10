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

  it('reports clean and spawns NO verify/fix agents when the review finds nothing', async () => {
    const rt = makeRuntime({ review: () => ({ findings: [] }) })
    const result = await wf.run(rt, JSON.stringify(VALID_INPUT))

    expect(result.findings.length).toBe(0)
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
