import { describe, it, expect } from 'vitest'
import { BEST_MODEL, FakeRuntime } from '@workflow-toolbox/runtime'
import { adversarialVerification } from '../src/adversarial-verification.js'
import type { AdversarialVerificationOptions, VerifierVote, Verdict, ClaimVerdict } from '../src/adversarial-verification.js'
// Convention: new public types must also be re-exported from the package index.
import type { ClaimVerdict as IndexClaimVerdict } from '../src/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(
  overrides: Partial<AdversarialVerificationOptions<string>> = {},
): AdversarialVerificationOptions<string> {
  return {
    claims: ['claim-0', 'claim-1', 'claim-2'],
    renderClaim: (c) => c,
    ...overrides,
  }
}

const confirmedVote: VerifierVote = { verdict: 'confirmed', reason: 'ok' }
const refutedVote: VerifierVote = { verdict: 'refuted', reason: 'bad' }
const partialVote: VerifierVote = { verdict: 'partially-confirmed', reason: 'mixed' }
const unverifiableVote: VerifierVote = { verdict: 'unverifiable', reason: 'unknown' }

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('adversarialVerification — config validation', () => {
  it('rejects when claims is empty', async () => {
    const rt = new FakeRuntime()
    await expect(
      adversarialVerification(rt, makeOptions({ claims: [] })),
    ).rejects.toThrow(/empty claims/)
  })

  it('rejects when votes < 1', async () => {
    const rt = new FakeRuntime()
    await expect(
      adversarialVerification(rt, makeOptions({ votes: 0 })),
    ).rejects.toThrow(/votes.*>=.*1/)
  })

  it('rejects when refuteThreshold < 1', async () => {
    const rt = new FakeRuntime()
    await expect(
      adversarialVerification(rt, makeOptions({ refuteThreshold: 0 })),
    ).rejects.toThrow(/refuteThreshold.*>=.*1/)
  })

  it('rejects when refuteThreshold > votes', async () => {
    const rt = new FakeRuntime()
    await expect(
      adversarialVerification(rt, makeOptions({ votes: 2, refuteThreshold: 3 })),
    ).rejects.toThrow(/refuteThreshold.*>.*votes/)
  })

  it('rejects when lenses.length !== votes', async () => {
    const rt = new FakeRuntime()
    await expect(
      adversarialVerification(rt, makeOptions({ votes: 3, lenses: ['a', 'b'] })),
    ).rejects.toThrow(/lenses.*length.*votes/)
  })

  it('rejects when maxVerifyClaims < 1', async () => {
    const rt = new FakeRuntime()
    await expect(
      adversarialVerification(rt, makeOptions({ maxVerifyClaims: 0 })),
    ).rejects.toThrow(/maxVerifyClaims.*>=.*1/)
  })
})

// ---------------------------------------------------------------------------
// Happy path — all confirmed
// ---------------------------------------------------------------------------

describe('adversarialVerification — all confirmed', () => {
  it('returns confirmed verdict, exact stats, empty warnings', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0', 'c1'],
      votes: 3,
      refuteThreshold: 2,
    }))

    expect(result.warnings).toHaveLength(0)
    // itemsIn = itemsOut always (claims never dropped)
    expect(result.stats.itemsIn).toBe(2)
    expect(result.stats.itemsOut).toBe(2)
    expect(result.stats.dropped).toBe(0)
    expect(result.stats.truncated).toBe(0)
    // 2 claims × 3 votes each = 6 agents
    expect(result.stats.agentsSpawned).toBe(6)

    for (const verified of result.value) {
      expect(verified.verdict).toBe('confirmed')
      expect(verified.votes).toHaveLength(3)
    }
  })
})

// ---------------------------------------------------------------------------
// Tally matrix — refute threshold kills claim
// ---------------------------------------------------------------------------

describe('adversarialVerification — tally: refuted', () => {
  it('marks claim refuted when refuteThreshold met (2 of 3 refuted)', async () => {
    let callCount = 0
    const rt = new FakeRuntime({
      onAgent: () => {
        callCount++
        // First 2 votes: refuted, third: confirmed
        return callCount % 3 === 0 ? confirmedVote : refutedVote
      },
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 3,
      refuteThreshold: 2,
    }))

    expect(result.value[0]!.verdict).toBe('refuted')
  })
})

