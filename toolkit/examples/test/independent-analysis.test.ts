// independent-analysis.test.ts — end-to-end composition test for the
// independent-analysis workflow. Uses FakeRuntime with an onAgent handler that
// routes on UNIQUE phrases from the actual workflow prompts, in priority order:
//   1. Verifier:  "an independent multi-lens sweep proposes" (renderClaim, most specific)
//   2. Synthesis: "you are the synthesis agent"
//   3. Analyst:   "you are an independent analyst"
//   4. Lenses:    "propose exactly" (auto-lens proposal, only when no lenses given)
// Order matters: the verifier and analyst prompts both contain "independent",
// so the more-specific verifier phrase is checked first.

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf from '../independent-analysis.workflow.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Verdict = 'confirmed' | 'partially-confirmed' | 'refuted'

/**
 * A FakeRuntime that walks the full Lenses(optional) → Analyze → Verify flow.
 * `verdict` controls what every verifier vote returns; `candidates` controls
 * what the synthesis agent emits (default: one high + one low candidate).
 */
function makeRuntime(opts: {
  verdict?: Verdict
  candidates?: Array<{ title: string; lens: string; severity: 'high' | 'medium' | 'low' }>
} = {}): FakeRuntime {
  const verdict = opts.verdict ?? 'confirmed'
  const candidates =
    opts.candidates ??
    [
      { title: 'Unhandled null on the hot path', lens: 'correctness', severity: 'high' as const },
      { title: 'Log line leaks a token prefix', lens: 'security', severity: 'low' as const },
    ]

  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt.toLowerCase()

      // (1) Verifier — pattern embeds renderClaim; this phrase is verifier-only.
      if (p.includes('an independent multi-lens sweep proposes')) {
        return { verdict, reason: `vote: ${verdict}` }
      }

      // (2) Synthesis — deduped candidate list.
      if (p.includes('you are the synthesis agent')) {
        return {
          candidates: candidates.map((c) => ({
            title: c.title,
            lens: c.lens,
            why: `why ${c.title}`,
            severity: c.severity,
            kind: 'risk',
          })),
        }
      }

      // (3) Analyst — one angle per lens.
      if (p.includes('you are an independent analyst')) {
        return {
          angles: [
            {
              title: 'Raw angle from a lens',
              why: 'because the subject overlooks it',
              severity: 'high',
              kind: 'risk',
              alreadyKnown: false,
            },
          ],
        }
      }

      // (4) Auto lens proposal (only when no explicit lenses were passed).
      if (p.includes('propose exactly')) {
        return {
          lenses: [
            { key: 'correctness', focus: 'hunt for logic errors' },
            { key: 'security', focus: 'hunt for unsafe data handling' },
          ],
        }
      }

      return null
    },
  })
}

const baseInput = {
  subject: 'A change that bumps a default and promotes a workflow',
  lenses: ['correctness', 'security'],
  assumptions: ['The build gate is green'],
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe('independent-analysis workflow metadata', () => {
  it('has the correct name and phases', () => {
    expect(wf.meta.name).toBe('independent-analysis')
    expect(wf.meta.description).toBeTruthy()
    const titles = wf.meta.phases?.map((p) => p.title)
    expect(titles).toEqual(['Lenses', 'Analyze', 'Verify'])
  })
})

// ---------------------------------------------------------------------------
// parseInput / fail-fast validation
// ---------------------------------------------------------------------------

describe('independent-analysis parseInput', () => {
  it('throws an actionable error when subject is missing', async () => {
    const rt = makeRuntime()
    await expect(wf.run(rt, JSON.stringify({ context: 'no subject here' }))).rejects.toThrow(
      /subject/,
    )
  })

  it('throws for an empty subject string', async () => {
    const rt = makeRuntime()
    await expect(wf.run(rt, JSON.stringify({ subject: '   ' }))).rejects.toThrow(/subject/)
  })

  it('throws for a non-object input', async () => {
    const rt = makeRuntime()
    await expect(wf.run(rt, JSON.stringify('just a string'))).rejects.toThrow(/subject|object/)
  })

  it('rejects an out-of-set verifierModel', async () => {
    const rt = makeRuntime()
    await expect(
      wf.run(rt, JSON.stringify({ ...baseInput, verifierModel: 'gpt-5' })),
    ).rejects.toThrow(/verifierModel/)
  })

  it("accepts verifierModel 'opus' (the current BEST_MODEL)", async () => {
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify({ ...baseInput, verifierModel: 'opus' }))
    expect(result).toHaveProperty('confirmed')
  })

  it("still accepts verifierModel 'fable' as a valid alias (suspended, returns later)", async () => {
    // The reorder put 'fable' last in MODEL_ALIASES but did NOT remove it — it
    // stays a typed, validatable alias for when the suspension lifts.
    const rt = makeRuntime()
    const result = await wf.run(rt, JSON.stringify({ ...baseInput, verifierModel: 'fable' }))
    expect(result).toHaveProperty('confirmed')
  })
})

