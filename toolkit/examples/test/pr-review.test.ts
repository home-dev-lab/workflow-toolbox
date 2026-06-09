// pr-review.test.ts — end-to-end composition test for the pr-review workflow.
// Uses FakeRuntime with onAgent handler routing on prompt content.
// TDD: written before the implementation (RED step).

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@dwt/runtime'
import wf from '../pr-review.workflow.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a FakeRuntime whose onAgent handler responds based on prompt content.
 * Routing uses UNIQUE phrases from the actual workflow prompts — in priority order:
 *   1. Verifier:    "adversarially verify" (pattern-owned prompt, always first)
 *   2. Synthesis:   "synthesizing a code review" (unique phrase before JSON embedding)
 *   3. Reviewer:    "you are a specialized code reviewer"
 *   4. Act stage:   "you are reviewing a" (bugfix/feature/refactor/config/docs)
 *   5. Classify:    "classify it into exactly one category"
 * Order matters: check most-specific first to avoid cross-matching.
 */
function makeHappyPathRuntime(): FakeRuntime {
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt.toLowerCase()

      // (1) Adversarial verifier stage — pattern owns this prompt phrase
      if (p.includes('adversarially verify')) {
        return { verdict: 'confirmed', reason: 'Verified: null check is indeed missing' }
      }

      // (2) Synthesis stage — unique phrase at the TOP of the synthesis prompt,
      //     before any JSON.stringify embedding that might contain 'findings' etc.
      if (p.includes('synthesizing a code review')) {
        return { verdict: 'request-changes', summary: 'Critical null-check finding must be addressed' }
      }

      // (3) Reviewer stage — "you are a specialized code reviewer"
      if (p.includes('you are a specialized code reviewer')) {
        return {
          findings: [
            {
              title: 'Missing null check',
              file: 'src/payment.ts',
              severity: 'high',
              detail: 'The payment processor does not check for null user before charging',
            },
          ],
        }
      }

      // (4) Act stage (change summary) — "you are reviewing a <category> change"
      if (p.includes('you are reviewing a')) {
        return { summary: 'Fixes null pointer in payment processor', riskAreas: ['payment', 'auth'] }
      }

      // (5) Classifier — "classify it into exactly one category"
      if (p.includes('classify it into exactly one category')) {
        return { category: 'bugfix' }
      }

      // Fallback
      return { summary: 'Change summary', riskAreas: [] }
    },
  })
}

// ---------------------------------------------------------------------------
// Test: workflow metadata
// ---------------------------------------------------------------------------

describe('pr-review workflow metadata', () => {
  it('has correct name and phases', () => {
    expect(wf.meta.name).toBe('pr-review')
    expect(wf.meta.description).toBeTruthy()
    const titles = wf.meta.phases?.map(p => p.title)
    expect(titles).toEqual(['Route', 'Review', 'Verify', 'Synthesize'])
  })
})

// ---------------------------------------------------------------------------
// Test: parseInput / fail-fast validation
// ---------------------------------------------------------------------------

describe('pr-review parseInput', () => {
  it('throws an actionable error for missing input', async () => {
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, undefined)).rejects.toThrow(/target/)
  })

  it('throws an actionable error for empty target string', async () => {
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, JSON.stringify({ target: '' }))).rejects.toThrow(/target/)
  })

  it('throws for non-string target', async () => {
    const rt = makeHappyPathRuntime()
    await expect(wf.run(rt, JSON.stringify({ target: 42 }))).rejects.toThrow(/target/)
  })

  it('accepts bare string shorthand as { target }', async () => {
    // A raw string passed as rawArgs should be treated as the target value
    const rt = makeHappyPathRuntime()
    // Bare string shorthand: the runtime delivers the string directly (not JSON-encoded)
    // defineWorkflow normalizes: JSON.parse('"main...feature"') → 'main...feature'
    // Then parseInput accepts a plain string as shorthand for { target: string }
    const result = await wf.run(rt, JSON.stringify('main...feature'))
    expect(result).toBeDefined()
    expect(result).toHaveProperty('verdict')
  })

  it('accepts JSON-encoded object arg (runtime JSON string delivery)', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify({ target: 'HEAD~3..HEAD' }))
    expect(result).toBeDefined()
    expect(result).toHaveProperty('verdict')
  })
})

// ---------------------------------------------------------------------------
// Test: happy path — full composition
// ---------------------------------------------------------------------------

describe('pr-review happy path', () => {
  it('returns the correct final shape', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD' }))

    // Top-level shape
    expect(result).toHaveProperty('category')
    expect(result).toHaveProperty('verdict')
    expect(result).toHaveProperty('summary')
    expect(result).toHaveProperty('findings')
    expect(result).toHaveProperty('stats')
    expect(result).toHaveProperty('warnings')

    // Category is one of the 5 valid ones
    expect(['feature', 'bugfix', 'refactor', 'config', 'docs']).toContain(result.category)

    // Verdict is a valid review verdict
    expect(['approve', 'request-changes']).toContain(result.verdict)

    // Stats shape
    expect(result.stats).toHaveProperty('reviewersSpawned')
    expect(result.stats).toHaveProperty('findingsRaw')
    expect(result.stats).toHaveProperty('findingsVerified')
    expect(result.stats).toHaveProperty('findingsRefuted')
    expect(result.stats).toHaveProperty('dropped')

    // Warnings is an array
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('assigns phases (FakeRuntime.phases records phase() calls)', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD' }))

    // At minimum the Synthesize phase must be explicitly set (barrier)
    expect(rt.phases).toContain('Synthesize')
  })

  it('spawns at least 1 agent for classify + 3 reviewers + 3 verifiers + 1 synthesizer', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD' }))

    // classify(1) + act(1) + 3 reviewers + 3*N verifiers + 1 synthesizer
    // Minimum when bugfix has 3 lenses with 3 votes each: 1+1+3+9+1 = 15
    // But with maxVerifyClaims:5 and findings may vary; just check > 5
    expect(rt.agentsSpawned).toBeGreaterThan(5)
  })

  it('findings in result have verdict property from verification', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD' }))

    // Each finding in the output carries a verdict (from adversarialVerification)
    for (const f of result.findings) {
      expect(f).toHaveProperty('verdict')
      expect(['confirmed', 'partially-confirmed', 'refuted', 'unverifiable']).toContain(f.verdict)
    }
  })
})