// ---------------------------------------------------------------------------
// Tally matrix — mixed → partially-confirmed
// ---------------------------------------------------------------------------

describe('adversarialVerification — tally: partially-confirmed', () => {
  it('marks claim partially-confirmed on mixed votes', async () => {
    let callCount = 0
    const rt = new FakeRuntime({
      onAgent: () => {
        callCount++
        if (callCount === 1) return confirmedVote
        if (callCount === 2) return partialVote
        return refutedVote  // only 1 refuted < threshold 2
      },
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 3,
      refuteThreshold: 2,
    }))

    expect(result.value[0]!.verdict).toBe('partially-confirmed')
  })
})

// ---------------------------------------------------------------------------
// Tally matrix — all null votes → unverifiable
// ---------------------------------------------------------------------------

describe('adversarialVerification — tally: all-null votes → unverifiable', () => {
  it('keeps claim as unverifiable when all verifier agents fail', async () => {
    const rt = new FakeRuntime({
      onAgent: () => null,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 3,
    }))

    expect(result.value[0]!.verdict).toBe('unverifiable')
    // claim is kept, not dropped
    expect(result.stats.itemsIn).toBe(1)
    expect(result.stats.itemsOut).toBe(1)
    // null votes counted as dropped (lost work units)
    expect(result.stats.dropped).toBe(3)
    expect(result.warnings.some(w => w.includes('null'))).toBe(true)
    expect(result.warnings.some(w => w.includes('unverifiable'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Votes contain nulls but some non-null
// ---------------------------------------------------------------------------

describe('adversarialVerification — partial null votes', () => {
  it('tallies only non-null votes, reports null count warning', async () => {
    let callCount = 0
    const rt = new FakeRuntime({
      onAgent: () => {
        callCount++
        // vote index 1 (second vote per claim) returns null
        if (callCount % 3 === 2) return null
        return confirmedVote
      },
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 3,
    }))

    // 2 non-null confirmed → confirmed
    expect(result.value[0]!.verdict).toBe('confirmed')
    // 1 null vote
    expect(result.stats.dropped).toBe(1)
    expect(result.warnings.some(w => w.includes('null'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cap — truncated claims kept as unverified-by-cap
// ---------------------------------------------------------------------------

describe('adversarialVerification — cap truncation', () => {
  it('truncated claims appear in output as unverified-by-cap with empty votes', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0', 'c1', 'c2', 'c3', 'c4'],
      votes: 2,
      maxVerifyClaims: 2,
    }))

    expect(result.stats.itemsIn).toBe(5)
    expect(result.stats.itemsOut).toBe(5)    // claims NEVER dropped
    expect(result.stats.truncated).toBe(3)
    expect(result.value).toHaveLength(5)

    // First 2: verified (confirmed)
    expect(result.value[0]!.verdict).toBe('confirmed')
    expect(result.value[1]!.verdict).toBe('confirmed')

    // Last 3: unverified-by-cap with empty votes — cap-truncated claims are
    // nominally distinct from 'unverifiable' (all-verifiers-failed) claims.
    for (const v of result.value.slice(2)) {
      expect(v.verdict).toBe('unverified-by-cap')
      expect(v.votes).toHaveLength(0)
    }

    expect(result.warnings.some(w => w.includes('truncated') && w.includes('maxVerifyClaims'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Regression: 'unverified-by-cap' vs 'unverifiable' in ONE run.
//
// Before ClaimVerdict, the cap-truncation append reused the agent-facing
// 'unverifiable' verdict, conflating "we never tested this claim" (cap cut it,
// votes: []) with "we tested it and could not decide" (all verifiers failed,
// votes: non-empty array of nulls). The distinction was already STRUCTURAL
// (empty vs non-empty votes); ClaimVerdict makes it NOMINAL so summary tallies
// keyed on the verdict string stop merging the two states.
// ---------------------------------------------------------------------------

describe('adversarialVerification — cap-truncated vs all-verifiers-failed distinction', () => {
  it('reports unverified-by-cap for cap-cut claims and unverifiable for all-null claims in the same run', async () => {
    // 4 claims, cap = 2: c0 and c1 are verified, c2 and c3 are cap-cut.
    // c0's verifiers succeed (confirmed); c1's verifiers ALL return null.
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        // claim index 1 → every verifier fails
        if (label.startsWith('adversarialVerification:verify:1:')) return null
        return confirmedVote
      },
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0', 'c1', 'c2', 'c3'],
      votes: 2,
      maxVerifyClaims: 2,
    }))

    // itemsIn === itemsOut — claims are never dropped (§8)
    expect(result.stats.itemsIn).toBe(4)
    expect(result.stats.itemsOut).toBe(4)
    expect(result.value).toHaveLength(4)

    // c0: verified normally
    expect(result.value[0]!.verdict).toBe('confirmed')
    expect(result.value[0]!.votes).toHaveLength(2)

    // c1: kept-but-failed — tested, could not decide → 'unverifiable',
    // votes is a NON-EMPTY array of nulls (the structural marker).
    expect(result.value[1]!.verdict).toBe('unverifiable')
    expect(result.value[1]!.votes).toEqual([null, null])

    // c2/c3: cap-cut — never tested → 'unverified-by-cap', votes: [] (empty).
    for (const v of result.value.slice(2)) {
      expect(v.verdict).toBe('unverified-by-cap')
      expect(v.votes).toHaveLength(0)
    }

    // stats: truncated counts cap-cut CLAIMS; dropped counts null VOTES
    expect(result.stats.truncated).toBe(2)
    expect(result.stats.dropped).toBe(2)

    // Truncated claims get NO trail records: trail.length === agentsSpawned
    // (2 kept claims × 2 votes = 4) and no stage references claim 2 or 3.
    expect(result.trail).toHaveLength(result.stats.agentsSpawned)
    expect(result.trail).toHaveLength(4)
    expect(result.trail!.some(r => r.stage.startsWith('adversarialVerification:verify:2:'))).toBe(false)
    expect(result.trail!.some(r => r.stage.startsWith('adversarialVerification:verify:3:'))).toBe(false)

    // Both warning vocabularies surface in the same run:
    // - the truncation warning keeps its 'truncated' + 'maxVerifyClaims' substrings
    // - the all-verifiers-failed warning keeps its 'unverifiable' substring
    expect(result.warnings.some(w => w.includes('truncated') && w.includes('maxVerifyClaims'))).toBe(true)
    expect(result.warnings.some(w => w.includes('unverifiable'))).toBe(true)

    // Backward compat: callers keying on 'refuted' see zero behavior change.
    expect(result.value.filter(v => v.verdict === 'refuted')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// ClaimVerdict type contract — pinned at typecheck time (pnpm typecheck).
// Verdict stays the agent-facing 4-value union; ClaimVerdict widens it with
// the pattern-only 'unverified-by-cap'. Both the pattern module and the
// package index must export ClaimVerdict (new-public-type convention).
// ---------------------------------------------------------------------------

describe('adversarialVerification — ClaimVerdict type export', () => {
  it('ClaimVerdict accepts the 4 agent verdicts plus unverified-by-cap, and VerifiedClaim.verdict is a ClaimVerdict', async () => {
    // Type-level pins (compile errors = RED at pnpm typecheck):
    const fromPattern: ClaimVerdict = 'unverified-by-cap'
    const fromIndex: IndexClaimVerdict = 'unverified-by-cap'
    const widened: ClaimVerdict = 'refuted' as Verdict // Verdict assignable to ClaimVerdict
    expect([fromPattern, fromIndex, widened]).toBeDefined()

    // VerifiedClaim.verdict must be typed as ClaimVerdict (not the narrower
    // Verdict) so cap-truncated rows are representable without casts.
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })
    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0', 'c1'],
      votes: 1,
      refuteThreshold: 1,
      maxVerifyClaims: 1,
    }))
    const verdict: ClaimVerdict = result.value[1]!.verdict
    expect(verdict).toBe('unverified-by-cap')
  })
})

// ---------------------------------------------------------------------------
// Lenses appear in prompts
// ---------------------------------------------------------------------------

describe('adversarialVerification — lenses', () => {
  it('includes lens in verifier prompt', async () => {
    const capturedPrompts: string[] = []
    const rt = new FakeRuntime({
      onAgent: ({ prompt }) => {
        capturedPrompts.push(prompt)
        return confirmedVote
      },
    })

    await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 2,
      lenses: ['technical', 'ethical'],
    }))

    expect(capturedPrompts[0]!).toContain('technical')
    expect(capturedPrompts[1]!).toContain('ethical')
  })

  it('rejects when lenses length mismatches votes', async () => {
    const rt = new FakeRuntime()
    await expect(
      adversarialVerification(rt, makeOptions({ votes: 3, lenses: ['a'] })),
    ).rejects.toThrow(/lenses.*length.*votes/)
  })
})

// ---------------------------------------------------------------------------
// Model sensitivity — default is BEST_MODEL
// ---------------------------------------------------------------------------

describe('adversarialVerification — model', () => {
  it('defaults to BEST_MODEL (fable) on verifier calls', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    await adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1 }))

    expect(BEST_MODEL).toBe('fable')
    expect(rt.calls[0]!.opts?.model).toBe(BEST_MODEL)
  })

  it('does not warn when BEST_MODEL is passed explicitly', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 1,
      refuteThreshold: 1,
      model: BEST_MODEL,
    }))

    expect(result.warnings).toHaveLength(0)
    expect(rt.calls[0]!.opts?.model).toBe(BEST_MODEL)
  })

  it('warns when opus (no longer best) is specified explicitly', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 1,
      refuteThreshold: 1,
      model: 'opus',
    }))

    expect(result.warnings.some(w => w.includes('downgraded') && w.includes('opus'))).toBe(true)
    // model still forwarded as specified
    expect(rt.calls[0]!.opts?.model).toBe('opus')
  })

  it('emits downgrade warning when non-best model specified', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 1,
      refuteThreshold: 1,
      model: 'sonnet',
    }))

    expect(result.warnings.some(w => w.includes('downgraded') && w.includes('sonnet'))).toBe(true)
    expect(rt.logs.some(l => l.includes('downgraded') && l.includes('sonnet'))).toBe(true)
    // model still forwarded as specified
    expect(rt.calls[0]!.opts?.model).toBe('sonnet')
  })
})