// ---------------------------------------------------------------------------
// Happy path — explicit lenses (no proposal agent)
// ---------------------------------------------------------------------------

describe('independent-analysis happy path', () => {
  it('returns the full envelope shape with confirmed findings', async () => {
    const rt = makeRuntime({ verdict: 'confirmed' })
    const result = await wf.run(rt, JSON.stringify(baseInput))

    expect(result).toHaveProperty('subject', baseInput.subject)
    expect(result).toHaveProperty('lensesUsed')
    expect(result).toHaveProperty('confirmed')
    expect(result).toHaveProperty('refuted')
    expect(result).toHaveProperty('allVerified')
    expect(result).toHaveProperty('candidateCount')
    expect(result).toHaveProperty('stats')
    expect(result).toHaveProperty('warnings')

    // Explicit lenses are used verbatim as keys.
    expect(result.lensesUsed).toEqual(['correctness', 'security'])

    // Both candidates verified as real → confirmed, none refuted.
    expect(result.candidateCount).toBe(2)
    expect(result.confirmed.length).toBe(2)
    expect(result.refuted.length).toBe(0)
    for (const c of result.confirmed) {
      expect(['confirmed', 'partially-confirmed']).toContain(c.verdict)
    }
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  it('does not spawn the lens-proposal agent when lenses are explicit', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(baseInput))
    const proposed = rt.calls.some((c) => c.prompt.toLowerCase().includes('propose exactly'))
    expect(proposed).toBe(false)
  })

  it('low-severity candidates get a single verifier vote (votesPerClaim)', async () => {
    // high candidate → 3 votes, low candidate → 1 vote ⇒ 4 verifier calls total.
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify(baseInput))
    const verifierCalls = rt.calls.filter((c) =>
      c.prompt.toLowerCase().includes('an independent multi-lens sweep proposes'),
    )
    expect(verifierCalls.length).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Auto-proposed lenses path
// ---------------------------------------------------------------------------

describe('independent-analysis auto lens proposal', () => {
  it('proposes lenses when none are provided', async () => {
    const rt = makeRuntime()
    const result = await wf.run(
      rt,
      JSON.stringify({ subject: baseInput.subject, lensCount: 2 }),
    )
    const proposed = rt.calls.some((c) => c.prompt.toLowerCase().includes('propose exactly'))
    expect(proposed).toBe(true)
    expect(result.lensesUsed).toEqual(['correctness', 'security'])
  })
})

// ---------------------------------------------------------------------------
// Refutation — a refuted candidate lands in `refuted`, not `confirmed`
// ---------------------------------------------------------------------------

describe('independent-analysis refutation', () => {
  it('routes refuted candidates to `refuted` and excludes them from `confirmed`', async () => {
    const rt = makeRuntime({ verdict: 'refuted' })
    const result = await wf.run(rt, JSON.stringify(baseInput))

    expect(result.confirmed.length).toBe(0)
    expect(result.refuted.length).toBeGreaterThan(0)
    for (const r of result.refuted) {
      expect(r).toHaveProperty('title')
      expect(r).toHaveProperty('severity')
      expect(r).toHaveProperty('lens')
    }
  })
})

// ---------------------------------------------------------------------------
// Empty synthesis — no candidates survive → early return with a warning
// ---------------------------------------------------------------------------

describe('independent-analysis empty synthesis', () => {
  it('returns early with a warning and null verify stats when no candidate survives', async () => {
    const rt = makeRuntime({ candidates: [] })
    const result = await wf.run(rt, JSON.stringify(baseInput))

    expect(result.candidateCount).toBe(0)
    expect(result.confirmed).toEqual([])
    expect(result.refuted).toEqual([])
    expect(result.stats.verify).toBeNull()
    expect(result.warnings.some((w: string) => w.includes('no candidate findings survived'))).toBe(
      true,
    )

    // No verifier agent should run when there is nothing to verify.
    const verifierCalls = rt.calls.filter((c) =>
      c.prompt.toLowerCase().includes('an independent multi-lens sweep proposes'),
    )
    expect(verifierCalls.length).toBe(0)
  })
})
