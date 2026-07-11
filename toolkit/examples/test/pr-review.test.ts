// pr-review.test.ts — end-to-end composition test for the pr-review workflow.
// Uses FakeRuntime with onAgent handler routing on prompt content.
// TDD: written before the implementation (RED step).

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
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

      // (0) Availability probe (probeAgentType) — affirmative by default
      if (p.includes('availability probe')) {
        return 'PROBE_OK'
      }

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
    expect(titles).toEqual(['Probe', 'Route', 'Review', 'Verify', 'Synthesize'])
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

  it('spawns one reviewer per lens (4 for a code category) + classify + act + verifiers + synthesizer', async () => {
    const rt = makeHappyPathRuntime() // classify → 'bugfix'
    await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD' }))

    // ONE reviewer per lens AND four DISTINCT lenses. Assert the exact lens SET, not just the count:
    // a duplicate-lens, dropped-lens, or renamed-lens regression keeps the count at 4 but changes the
    // set, so a count-only check (the old `> 5`, or even `=== 4`) would pass it silently. The lens is
    // the label suffix — `pr-review:reviewer:<lens>` — and 'bugfix' carries these four.
    const reviewerLabels = rt.calls
      .map((c) => c.opts?.label)
      .filter((l): l is string => typeof l === 'string' && l.startsWith('pr-review:reviewer:'))
    const lenses = new Set(reviewerLabels.map((l) => l.slice('pr-review:reviewer:'.length)))
    expect(reviewerLabels).toHaveLength(4)
    expect(lenses).toEqual(new Set(['root-cause', 'regression-risk', 'test-coverage', 'maintainability']))
    // Then classify(1) + act(1) + per-finding verifiers + the synthesizer all add on top.
    expect(rt.agentsSpawned).toBeGreaterThan(reviewerLabels.length + 2)
  })

  it('findings in result have verdict property from verification', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD' }))

    // Each finding in the output carries a verdict (from adversarialVerification).
    // 'unverified-by-cap' is the pattern-level claim verdict for findings the
    // maxVerifyClaims cap withheld from verification (patterns 0.3.0, additive).
    for (const f of result.findings) {
      expect(f).toHaveProperty('verdict')
      expect([
        'confirmed',
        'partially-confirmed',
        'refuted',
        'unverifiable',
        'unverified-by-cap',
      ]).toContain(f.verdict)
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
// Test: cap-truncated findings carry 'unverified-by-cap' and survive synthesis
//
// Regression for the patterns-0.3.0 verdict-vocabulary change: the workflow
// passes maxVerifyClaims: 5 to adversarialVerification, so any reviewer that
// yields more than 5 findings makes the cap reachable. Cap-cut findings must
// surface with the distinct 'unverified-by-cap' verdict (NOT 'unverifiable',
// which means verifiers genuinely could not decide), must spawn NO verifier
// agents, and must NOT be excluded from synthesis — only 'refuted' ever is
// (keep-unverified-rather-than-drop).
// ---------------------------------------------------------------------------

describe('pr-review cap-truncated findings (unverified-by-cap)', () => {
  it('labels cap-cut findings unverified-by-cap and keeps them in synthesis input', async () => {
    let reviewerCallCount = 0
    let verifierCallCount = 0
    let synthesisPrompt = ''

    // 7 findings from ONE reviewer → with maxVerifyClaims: 5 the first 5 are
    // verified and the last 2 come back as 'unverified-by-cap' with votes: [].
    const sevenFindings = Array.from({ length: 7 }, (_, i) => ({
      title: `cap-finding-${i + 1}`,
      file: `src/file-${i + 1}.ts`,
      severity: 'medium',
      detail: `Detail for finding ${i + 1}`,
    }))

    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()

        // (1) Adversarial verifier — count calls to pin that cap-cut claims
        //     spawn NO verifier agents (5 kept claims x 3 votes = 15 calls).
        if (p.includes('adversarially verify')) {
          verifierCallCount++
          return { verdict: 'confirmed', reason: 'Re-derived from the diff' }
        }

        // (2) Synthesis — capture the prompt to assert cap-cut findings
        //     survive into the synthesis input (only 'refuted' is excluded).
        if (p.includes('synthesizing a code review')) {
          synthesisPrompt = prompt
          return { verdict: 'request-changes', summary: 'Several findings to address' }
        }

        // (3) Reviewers — first lens yields 7 findings, the others none, so
        //     exactly ONE verification call sees more claims than the cap.
        if (p.includes('you are a specialized code reviewer')) {
          reviewerCallCount++
          if (reviewerCallCount === 1) return { findings: sevenFindings }
          return { findings: [] }
        }

        // (4) Act stage (change summary)
        if (p.includes('you are reviewing a')) {
          return { summary: 'Wide-reaching bugfix', riskAreas: ['core'] }
        }

        // (5) Classifier
        if (p.includes('classify it into exactly one category')) {
          return { category: 'bugfix' }
        }

        return { summary: 'Default summary', riskAreas: [] }
      },
    })

    const result = await wf.run(rt, JSON.stringify({ target: 'HEAD~2..HEAD' }))

    // All 7 findings surface — claims are never dropped by the cap.
    expect(result.stats.findingsRaw).toBe(7)
    expect(result.stats.findingsRefuted).toBe(0)
    expect(result.stats.findingsVerified).toBe(7)

    // The 2 cap-cut findings (input order is preserved: the cap keeps the
    // first 5, truncated claims are appended) carry the DISTINCT verdict.
    const capped = result.findings.filter(
      (f: { verdict: string }) => f.verdict === 'unverified-by-cap',
    )
    expect(capped.length).toBe(2)
    const cappedTitles = capped.map((f: { title: string }) => f.title).sort()
    expect(cappedTitles).toEqual(['cap-finding-6', 'cap-finding-7'])

    // Distinction is explicit: cap-cut findings are NOT mislabeled as
    // 'unverifiable' (that value stays reserved for verifier failure).
    const unverifiable = result.findings.filter(
      (f: { verdict: string }) => f.verdict === 'unverifiable',
    )
    expect(unverifiable.length).toBe(0)
    const confirmed = result.findings.filter(
      (f: { verdict: string }) => f.verdict === 'confirmed',
    )
    expect(confirmed.length).toBe(5)

    // Cap-cut claims spawned NO verifier agents: 5 kept claims x 3 votes.
    expect(verifierCallCount).toBe(15)

    // Survival into synthesis: the synthesis prompt embeds the non-refuted
    // findings as JSON — the cap-cut findings (and their verdict) must be in.
    expect(synthesisPrompt).toContain('cap-finding-6')
    expect(synthesisPrompt).toContain('cap-finding-7')
    expect(synthesisPrompt).toContain('unverified-by-cap')
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

// ---------------------------------------------------------------------------
// Test: reviewer routing via the STRUCTURED config channel `agentTypes.review`
// (the bespoke top-level `reviewerType` arg was REMOVED — no back-compat).
// The request is PROBE-RESOLVED at run entry (probeAgentType): affirmative →
// the lens reviewers carry the type (reviewers ONLY — verifiers/synthesizer
// never specialized); non-affirmative → graceful fallback to the standard
// subagent, reported in the result's `probe`, never silent.
// ---------------------------------------------------------------------------
describe('pr-review reviewer routing (agentTypes.review)', () => {
  const probeCalls = (rt: FakeRuntime) =>
    rt.calls.filter((c) => c.opts?.label === 'probeAgentType:probe')
  const reviewCalls = (rt: FakeRuntime) =>
    rt.calls.filter((c) => c.opts?.label?.startsWith('pr-review:reviewer:'))
  const verifyCalls = (rt: FakeRuntime) =>
    rt.calls.filter((c) => c.opts?.label?.startsWith('adversarialVerification:verify:'))

  it('omits agentType on the reviewers (and spawns no probe) when agentTypes.review is not provided', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD' }))
    const reviews = reviewCalls(rt)
    expect(reviews.length).toBeGreaterThan(0)
    for (const c of reviews) expect(c.opts?.agentType).toBeUndefined()
    expect(probeCalls(rt).length).toBe(0)
    expect((result as { reviewerType: string | null }).reviewerType).toBeNull()
    expect((result as { probe: unknown }).probe).toBeNull()
  })

  it('probes once then routes the lens reviewers — reviewers only', async () => {
    const rt = makeHappyPathRuntime()
    const result = await wf.run(
      rt,
      JSON.stringify({ target: 'HEAD~1..HEAD', agentTypes: { review: 'magic-claude:ts-reviewer' } }),
    )
    expect(probeCalls(rt).length).toBe(1)
    expect(probeCalls(rt)[0]!.opts?.agentType).toBe('magic-claude:ts-reviewer')
    const reviews = reviewCalls(rt)
    expect(reviews.length).toBeGreaterThan(0)
    for (const c of reviews) expect(c.opts?.agentType).toBe('magic-claude:ts-reviewer')
    // The verifiers are NEVER specialized by the reviewer knob.
    for (const c of verifyCalls(rt)) expect(c.opts?.agentType).toBeUndefined()
    expect((result as { reviewerType: string | null }).reviewerType).toBe('magic-claude:ts-reviewer')
    const probe = (result as { probe: { available: boolean; reason: string | null } }).probe
    expect(probe.available).toBe(true)
    expect(probe.reason).toBeNull()
  })

  it('falls back to the standard subagent when the probe is non-affirmative, reporting the reason', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()
        if (p.includes('availability probe')) {
          return 'OPENCODE_UNAVAILABLE: no opencode binary on PATH'
        }
        if (p.includes('adversarially verify')) {
          return { verdict: 'confirmed', reason: 'verified' }
        }
        if (p.includes('synthesizing a code review')) {
          return { verdict: 'approve', summary: 'Fine' }
        }
        if (p.includes('you are a specialized code reviewer')) {
          return { findings: [] }
        }
        if (p.includes('classify it into exactly one category')) {
          return { category: 'bugfix' }
        }
        return { summary: 'Change summary', riskAreas: [] }
      },
    })
    const result = await wf.run(
      rt,
      JSON.stringify({
        target: 'HEAD~1..HEAD',
        agentTypes: { review: 'workflow-toolbox:opencode-verifier' },
      }),
    )
    // Reviewers still ran — WITHOUT the agentType (graceful fallback)
    const reviews = reviewCalls(rt)
    expect(reviews.length).toBeGreaterThan(0)
    for (const c of reviews) expect(c.opts?.agentType).toBeUndefined()
    expect((result as { reviewerType: string | null }).reviewerType).toBeNull()
    const probe = (result as {
      probe: { requested: string; available: boolean; reason: string | null }
    }).probe
    expect(probe.requested).toBe('workflow-toolbox:opencode-verifier')
    expect(probe.available).toBe(false)
    expect(probe.reason).toContain('OPENCODE_UNAVAILABLE')
  })

  it('rejects a blank agentTypes.review via the shared parseConfig validation', async () => {
    const rt = makeHappyPathRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD', agentTypes: { review: '  ' } })),
    ).rejects.toThrow(/agentTypes\.review/)
  })

  it('ignores a legacy top-level reviewerType arg (removed contract)', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD', reviewerType: 'magic-claude:ts-reviewer' }))
    expect(probeCalls(rt).length).toBe(0)
    for (const c of reviewCalls(rt)) expect(c.opts?.agentType).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Test: per-stage effort defaults + Class B/C `args.effort.<role>` overrides.
// Every stage used to inherit the session effort silently; these constants
// (CLASSIFY_EFFORT='low', ROUTE_ACT_EFFORT='medium', REVIEW_EFFORT='high',
// VERIFY_EFFORT_DEFAULT='high', SYNTHESIZE_EFFORT='medium') are asserted at
// their exact call sites, and the launch-time override is resolved through
// resolveEffort/resolveVerifierEffort — the 'verify' role is a FLOOR: an
// override may only RAISE it, never lower it below 'high'.
// ---------------------------------------------------------------------------
describe('pr-review effort defaults and overrides', () => {
  const classifyCalls = (rt: FakeRuntime) =>
    rt.calls.filter((c) => c.opts?.label === 'classifyAndAct:classify:0')
  const actCalls = (rt: FakeRuntime) =>
    rt.calls.filter((c) => c.opts?.label?.startsWith('classifyAndAct:act:'))
  const reviewCalls = (rt: FakeRuntime) =>
    rt.calls.filter((c) => c.opts?.label?.startsWith('pr-review:reviewer:'))
  const verifyCalls = (rt: FakeRuntime) =>
    rt.calls.filter((c) => c.opts?.label?.startsWith('adversarialVerification:verify:'))
  const synthesizeCalls = (rt: FakeRuntime) =>
    rt.calls.filter((c) => c.opts?.label === 'pr-review:synthesize')

  it('applies the committed stage-class defaults when no override is given', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD' }))

    for (const c of classifyCalls(rt)) expect(c.opts?.effort).toBe('low')
    for (const c of actCalls(rt)) expect(c.opts?.effort).toBe('medium')
    const reviews = reviewCalls(rt)
    expect(reviews.length).toBeGreaterThan(0)
    for (const c of reviews) expect(c.opts?.effort).toBe('high')
    const verifies = verifyCalls(rt)
    expect(verifies.length).toBeGreaterThan(0)
    for (const c of verifies) expect(c.opts?.effort).toBe('high')
    for (const c of synthesizeCalls(rt)) expect(c.opts?.effort).toBe('medium')
  })

  it('applies a valid launch-time override per role', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify({
      target: 'HEAD~1..HEAD',
      effort: { classify: 'xhigh', route: 'high', review: 'xhigh', synthesize: 'high' },
    }))

    for (const c of classifyCalls(rt)) expect(c.opts?.effort).toBe('xhigh')
    for (const c of actCalls(rt)) expect(c.opts?.effort).toBe('high')
    for (const c of reviewCalls(rt)) expect(c.opts?.effort).toBe('xhigh')
    for (const c of synthesizeCalls(rt)) expect(c.opts?.effort).toBe('high')
  })

  it('lets an override RAISE the verify floor above high', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD', effort: { verify: 'max' } }))
    const verifies = verifyCalls(rt)
    expect(verifies.length).toBeGreaterThan(0)
    for (const c of verifies) expect(c.opts?.effort).toBe('max')
  })

  it('clamps an override that tries to LOWER verify below the high floor', async () => {
    const rt = makeHappyPathRuntime()
    await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD', effort: { verify: 'low' } }))
    const verifies = verifyCalls(rt)
    expect(verifies.length).toBeGreaterThan(0)
    for (const c of verifies) expect(c.opts?.effort).toBe('high')
  })

  it('rejects an invalid effort value at parse time (parseConfig validates strictly)', async () => {
    // parseConfig throws before resolveEffort ever sees the value — the
    // typo-catching happens at the launch-time boundary, not at the stage.
    // resolveEffort's own graceful-degradation path is covered directly by
    // packages/std/test/resolve-effort.test.ts (defense-in-depth for any
    // consumer that does NOT route through parseConfig).
    const rt = makeHappyPathRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD', effort: { classify: 'turbo' } })),
    ).rejects.toThrow(/effort\.classify must be one of/)
  })

  it("resolves 'auto' to that role's OWN stage default, independently per role, without throwing", async () => {
    // parseConfig accepts 'auto' in the effort role map (EffortRoleValue) — it
    // passes the token through unresolved; resolveEffort/resolveVerifierEffort
    // at each call site treat it as "not a valid tier" and fall back to that
    // SPECIFIC stage's own default. 'auto' on one role must not affect another.
    const rt = makeHappyPathRuntime()
    const result = await wf.run(rt, JSON.stringify({
      target: 'HEAD~1..HEAD',
      effort: { classify: 'auto', review: 'xhigh', verify: 'auto' },
    }))
    expect(result).toHaveProperty('verdict')

    for (const c of classifyCalls(rt)) expect(c.opts?.effort).toBe('low')       // CLASSIFY_EFFORT default
    for (const c of reviewCalls(rt)) expect(c.opts?.effort).toBe('xhigh')       // explicit override, unaffected by 'auto'
    const verifies = verifyCalls(rt)
    expect(verifies.length).toBeGreaterThan(0)
    for (const c of verifies) expect(c.opts?.effort).toBe('high')              // VERIFY_EFFORT_DEFAULT (also the floor)
  })
})