// ---------------------------------------------------------------------------
// Control schema shape
// ---------------------------------------------------------------------------

describe('adversarialVerification — control schema', () => {
  it('forwards owned verdict schema to all verifier calls', async () => {
    let capturedSchema: unknown = null
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        capturedSchema = opts?.schema
        return confirmedVote
      },
    })

    await adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1 }))

    expect(capturedSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        verdict: expect.objectContaining({
          enum: expect.arrayContaining(['confirmed', 'refuted', 'partially-confirmed', 'unverifiable']),
        }),
        reason: { type: 'string' },
      }),
      required: expect.arrayContaining(['verdict', 'reason']),
      additionalProperties: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Phase forwarding
// ---------------------------------------------------------------------------

describe('adversarialVerification — phase forwarding', () => {
  it('forwards phase to all verifier calls', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 2,
      phase: 'verify-phase',
    }))

    expect(rt.calls.every(c => c.phase === 'verify-phase')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe('adversarialVerification — labels', () => {
  it('assigns correct label shape adversarialVerification:verify:<claimIdx>:<voteIdx>', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    await adversarialVerification(rt, makeOptions({
      claims: ['c0', 'c1'],
      votes: 2,
    }))

    const labels = rt.calls.map(c => c.opts?.label)
    expect(labels).toContain('adversarialVerification:verify:0:0')
    expect(labels).toContain('adversarialVerification:verify:0:1')
    expect(labels).toContain('adversarialVerification:verify:1:0')
    expect(labels).toContain('adversarialVerification:verify:1:1')
  })
})