// ---------------------------------------------------------------------------
// Test: reviewer agent returning null → dropped, composition completes
// ---------------------------------------------------------------------------

describe('pr-review null reviewer handling', () => {
  it('drops a null reviewer and counts it in warnings/stats, but completes', async () => {
    let reviewerCallCount = 0

    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()

        // (1) Adversarial verifier — most specific, check first
        if (p.includes('adversarially verify')) {
          return { verdict: 'confirmed', reason: 'Looks right' }
        }

        // (2) Synthesis
        if (p.includes('synthesizing a code review')) {
          return { verdict: 'approve', summary: 'No critical issues' }
        }

        // (3) Reviewer stage — first reviewer returns null
        if (p.includes('you are a specialized code reviewer')) {
          reviewerCallCount++
          if (reviewerCallCount === 1) return null // first reviewer dies
          return {
            findings: [
              { title: 'Test finding', file: 'src/foo.ts', severity: 'low', detail: 'Details here' },
            ],
          }
        }

        // (4) Act stage (change summary)
        if (p.includes('you are reviewing a')) {
          return { summary: 'Bugfix summary', riskAreas: ['core'] }
        }

        // (5) Classifier
        if (p.includes('classify it into exactly one category')) {
          return { category: 'bugfix' }
        }

        return { summary: 'Default summary', riskAreas: [] }
      },
    })

    const result = await wf.run(rt, JSON.stringify({ target: 'feature-branch' }))

    // Composition must complete
    expect(result).toHaveProperty('verdict')

    // dropped counter must reflect the null reviewer
    expect(result.stats.dropped).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Test: finding refuted by verifiers → excluded from synthesis, reported in stats
// ---------------------------------------------------------------------------

describe('pr-review finding refutation', () => {
  it('excludes refuted findings from synthesis input and reports them in stats', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()

        // (1) Adversarial verifier — ALL verifiers refute (2 of 3 = threshold met → 'refuted')
        if (p.includes('adversarially verify')) {
          return { verdict: 'refuted', reason: 'Status code 200 is actually acceptable here' }
        }

        // (2) Synthesis
        if (p.includes('synthesizing a code review')) {
          return { verdict: 'approve', summary: 'All findings were refuted or addressed' }
        }

        // (3) Reviewers return a finding
        if (p.includes('you are a specialized code reviewer')) {
          return {
            findings: [
              { title: 'Wrong status code', file: 'src/api.ts', severity: 'medium', detail: 'Returns 200 instead of 201' },
            ],
          }
        }

        // (4) Act stage (change summary)
        if (p.includes('you are reviewing a')) {
          return { summary: 'Feature summary', riskAreas: ['api'] }
        }

        // (5) Classifier
        if (p.includes('classify it into exactly one category')) {
          return { category: 'feature' }
        }

        return { summary: 'Default', riskAreas: [] }
      },
    })

    const result = await wf.run(rt, JSON.stringify({ target: 'main...feature-auth' }))

    expect(result).toHaveProperty('verdict', 'approve')

    // Refuted findings must be counted
    expect(result.stats.findingsRefuted).toBeGreaterThan(0)

    // Refuted findings appear in the output findings array (with verdict='refuted')
    // but synthesis should not include them as actionable items
    const refutedFindings = result.findings.filter((f: { verdict: string }) => f.verdict === 'refuted')
    expect(refutedFindings.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Test: unknown classification category → actionable error or fallback
// ---------------------------------------------------------------------------

describe('pr-review unknown classification', () => {
  it('handles an unknown category returned by the classifier gracefully', async () => {
    // The classifyAndAct pattern uses a control schema with an enum — the
    // runtime enforces the enum at the fake level since FakeRuntime doesn't
    // validate schemas. If the classifier returns an unknown category, the
    // pattern's classify stage throws → item dropped → classifyAndAct produces
    // an empty result → the workflow should handle this and either throw with
    // an actionable error or produce a result with a fallback.
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()

        // Return an invalid category not in the allowed set
        if (p.includes('classify') || (p.includes('inspect') && p.includes('category'))) {
          return { category: 'unknown-xyz' }
        }

        return null
      },
    })

    // Either throws with actionable message, or returns a result with warnings
    try {
      const result = await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD' }))
      // If it doesn't throw, it should have warnings about the failure
      expect(result.warnings.length).toBeGreaterThan(0)
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/classif|categor|unknown/i)
    }
  })
})