// ---------------------------------------------------------------------------
// Test: degenerate act-output guard (card #1814943589197677963)
// Observed live 2026-07-08: two riskAreas-missing schema rejections, then the
// agent capitulated into {"summary":"test","riskAreas":["a","b"]} — validating
// junk that silently seeded the reviewers. The guard must surface it loudly.
// ---------------------------------------------------------------------------

describe('pr-review degenerate change-summary guard', () => {
  function runtimeWithActOutput(act: unknown): FakeRuntime {
    return new FakeRuntime({
      onAgent: ({ prompt }: { prompt: string; index: number }) => {
        const p = prompt.toLowerCase()
        if (p.includes('adversarially verify')) return { verdict: 'confirmed', reason: 'r' }
        if (p.includes('synthesizing a code review')) return { verdict: 'approve', summary: 'No blocking findings' }
        if (p.includes('you are a specialized code reviewer')) return { findings: [] }
        if (p.includes('you are reviewing a')) return act
        if (p.includes('classify it into exactly one category')) return { category: 'feature' }
        return { summary: 'Fallback change summary', riskAreas: [] }
      },
    })
  }

  async function warningsFor(act: unknown): Promise<readonly string[]> {
    const rt = runtimeWithActOutput(act)
    const result = await wf.run(rt, JSON.stringify({ target: 'HEAD~1..HEAD' }))
    return result.warnings
  }

  it('flags the observed schema-capitulation junk (placeholder summary + 1-char risk areas)', async () => {
    const warnings = await warningsFor({ summary: 'test', riskAreas: ['a', 'b'] })
    expect(warnings.some((w) => w.includes('degenerate change summary'))).toBe(true)
  })

  it('flags junk riskAreas even when the summary itself is long enough', async () => {
    const warnings = await warningsFor({ summary: 'A real, sufficiently long summary of the change.', riskAreas: ['a', 'b'] })
    expect(warnings.some((w) => w.includes('degenerate change summary'))).toBe(true)
  })

  it('does not flag a healthy change summary', async () => {
    const warnings = await warningsFor({
      summary: 'Adds copy buttons across the inspector panels.',
      riskAreas: ['clipboard fallback', 'replay fold gating'],
    })
    expect(warnings.some((w) => w.includes('degenerate change summary'))).toBe(false)
  })

  it('does not flag an empty riskAreas list (legit for a low-risk docs change)', async () => {
    const warnings = await warningsFor({ summary: 'Updates the README quickstart section.', riskAreas: [] })
    expect(warnings.some((w) => w.includes('degenerate change summary'))).toBe(false)
  })
})