// ---------------------------------------------------------------------------
// Verifier prompt is refute-first (owns the framing)
// ---------------------------------------------------------------------------

describe('adversarialVerification — prompt framing', () => {
  it('includes adversarial refute-first instruction in prompt', async () => {
    const capturedPrompts: string[] = []
    const rt = new FakeRuntime({
      onAgent: ({ prompt }) => {
        capturedPrompts.push(prompt)
        return confirmedVote
      },
    })

    await adversarialVerification(rt, makeOptions({
      claims: ['my-claim'],
      votes: 1,
      refuteThreshold: 1,
      renderClaim: (c) => c,
    }))

    expect(capturedPrompts[0]!).toContain('REFUTE')
    expect(capturedPrompts[0]!).toContain('my-claim')
  })
})

// ---------------------------------------------------------------------------
// unverifiableVote verdict passthrough
// ---------------------------------------------------------------------------

describe('adversarialVerification — unverifiable vote', () => {
  it('handles unverifiable votes in tally (not refuted, not all-confirmed → partially-confirmed)', async () => {
    let callCount = 0
    const rt = new FakeRuntime({
      onAgent: () => {
        callCount++
        if (callCount === 1) return confirmedVote
        return unverifiableVote
      },
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 2,
      refuteThreshold: 2,
    }))

    // 1 confirmed + 1 unverifiable → not all confirmed → partially-confirmed
    expect(result.value[0]!.verdict).toBe('partially-confirmed')
  })
})

// ---------------------------------------------------------------------------
// Audit trail — B2b additions
// ---------------------------------------------------------------------------

describe('adversarialVerification — trail: happy path', () => {
  it('returns defined trail with correct count, order, stages, outcomes', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0', 'c1'],
      votes: 2,
      refuteThreshold: 2,
    }))

    expect(result.trail).toBeDefined()
    const trail = result.trail!

    // invariant: trail.length === agentsSpawned (2 claims × 2 votes = 4)
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(4)

    // Records in claim-index outer, vote-index inner order (deterministic, post-barrier)
    expect(trail[0]!.stage).toBe('adversarialVerification:verify:0:0')
    expect(trail[0]!.outcome).toBe('ok')
    expect(trail[1]!.stage).toBe('adversarialVerification:verify:0:1')
    expect(trail[1]!.outcome).toBe('ok')
    expect(trail[2]!.stage).toBe('adversarialVerification:verify:1:0')
    expect(trail[2]!.outcome).toBe('ok')
    expect(trail[3]!.stage).toBe('adversarialVerification:verify:1:1')
    expect(trail[3]!.outcome).toBe('ok')
  })

  it('records decision = verdict enum value on each verifier record', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 1,
      refuteThreshold: 1,
    }))

    const trail = result.trail!
    expect(trail[0]!.decision).toBe('confirmed')
  })

  it('records the correct verdict as decision for each verifier outcome', async () => {
    let callCount = 0
    const rt = new FakeRuntime({
      onAgent: () => {
        callCount++
        if (callCount === 1) return confirmedVote
        if (callCount === 2) return refutedVote
        return partialVote
      },
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 3,
      refuteThreshold: 2,
    }))

    const trail = result.trail!
    expect(trail[0]!.decision).toBe('confirmed')
    expect(trail[1]!.decision).toBe('refuted')
    expect(trail[2]!.decision).toBe('partially-confirmed')
  })
})

describe('adversarialVerification — trail: model field', () => {
  it('records model on every verifier record even without explicit override (BEST_MODEL default is explicitly passed)', async () => {
    // adversarialVerification always passes effectiveModel (BEST_MODEL when no
    // override), so model is always present in the trail — this is intentional
    // and documented.
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 1,
      refuteThreshold: 1,
    }))

    const trail = result.trail!
    expect(trail[0]!.model).toBe(BEST_MODEL)
  })

  it('records explicit model override on verifier records', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 1,
      refuteThreshold: 1,
      model: 'sonnet',
    }))

    const trail = result.trail!
    expect(trail[0]!.model).toBe('sonnet')
  })
})

describe('adversarialVerification — trail: null verifier records', () => {
  it('records outcome=null at correct index for null verifier, invariant holds', async () => {
    let callCount = 0
    const rt = new FakeRuntime({
      onAgent: () => {
        callCount++
        if (callCount === 2) return null  // vote:1 of claim:0 returns null
        return confirmedVote
      },
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 3,
      refuteThreshold: 2,
    }))

    expect(result.trail).toBeDefined()
    const trail = result.trail!

    // invariant: 1 claim × 3 votes = 3
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(3)

    expect(trail[0]!.outcome).toBe('ok')
    expect(trail[1]!.outcome).toBe('null')   // vote index 1 was null
    expect(trail[1]!.decision).toBeUndefined()  // null agent → no decision
    expect(trail[2]!.outcome).toBe('ok')
  })

  it('records outcome=null for all-null verifier agents (unverifiable claim), invariant holds', async () => {
    const rt = new FakeRuntime({
      onAgent: () => null,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 3,
    }))

    expect(result.trail).toBeDefined()
    const trail = result.trail!

    // invariant: 1 claim × 3 votes = 3
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(3)

    for (const rec of trail) {
      expect(rec.outcome).toBe('null')
      expect(rec).not.toHaveProperty('decision')
    }
  })

  it('covers full index space [0..votes) including null results in order', async () => {
    // claim:0, votes 3: all null → 3 records in order 0:0, 0:1, 0:2
    const rt = new FakeRuntime({
      onAgent: () => null,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 3,
    }))

    const trail = result.trail!
    expect(trail[0]!.stage).toBe('adversarialVerification:verify:0:0')
    expect(trail[1]!.stage).toBe('adversarialVerification:verify:0:1')
    expect(trail[2]!.stage).toBe('adversarialVerification:verify:0:2')
  })
})

describe('adversarialVerification — trail: determinism', () => {
  it('produces identical trail on two runs of the same scenario', async () => {
    const makeRt = () => new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const opts = makeOptions({ claims: ['c0', 'c1'], votes: 2 })
    const resultA = await adversarialVerification(makeRt(), opts)
    const resultB = await adversarialVerification(makeRt(), opts)

    expect(resultA.trail).toEqual(resultB.trail)
  })

  it('orders trail by claim index even when claim groups complete out of order', async () => {
    // Regression: records were pushed from inside each claim's async callback,
    // so claim COMPLETION order (non-deterministic in the real runtime) leaked
    // into the trail. FakeRuntime resolves synchronously and masked it — this
    // test forces claim 0's verifiers to finish AFTER claim 1's.
    const rt = new FakeRuntime({
      onAgent: async ({ opts: agentOpts }) => {
        if ((agentOpts?.label ?? '').includes(':verify:0:')) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return confirmedVote
      },
    })

    const result = await adversarialVerification(rt, makeOptions({ claims: ['c0', 'c1'], votes: 2 }))

    expect(result.trail?.map((r) => r.stage)).toEqual([
      'adversarialVerification:verify:0:0',
      'adversarialVerification:verify:0:1',
      'adversarialVerification:verify:1:0',
      'adversarialVerification:verify:1:1',
    ])
  })
})

// ---------------------------------------------------------------------------
// Tally boundary: refuteThreshold === votes (review L3)
// ---------------------------------------------------------------------------

describe('adversarialVerification — refuteThreshold === votes boundary', () => {
  it('refutes only when ALL votes are refuted (threshold = votes)', async () => {
    const rt = new FakeRuntime({
      responses: [refutedVote, refutedVote, refutedVote],
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c'],
      votes: 3,
      refuteThreshold: 3,
    }))

    expect(result.value[0]?.verdict).toBe('refuted')
  })

  it('does not refute at threshold-minus-one refutes (2 of 3, threshold 3)', async () => {
    const rt = new FakeRuntime({
      responses: [refutedVote, refutedVote, confirmedVote],
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c'],
      votes: 3,
      refuteThreshold: 3,
    }))

    // Not refuted (threshold not met), not all-confirmed → partially-confirmed
    expect(result.value[0]?.verdict).toBe('partially-confirmed')
  })
})

// ---------------------------------------------------------------------------
// votesPerClaim — per-claim vote counts (severity-aware votes, F7)
// ---------------------------------------------------------------------------

describe('adversarialVerification — votesPerClaim mechanics', () => {
  it('varies the agent count per claim', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['a', 'b'],
      votesPerClaim: (c) => (c === 'a' ? 1 : 3),
    }))

    expect(result.stats.agentsSpawned).toBe(4)
    expect(result.value[0]?.votes).toHaveLength(1)
    expect(result.value[1]?.votes).toHaveLength(3)
    const labels = rt.calls.map((c) => c.opts?.label ?? '')
    expect(labels).toHaveLength(4)
    expect(labels).toEqual(expect.arrayContaining([
      'adversarialVerification:verify:0:0',
      'adversarialVerification:verify:1:0',
      'adversarialVerification:verify:1:1',
      'adversarialVerification:verify:1:2',
    ]))
  })

  it('falls back to the scalar votes when votesPerClaim is absent', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['a', 'b'],
      votes: 2,
    }))

    expect(result.stats.agentsSpawned).toBe(4)
    for (const verified of result.value) expect(verified.votes).toHaveLength(2)
  })

  it('is evaluated exactly once per claim', async () => {
    let evaluations = 0
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    await adversarialVerification(rt, makeOptions({
      claims: ['a', 'b', 'c'],
      votesPerClaim: () => {
        evaluations++
        return 1
      },
    }))

    expect(evaluations).toBe(3)
  })

  it('keeps trail.length === agentsSpawned with variable votes', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['a', 'b'],
      votesPerClaim: (c) => (c === 'a' ? 1 : 2),
    }))

    expect(result.stats.agentsSpawned).toBe(3)
    expect(result.trail).toHaveLength(3)
    expect(result.trail.map((r) => r.stage)).toEqual([
      'adversarialVerification:verify:0:0',
      'adversarialVerification:verify:1:0',
      'adversarialVerification:verify:1:1',
    ])
  })
})

describe('adversarialVerification — votesPerClaim validation', () => {
  it('throws on a non-integer count', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    await expect(adversarialVerification(rt, makeOptions({
      claims: ['a'],
      votesPerClaim: () => 1.5,
    }))).rejects.toThrow(/votesPerClaim.*claims\[0\].*integer >= 1/)
    expect(rt.agentsSpawned).toBe(0)
  })

  it('throws on a count < 1', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    await expect(adversarialVerification(rt, makeOptions({
      claims: ['a'],
      votesPerClaim: () => 0,
    }))).rejects.toThrow(/votesPerClaim.*integer >= 1/)
    expect(rt.agentsSpawned).toBe(0)
  })

  it('names the offending claim index', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    await expect(adversarialVerification(rt, makeOptions({
      claims: ['ok', 'bad'],
      votesPerClaim: (c) => (c === 'ok' ? 3 : 0),
    }))).rejects.toThrow(/claims\[1\]/)
    expect(rt.agentsSpawned).toBe(0)
  })

  it('validates ALL claims before any agent spawns', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    // claims[0] and [1] are valid; only claims[2] is bad — still zero spawns.
    await expect(adversarialVerification(rt, makeOptions({
      claims: ['a', 'b', 'bad'],
      votesPerClaim: (c) => (c === 'bad' ? -1 : 2),
    }))).rejects.toThrow(/claims\[2\]/)
    expect(rt.agentsSpawned).toBe(0)
  })

  it('throws when combined with lenses', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    await expect(adversarialVerification(rt, makeOptions({
      claims: ['a'],
      lenses: ['x', 'y', 'z'],
      votesPerClaim: () => 1,
    }))).rejects.toThrow(/lenses cannot be combined with votesPerClaim/)
    expect(rt.agentsSpawned).toBe(0)
  })
})

describe('adversarialVerification — 1-vote tally semantics', () => {
  // effectiveThreshold = min(refuteThreshold=2 default, claimVotes=1) = 1:
  // the single vote decides; the raw scalar threshold must NOT be used.

  it('single refuted vote → refuted (threshold clamped to the claim votes)', async () => {
    const rt = new FakeRuntime({ responses: [refutedVote] })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c'],
      votesPerClaim: () => 1,
    }))

    expect(result.stats.agentsSpawned).toBe(1)
    expect(result.value[0]?.verdict).toBe('refuted')
  })

  it('single confirmed vote → confirmed', async () => {
    const rt = new FakeRuntime({ responses: [confirmedVote] })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c'],
      votesPerClaim: () => 1,
    }))

    expect(result.value[0]?.verdict).toBe('confirmed')
  })

  it('single partially-confirmed vote → partially-confirmed', async () => {
    const rt = new FakeRuntime({ responses: [partialVote] })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c'],
      votesPerClaim: () => 1,
    }))

    expect(result.value[0]?.verdict).toBe('partially-confirmed')
  })

  it('single unverifiable vote (non-null) → partially-confirmed', async () => {
    const rt = new FakeRuntime({ responses: [unverifiableVote] })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c'],
      votesPerClaim: () => 1,
    }))

    // Tested but undecided: non-null, not refuted, not all-confirmed.
    expect(result.value[0]?.verdict).toBe('partially-confirmed')
  })

  it('single null vote → unverifiable, counted in the all-null warning', async () => {
    const rt = new FakeRuntime({ onAgent: () => null })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c'],
      votesPerClaim: () => 1,
    }))

    expect(result.value[0]?.verdict).toBe('unverifiable')
    expect(result.stats.dropped).toBe(1)
    // The all-null detection must compare against the CLAIM's own vote count
    // (1), not the scalar votes default (3).
    expect(result.warnings.some((w) => w.includes('left unverifiable'))).toBe(true)
  })
})

describe('adversarialVerification — votesPerClaim mixed-count tallies', () => {
  it('claims with different vote counts tally independently', async () => {
    // Route votes by label so the assertion is independent of claim
    // completion order: claim0 (3 votes) gets 2 refuted → refuted;
    // claim1 (1 vote) gets confirmed → confirmed; claim2 (3 votes) all
    // confirmed → confirmed.
    const byLabel: Record<string, VerifierVote> = {
      'adversarialVerification:verify:0:0': refutedVote,
      'adversarialVerification:verify:0:1': refutedVote,
      'adversarialVerification:verify:0:2': confirmedVote,
      'adversarialVerification:verify:1:0': confirmedVote,
      'adversarialVerification:verify:2:0': confirmedVote,
      'adversarialVerification:verify:2:1': confirmedVote,
      'adversarialVerification:verify:2:2': confirmedVote,
    }
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => byLabel[opts?.label ?? ''] ?? confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['kill-me', 'solo', 'fine'],
      votesPerClaim: (c) => (c === 'solo' ? 1 : 3),
    }))

    expect(result.stats.agentsSpawned).toBe(7)
    expect(result.value.map((v) => v.verdict)).toEqual(['refuted', 'confirmed', 'confirmed'])
  })

  it('default path is unchanged when votesPerClaim is absent (drift guard)', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0', 'c1'],
    }))

    // Exactly today's defaults: 2 claims × 3 votes, all confirmed.
    expect(result.stats.agentsSpawned).toBe(6)
    expect(result.value.map((v) => v.verdict)).toEqual(['confirmed', 'confirmed'])
    expect(result.warnings).toHaveLength(0)
    expect(result.trail).toHaveLength(6)
  })
})

describe('adversarialVerification — votesPerClaim × maxVerifyClaims', () => {
  it('is invoked for ALL input claims (incl. cap-cut); counts are used only for kept claims', async () => {
    const seen: string[] = []
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['k0', 'k1', 't0', 't1'],
      maxVerifyClaims: 2,
      votesPerClaim: (c) => {
        seen.push(c)
        return c === 'k0' ? 1 : 2
      },
    }))

    // Validation is pre-cap: the mapping is checked for every input claim.
    expect(seen).toEqual(['k0', 'k1', 't0', 't1'])
    // Spawns only for the kept prefix: k0 (1 vote) + k1 (2 votes).
    expect(result.stats.agentsSpawned).toBe(3)
    expect(result.stats.truncated).toBe(2)
    expect(result.value[2]?.verdict).toBe('unverified-by-cap')
    expect(result.value[3]?.verdict).toBe('unverified-by-cap')
    expect(result.value[2]?.votes).toHaveLength(0)
  })
})
