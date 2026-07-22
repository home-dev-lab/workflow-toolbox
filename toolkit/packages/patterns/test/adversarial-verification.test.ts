import { describe, it, expect } from 'vitest'
import { BEST_MODEL, FakeRuntime, parseDigest } from '@workflow-toolbox/runtime'
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
    // cacheWarm now defaults to TRUE at the pattern level — pin it false here
    // so every PRE-EXISTING test in this file (many of which count agent
    // calls positionally, e.g. via a callCount closure) keeps testing exactly
    // what it always tested, decoupled from the new default.
    cacheWarm: false,
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
      onAgent: ({ opts }) => {
        // This test scripts a REALLY dead vote: its structured-output salvage
        // respawn must fail too (and must not shift callCount's modulo).
        if (opts?.label?.endsWith(':salvage') === true) return null
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
    // (2 kept claims × 2 votes = 4, + 2 salvage respawns for c1's null votes —
    // startsWith('…verify:1:') matches the ':salvage' labels too, so they fail
    // as well) and no stage references claim 2 or 3.
    expect(result.trail).toHaveLength(result.stats.agentsSpawned)
    expect(result.trail).toHaveLength(6)
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
  it('defaults to BEST_MODEL (opus) on verifier calls', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    await adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1 }))

    expect(BEST_MODEL).toBe('opus')
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

  it('warns when fable (suspended, no longer best) is specified explicitly', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 1,
      refuteThreshold: 1,
      model: 'fable',
    }))

    expect(result.warnings.some(w => w.includes('downgraded') && w.includes('fable'))).toBe(true)
    // model still forwarded as specified
    expect(rt.calls[0]!.opts?.model).toBe('fable')
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
// verifierType — specialist subagent routing for the verifier agents.
// v2.2 flexibility knob, NOT a proven quality win: the A/B that motivated the
// family's agentType knobs measured a ~50% false-positive rate on a specialist
// REVIEWER, and a refute-first verifier benefits LESS from domain specialization
// than a producer does ("specialize the producer, not the skeptic"). Routing is
// surfaced via the agent call (opts.agentType); the trail is intentionally not
// extended (kept minimal — see the option's doc comment).
// ---------------------------------------------------------------------------

describe('adversarialVerification — verifierType', () => {
  it('omits agentType on verifier calls when verifierType is not set (standard subagent)', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    await adversarialVerification(rt, makeOptions({ claims: ['c0', 'c1'], votes: 2 }))

    expect(rt.calls.length).toBeGreaterThan(0)
    expect(rt.calls.every(c => c.opts?.agentType === undefined)).toBe(true)
  })

  it('routes every verifier call to the specialist subagent type when set', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    await adversarialVerification(rt, makeOptions({
      claims: ['c0', 'c1'],
      votes: 2,
      verifierType: 'magic-claude:ts-reviewer',
    }))

    expect(rt.calls.length).toBe(4)
    expect(rt.calls.every(c => c.opts?.agentType === 'magic-claude:ts-reviewer')).toBe(true)
  })

  it('rejects an empty verifierType string', async () => {
    const rt = new FakeRuntime()
    await expect(
      adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1, verifierType: '' })),
    ).rejects.toThrow(/verifierType/)
  })

  it('rejects a whitespace-only verifierType string', async () => {
    const rt = new FakeRuntime()
    await expect(
      adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1, verifierType: '   ' })),
    ).rejects.toThrow(/verifierType/)
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
      onAgent: ({ opts }) => {
        // The dead vote's structured-output salvage respawn must fail too
        // (and must not shift callCount).
        if (opts?.label?.endsWith(':salvage') === true) return null
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

    // invariant: 1 claim × 3 votes + 1 salvage respawn for the null vote = 4
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(4)

    expect(trail[0]!.outcome).toBe('ok')
    expect(trail[1]!.outcome).toBe('null')   // vote index 1 was null
    expect(trail[1]!.decision).toBeUndefined()  // null agent → no decision
    expect(trail[2]!.stage).toBe('adversarialVerification:verify:0:1:salvage')
    expect(trail[2]!.outcome).toBe('null')
    expect(trail[3]!.outcome).toBe('ok')
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

    // invariant: 1 claim × 3 votes + 3 salvage respawns (all null too) = 6
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(6)

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
    // Each null vote is followed by its (also-null) salvage respawn's record.
    expect(trail.map(r => r.stage)).toEqual([
      'adversarialVerification:verify:0:0',
      'adversarialVerification:verify:0:0:salvage',
      'adversarialVerification:verify:0:1',
      'adversarialVerification:verify:0:1:salvage',
      'adversarialVerification:verify:0:2',
      'adversarialVerification:verify:0:2:salvage',
    ])
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

  it('accepts refuteThreshold above the scalar votes when votesPerClaim overrides it (per-claim clamp applies)', async () => {
    // `votes` stays at its default of 3, but every claim actually receives 5
    // votes — the scalar comparison must not spuriously reject the config;
    // the threshold applies per claim as min(refuteThreshold, claimVotes) = 4.
    const byLabel: Record<string, VerifierVote> = {
      'adversarialVerification:verify:0:0': refutedVote,
      'adversarialVerification:verify:0:1': refutedVote,
      'adversarialVerification:verify:0:2': refutedVote,
      'adversarialVerification:verify:0:3': refutedVote,
      'adversarialVerification:verify:0:4': confirmedVote,
    }
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => byLabel[opts?.label ?? ''] ?? confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['only'],
      refuteThreshold: 4,
      votesPerClaim: () => 5,
    }))

    expect(result.stats.agentsSpawned).toBe(5)
    // 4 refutes >= effectiveThreshold min(4, 5) = 4 → refuted.
    expect(result.value[0]?.verdict).toBe('refuted')
  })

  it('still rejects refuteThreshold > votes when votesPerClaim is absent (scalar check unchanged)', async () => {
    const rt = new FakeRuntime()
    await expect(
      adversarialVerification(rt, makeOptions({ votes: 3, refuteThreshold: 4 })),
    ).rejects.toThrow(/refuteThreshold.*>.*votes/)
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

  it('clamps an explicit refuteThreshold to an intermediate per-claim count (general min, not a 1-vote special case)', async () => {
    // votes: 3, refuteThreshold: 3. Claim 'short' is mapped to 2 votes → its
    // effective threshold is min(3, 2) = 2, so 2 refutes decide it; the
    // 3-vote sibling 'full' also gets 2 refutes but still needs all 3.
    const byLabel: Record<string, VerifierVote> = {
      'adversarialVerification:verify:0:0': refutedVote,
      'adversarialVerification:verify:0:1': refutedVote,
      'adversarialVerification:verify:1:0': refutedVote,
      'adversarialVerification:verify:1:1': refutedVote,
      'adversarialVerification:verify:1:2': confirmedVote,
    }
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => byLabel[opts?.label ?? ''] ?? confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['short', 'full'],
      votes: 3,
      refuteThreshold: 3,
      votesPerClaim: (c) => (c === 'short' ? 2 : 3),
    }))

    expect(result.stats.agentsSpawned).toBe(5)
    expect(result.value.map((v) => v.verdict)).toEqual(['refuted', 'partially-confirmed'])
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

// ---------------------------------------------------------------------------
// Phase digest — partition invariant.
//
// The emitted [wt:digest] counts must account for EVERY claim: the five verdict
// buckets partition `value` (one verdict per claim, incl. cap-truncated), so they
// always sum to `claims`. This is the load-bearing property of the widened digest
// (a consumer can render the true outcome of every claim, none hidden). Exercised
// across a run that hits all five outcomes at once.
// ---------------------------------------------------------------------------

describe('adversarialVerification — phase digest partition invariant', () => {
  it('the five buckets span every outcome (incl. cap) and sum to claims', async () => {
    // 5 claims, cap 4 → one of each verdict: c0 confirmed, c1 refuted, c2 partially-
    // confirmed, c3 unverifiable (all verifiers null), c4 unverified-by-cap. votes:1
    // keeps each kept claim's verdict crisp.
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label.startsWith('adversarialVerification:verify:0:')) return confirmedVote
        if (label.startsWith('adversarialVerification:verify:1:')) return refutedVote
        if (label.startsWith('adversarialVerification:verify:2:')) return partialVote
        if (label.startsWith('adversarialVerification:verify:3:')) return null
        return confirmedVote
      },
    })

    await adversarialVerification(rt, makeOptions({
      claims: ['c0', 'c1', 'c2', 'c3', 'c4'],
      votes: 1,
      refuteThreshold: 1,
      maxVerifyClaims: 4,
      phase: 'verify-phase',
    }))

    const line = rt.logs.find((l) => l.startsWith('[wt:digest]'))
    expect(line).toBeDefined()
    expect(parseDigest(line!)?.phase).toBe('verify-phase')
    const counts = parseDigest(line!)?.counts
    expect(counts).toEqual({
      claims: 5,
      confirmed: 1,
      refuted: 1,
      partiallyConfirmed: 1,
      unverifiable: 1,
      unverifiedByCap: 1,
    })
    // The invariant itself, independent of the exact values above.
    const c = counts!
    const sum =
      (c['confirmed'] ?? 0) +
      (c['refuted'] ?? 0) +
      (c['partiallyConfirmed'] ?? 0) +
      (c['unverifiable'] ?? 0) +
      (c['unverifiedByCap'] ?? 0)
    expect(sum).toBe(c['claims'])
  })
})

// ---------------------------------------------------------------------------
// Effort forwarding
// ---------------------------------------------------------------------------

describe('adversarialVerification — effort forwarding', () => {
  it('forwards effort to all verifier agent calls when set', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 2,
      refuteThreshold: 1,
      effort: 'high',
    }))

    expect(rt.calls.every(c => c.opts?.effort === 'high')).toBe(true)
  })

  it('omits effort from verifier calls when not set', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 1,
      refuteThreshold: 1,
    }))

    expect(rt.calls.every(c => c.opts?.effort === undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Effort in the audit trail
// ---------------------------------------------------------------------------

describe('adversarialVerification — trail: effort field', () => {
  it('records effort on every verifier record when set', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 1,
      refuteThreshold: 1,
      effort: 'high',
    }))

    const trail = result.trail!
    expect(trail[0]!.effort).toBe('high')
  })

  it('omits effort from verifier records when not set', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 1,
      refuteThreshold: 1,
    }))

    const trail = result.trail!
    expect(trail[0]).not.toHaveProperty('effort')
  })
})

// ---------------------------------------------------------------------------
// cacheWarm (opt-in, mechanism b — warmup-agent)
//
// Chosen over mechanism (a) here because every verifier in the burst shares
// ONE uniform model (effectiveModel = model ?? BEST_MODEL) and vote counts
// default to a small 3 — losing one real vote to serial execution would cost
// proportionally more than a single extra throwaway agent.
// ---------------------------------------------------------------------------

describe('adversarialVerification — cacheWarm=false (explicit opt-out)', () => {
  it('fires no warmup call at all — behavior matches the pattern\'s pre-cacheWarm shape', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'], votes: 3, refuteThreshold: 2, cacheWarm: false,
    }))

    expect(rt.calls).toHaveLength(3) // 3 votes, no warm call
    expect(rt.calls.some(c => c.opts?.label?.includes('warm'))).toBe(false)
    expect(result.stats.agentsSpawned).toBe(3)
    expect(result.trail).toHaveLength(3)
    expect(result.trail[0]!.stage).not.toContain('warm')
  })

  it('produces identical stats/trail to cacheWarm:true modulo the extra warm record', async () => {
    const rtFalse = new FakeRuntime({ onAgent: () => confirmedVote })
    const rtTrue = new FakeRuntime({ onAgent: () => confirmedVote })

    const opts = makeOptions({ claims: ['c0'], votes: 3, refuteThreshold: 2 })
    const resultFalse = await adversarialVerification(rtFalse, { ...opts, cacheWarm: false })
    const resultTrue = await adversarialVerification(rtTrue, { ...opts, cacheWarm: true })

    // Same verdicts either way — cacheWarm never changes the OUTCOME, only
    // whether an extra warm call precedes the real burst.
    expect(resultFalse.value).toEqual(resultTrue.value)
    expect(resultTrue.stats.agentsSpawned).toBe(resultFalse.stats.agentsSpawned + 1)
    expect(resultTrue.trail).toHaveLength(resultFalse.trail.length + 1)
  })
})

describe('adversarialVerification — cacheWarm omitted (defaults to TRUE)', () => {
  it('fires the warmup call by default when the option is not passed at all', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    // Bypass this file's makeOptions() (which pins cacheWarm:false for the
    // OTHER tests in this file) — construct the options object directly, with
    // the cacheWarm key genuinely ABSENT, to prove the PATTERN's own default.
    const result = await adversarialVerification(rt, {
      claims: ['c0'],
      renderClaim: (c) => c,
      votes: 3,
      refuteThreshold: 2,
    })

    expect(rt.calls).toHaveLength(4) // 1 warm + 3 votes
    expect(rt.calls[0]!.opts?.label).toBe('adversarialVerification:warm')
    expect(result.stats.agentsSpawned).toBe(4)
    expect(result.value[0]!.verdict).toBe('confirmed')
  })
})

describe('adversarialVerification — cacheWarm=true (warmup-agent)', () => {
  it('fires exactly one warmup call FIRST, on the effective model, before any real verifier', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'], votes: 3, refuteThreshold: 2, cacheWarm: true,
    }))

    expect(rt.calls).toHaveLength(4) // 1 warm + 3 votes
    expect(rt.calls[0]!.opts?.label).toBe('adversarialVerification:warm')
    expect(rt.calls[0]!.opts?.model).toBe('opus') // BEST_MODEL default

    // agentsSpawned + trail invariant (trail.length === agentsSpawned) still holds.
    expect(result.stats.agentsSpawned).toBe(4)
    expect(result.trail).toHaveLength(4)
    expect(result.trail[0]!.stage).toBe('adversarialVerification:warm')
    expect(result.trail[0]!.outcome).toBe('ok')

    // Real verification unaffected.
    expect(result.value[0]!.verdict).toBe('confirmed')
  })

  it('threads verifierType/model/effort/phase to the warmup call, matching the real burst', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    await adversarialVerification(rt, makeOptions({
      claims: ['c0'], votes: 1, refuteThreshold: 1,
      model: 'sonnet', effort: 'low', verifierType: 'codex:codex-rescue', phase: 'verify-phase',
      cacheWarm: true,
    }))

    const warmCall = rt.calls[0]!
    expect(warmCall.opts?.model).toBe('sonnet')
    expect(warmCall.opts?.effort).toBe('low')
    expect(warmCall.opts?.agentType).toBe('codex:codex-rescue')
    expect(warmCall.phase).toBe('verify-phase')
  })

  it('charges the warmup call against the budget like every other verifier', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote, budgetTotal: 1000, agentTokenCost: 10 })

    await adversarialVerification(rt, makeOptions({
      claims: ['c0'], votes: 3, refuteThreshold: 2, cacheWarm: true,
    }))

    // 1 warm + 3 votes = 4 charged calls.
    expect(rt.budget.spent()).toBe(40)
  })

  it('degrades gracefully when the warmup agent returns null: warns, real burst still proceeds', async () => {
    let callCount = 0
    const rt = new FakeRuntime({
      onAgent: () => {
        callCount++
        if (callCount === 1) return null // the warmup call
        return confirmedVote
      },
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'], votes: 3, refuteThreshold: 2, cacheWarm: true,
    }))

    expect(result.trail[0]!.stage).toBe('adversarialVerification:warm')
    expect(result.trail[0]!.outcome).toBe('null')
    expect(result.warnings.some(w => w.includes('cache-warm'))).toBe(true)

    // Real verification burst proceeded normally and reached the correct verdict.
    expect(result.value[0]!.verdict).toBe('confirmed')
    expect(result.stats.agentsSpawned).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Stage salting (card #1816036725248493168) — per-invocation discriminator
// ---------------------------------------------------------------------------

describe('adversarialVerification — stage salting', () => {
  it('two invocations on the SAME rt: first bare, second salted " #2" on every label', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })

    await adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1 }))
    const firstLabels = rt.calls.map((c) => c.opts?.label)

    await adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1 }))
    const secondLabels = rt.calls.slice(firstLabels.length).map((c) => c.opts?.label)

    expect(firstLabels).toEqual(['adversarialVerification:verify:0:0'])
    expect(secondLabels).toEqual(['adversarialVerification:verify:0:0 #2'])
  })

  it('trail.stage === the rt.agent label for the same step, on the salted (2nd) invocation', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })
    await adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1 }))
    const result = await adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1 }))

    const secondCalls = rt.calls.slice(1)
    for (const record of result.trail) {
      const match = secondCalls.find((c) => c.opts?.label === record.stage)
      expect(match, `no rt.agent call found with label === trail.stage "${record.stage}"`).toBeDefined()
    }
    expect(result.trail.map((r) => r.stage)).toEqual(['adversarialVerification:verify:0:0 #2'])
  })

  it('the cache-warm label is salted (A7) — patternName arg (prose prefix) stays bare', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })
    await adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1, cacheWarm: true }))
    await adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1, cacheWarm: true }))

    const warmLabels = rt.calls.filter((c) => c.opts?.label?.startsWith('adversarialVerification:warm')).map((c) => c.opts?.label)
    expect(warmLabels).toEqual(['adversarialVerification:warm', 'adversarialVerification:warm #2'])
  })

  it('an explicit stageKey salts every stage/label of that invocation, including a salvage record', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (opts?.label?.endsWith(':salvage') === true ? null : null),
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'], votes: 1, refuteThreshold: 1, stageKey: 'my-key',
    }))

    expect(rt.calls.map((c) => c.opts?.label)).toEqual([
      'adversarialVerification:verify:0:0 #my-key',
      'adversarialVerification:verify:0:0 #my-key:salvage',
    ])
    expect(result.trail.map((r) => r.stage)).toEqual([
      'adversarialVerification:verify:0:0 #my-key',
      'adversarialVerification:verify:0:0 #my-key:salvage',
    ])
    expect(result.warnings.join(' ')).not.toMatch(/stageKey/)
  })

  it('a valid stageKey applies to the cache-warm label too', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })
    await adversarialVerification(rt, makeOptions({
      claims: ['c0'], votes: 1, refuteThreshold: 1, cacheWarm: true, stageKey: 'security',
    }))
    const warmCall = rt.calls.find((c) => c.opts?.label?.startsWith('adversarialVerification:warm'))
    expect(warmCall?.opts?.label).toBe('adversarialVerification:warm #security')
  })

  it('distinct rt instances stay isolated — both get the bare first invocation', async () => {
    const rt1 = new FakeRuntime({ onAgent: () => confirmedVote })
    const rt2 = new FakeRuntime({ onAgent: () => confirmedVote })

    await adversarialVerification(rt1, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1 }))
    await adversarialVerification(rt2, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1 }))

    expect(rt1.calls.map((c) => c.opts?.label)).toEqual(['adversarialVerification:verify:0:0'])
    expect(rt2.calls.map((c) => c.opts?.label)).toEqual(['adversarialVerification:verify:0:0'])
  })

  it('digest.stage stays bare even on a salted (2nd) invocation', async () => {
    const rt = new FakeRuntime({ onAgent: () => confirmedVote })
    await adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1 }))
    await adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1 }))

    const digests = rt.logs.map(parseDigest).filter((d) => d?.stage === 'adversarialVerification')
    expect(digests).toHaveLength(2)
    for (const d of digests) expect(d?.stage).toBe('adversarialVerification')
  })
})

// ---------------------------------------------------------------------------
// Provenance gate — a verifier routed to a REGISTERED external agentType
// (opencode / codex) can SELF-ANSWER (emit a valid verdict without invoking the
// external CLI). After the vote burst, a checker reads each vote's transcript;
// a vote with no real CLI invocation is DISQUALIFIED (nullified → the existing
// unverifiable path). A plain Claude verifier is NEVER gated. (card #1823504956762621933)
// ---------------------------------------------------------------------------
describe('adversarialVerification — provenance gate (external verifierType)', () => {
  const OPENCODE = 'workflow-toolbox:opencode-verifier'

  /** Drive a run whose verifiers route to an external type. `provenance(label)` →
   *  true (CLI seen) / false (self-answer) / null (checker omits it → undetermined).
   *  `voteFor(label)` supplies each vote's verdict. The checker call (label contains
   *  ':provenance-check') returns the assembled provenance JSON built from the vote
   *  labels actually seen — robust to per-invocation label salting. */
  function externalRun(
    overrides: Partial<AdversarialVerificationOptions<string>>,
    provenance: (label: string) => boolean | null,
    voteFor: (label: string) => VerifierVote = () => confirmedVote,
  ): { rt: FakeRuntime; run: Promise<Awaited<ReturnType<typeof adversarialVerification<string>>>> } {
    const voteLabels: string[] = []
    const rt = new FakeRuntime({
      onAgent: (call) => {
        const label = call.opts?.label ?? ''
        // A retry re-spawn (Phase B2) carries a terminal ':retry' on its label; in
        // these legacy gate tests a retry BEHAVES LIKE its base vote (same provenance
        // + same verdict), so strip it to key both off the base label — a disqualified
        // vote's retry then self-answers again and the vote stays null, preserving each
        // test's first-gate intent. (No-op until the retry code exists.)
        const base = (l: string): string => l.replace(/:retry$/, '')
        if (label.includes(':provenance-check')) {
          const results = voteLabels
            .map((l) => ({ label: l, seen: provenance(base(l)) }))
            .filter((r) => r.seen !== null)
            .map((r) => ({ label: r.label, cliSeen: r.seen as boolean }))
          return JSON.stringify({ anchored: true, results })
        }
        if (label.includes(':verify:')) { voteLabels.push(label); return voteFor(base(label)) }
        return confirmedVote
      },
    })
    return { rt, run: adversarialVerification(rt, makeOptions({ verifierType: OPENCODE, ...overrides })) }
  }

  it('credits an external vote WITH provenance (real CLI invocation seen)', async () => {
    const { rt, run } = externalRun({ claims: ['c0'], votes: 2, refuteThreshold: 2 }, () => true)
    const result = await run
    expect(result.value[0]!.verdict).toBe('confirmed')
    expect(result.value[0]!.votes.filter((v) => v !== null)).toHaveLength(2)
    const checkerCalls = rt.calls.filter((c) => (c.opts?.label ?? '').includes(':provenance-check'))
    expect(checkerCalls).toHaveLength(1)
    expect(checkerCalls[0]!.opts?.model).toBe('haiku')
    expect(result.warnings.some((w) => /DISQUALIFIED|UNDETERMINED/.test(w))).toBe(false)
    // trail invariant holds WITH the checker record appended, last, not under :verify:.
    expect(result.trail).toHaveLength(result.stats.agentsSpawned)
    expect(result.trail.at(-1)!.stage).toContain(':provenance-check')
    expect(result.trail.at(-1)!.outcome).toBe('ok')
    expect(result.trail.filter((r) => r.stage.startsWith('adversarialVerification:verify:'))).toHaveLength(2)
  })

  it('DISQUALIFIES external votes WITHOUT provenance → null → unverifiable', async () => {
    const { run } = externalRun({ claims: ['c0'], votes: 2, refuteThreshold: 2 }, () => false)
    const result = await run
    expect(result.value[0]!.verdict).toBe('unverifiable')
    expect(result.value[0]!.votes).toEqual([null, null])
    expect(result.warnings.some((w) => /2 external verifier votes DISQUALIFIED/.test(w))).toBe(true)
  })

  it('does NOT gate a registered NON-external verifierType (false-positive invariant)', async () => {
    const rt = new FakeRuntime({
      onAgent: (call) => {
        if ((call.opts?.label ?? '').includes(':provenance-check')) throw new Error('gate must NOT arm for a Claude specialist')
        return confirmedVote
      },
    })
    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'], votes: 2, refuteThreshold: 2, verifierType: 'magic-claude:ts-reviewer',
    }))
    expect(result.value[0]!.verdict).toBe('confirmed')
    expect(rt.calls.some((c) => (c.opts?.label ?? '').includes(':provenance-check'))).toBe(false)
  })

  it('does NOT gate when verifierType is undefined (plain Claude verifier)', async () => {
    const rt = new FakeRuntime({
      onAgent: (call) => {
        if ((call.opts?.label ?? '').includes(':provenance-check')) throw new Error('no gate without an external type')
        return confirmedVote
      },
    })
    const result = await adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 2, refuteThreshold: 2 }))
    expect(result.value[0]!.verdict).toBe('confirmed')
    expect(rt.calls.some((c) => (c.opts?.label ?? '').includes(':provenance-check'))).toBe(false)
  })

  it('fails CLOSED when the checker cannot resolve provenance (undetermined → null)', async () => {
    const rt = new FakeRuntime({
      onAgent: (call) => {
        const label = call.opts?.label ?? ''
        if (label.includes(':provenance-check')) return 'sorry, could not read the transcripts' // non-JSON
        return confirmedVote
      },
    })
    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'], votes: 2, refuteThreshold: 2, verifierType: OPENCODE,
    }))
    expect(result.value[0]!.verdict).toBe('unverifiable')
    expect(result.warnings.some((w) => /UNDETERMINED provenance/.test(w))).toBe(true)
    expect(result.trail.at(-1)!.stage).toContain(':provenance-check')
    expect(result.trail.at(-1)!.outcome).toBe('null') // no usable reply
  })

  it('gates per-vote: one self-answered vote among provenanced ones changes the tally', async () => {
    // 3 votes [confirmed, confirmed, refuted]; vote index 1 self-answered → disqualified.
    // Survivors [confirmed, refuted]: 1 refuted < threshold 2, not all confirmed → partially-confirmed.
    const byIndex: Record<string, VerifierVote> = { '0': confirmedVote, '1': confirmedVote, '2': refutedVote }
    const { run } = externalRun(
      { claims: ['c0'], votes: 3, refuteThreshold: 2 },
      (label) => !label.endsWith(':1'),
      (label) => byIndex[label.slice(-1)] ?? confirmedVote,
    )
    const result = await run
    expect(result.value[0]!.verdict).toBe('partially-confirmed')
    expect(result.value[0]!.votes[1]).toBeNull()
    const v1 = result.trail.find((r) => r.stage.endsWith(':verify:0:1'))!
    expect(v1.outcome).toBe('null')
    expect(v1.decision).toBe('disqualified-no-provenance')
  })
})

// ---------------------------------------------------------------------------
// Retry disqualified-no-provenance votes ONCE (card #1824029483854726303).
//
// A vote nullified by the provenance gate (a possible self-answer, not a plain
// agent failure) is re-spawned exactly ONCE before tallying; a SECOND checker
// re-reads only the retried labels. A retry that returns a real vote WITH
// provenance is RECOVERED (folded into the tally + the public votes); a retry
// that self-answers again (or fails) leaves the vote null. Bounded: one retry
// per disqualified vote, never a retry-of-a-retry.
// ---------------------------------------------------------------------------
describe('adversarialVerification — retry disqualified-no-provenance votes once', () => {
  const OPENCODE = 'workflow-toolbox:opencode-verifier'

  /** Drive an external-type run with SEPARATE control over the first-gate provenance
   *  (`firstSeen(baseVoteLabel)`) and the retry-pass provenance (`retrySeen(retryLabel)`),
   *  and separate vote suppliers for the original burst (`voteFor`) and the retry
   *  re-spawns (`retryVoteFor`, may return null to model a plain agent failure). The two
   *  checker calls are told apart by the terminal ':retry' on the second checker's label. */
  function externalRetryRun(cfg: {
    overrides?: Partial<AdversarialVerificationOptions<string>>
    firstSeen: (voteLabel: string) => boolean | null
    retrySeen: (retryLabel: string) => boolean | null
    voteFor?: (voteLabel: string) => VerifierVote
    retryVoteFor?: (retryLabel: string) => VerifierVote | null
  }): { rt: FakeRuntime; run: Promise<Awaited<ReturnType<typeof adversarialVerification<string>>>> } {
    const origLabels: string[] = []
    const retryLabels: string[] = []
    const rt = new FakeRuntime({
      onAgent: (call) => {
        const label = call.opts?.label ?? ''
        if (label.includes(':provenance-check:retry')) {
          const results = retryLabels
            .map((l) => ({ label: l, seen: cfg.retrySeen(l) }))
            .filter((r) => r.seen !== null)
            .map((r) => ({ label: r.label, cliSeen: r.seen as boolean }))
          return JSON.stringify({ anchored: true, results })
        }
        if (label.includes(':provenance-check')) {
          const results = origLabels
            .map((l) => ({ label: l, seen: cfg.firstSeen(l) }))
            .filter((r) => r.seen !== null)
            .map((r) => ({ label: r.label, cliSeen: r.seen as boolean }))
          return JSON.stringify({ anchored: true, results })
        }
        if (label.includes(':verify:') && label.includes(':retry')) {
          retryLabels.push(label)
          return cfg.retryVoteFor ? cfg.retryVoteFor(label) : confirmedVote
        }
        if (label.includes(':verify:')) {
          origLabels.push(label)
          return cfg.voteFor ? cfg.voteFor(label) : confirmedVote
        }
        return confirmedVote
      },
    })
    return {
      rt,
      run: adversarialVerification(rt, makeOptions({ verifierType: OPENCODE, cacheWarm: false, ...cfg.overrides })),
    }
  }

  it('recovers a disqualified vote — credited in the tally AND the public votes', async () => {
    const { run } = externalRetryRun({
      overrides: { claims: ['c0'], votes: 3, refuteThreshold: 2 },
      firstSeen: (l) => !l.endsWith(':1'), // vote index 1 self-answers → disqualified
      retrySeen: () => true,               // its retry has real provenance
      retryVoteFor: () => confirmedVote,
    })
    const result = await run

    expect(result.value[0]!.verdict).toBe('confirmed')
    // The recovered vote is folded into the PUBLIC votes array (no longer null).
    expect(result.value[0]!.votes[1]).toEqual(confirmedVote)
    expect(result.value[0]!.votes.filter((v) => v !== null)).toHaveLength(3)

    // Original vote keeps its disqualification record; the retry is a SEPARATE record.
    const orig = result.trail.find((r) => r.stage.endsWith(':verify:0:1'))!
    expect(orig.outcome).toBe('null')
    expect(orig.decision).toBe('disqualified-no-provenance')
    const retry = result.trail.find((r) => r.stage.endsWith(':verify:0:1:retry'))!
    expect(retry.outcome).toBe('ok')
    expect(retry.decision).toBe('retried-after-disqualification')

    // Two distinct checker records; the retry checker is haiku and NOT under :verify:.
    const checkers = result.trail.filter((r) => r.stage.includes(':provenance-check'))
    expect(checkers).toHaveLength(2)
    expect(checkers.some((r) => r.stage.endsWith(':provenance-check'))).toBe(true)
    expect(checkers.some((r) => r.stage.endsWith(':provenance-check:retry'))).toBe(true)

    expect(result.warnings.some((w) => /RECOVERED after one retry/.test(w))).toBe(true)
    // Trail invariant survives the retry path.
    expect(result.trail).toHaveLength(result.stats.agentsSpawned)
  })

  it('a recovered vote can CHANGE the verdict (partially-confirmed → refuted)', async () => {
    const byIndex: Record<string, VerifierVote> = { '0': refutedVote, '1': refutedVote, '2': confirmedVote }
    const { run } = externalRetryRun({
      overrides: { claims: ['c0'], votes: 3, refuteThreshold: 2 },
      firstSeen: (l) => !l.endsWith(':1'),         // the 2nd refuted vote self-answers
      retrySeen: () => true,
      voteFor: (l) => byIndex[l.slice(-1)] ?? confirmedVote,
      retryVoteFor: () => refutedVote,             // retry recovers the refutation
    })
    const result = await run

    // First gate leaves [refuted, confirmed] → 1 refute < 2 → partially-confirmed;
    // the recovered refutation makes it 2 refutes → refuted.
    expect(result.value[0]!.verdict).toBe('refuted')
    expect(result.value[0]!.votes[1]).toEqual(refutedVote)
  })

  it('a retry that self-answers AGAIN stays disqualified (vote stays null)', async () => {
    const { run } = externalRetryRun({
      overrides: { claims: ['c0'], votes: 2, refuteThreshold: 2 },
      firstSeen: (l) => !l.endsWith(':1'),
      retrySeen: () => false, // the retry also produced no CLI invocation
      retryVoteFor: () => confirmedVote,
    })
    const result = await run

    expect(result.value[0]!.votes[1]).toBeNull()
    const retry = result.trail.find((r) => r.stage.endsWith(':verify:0:1:retry'))!
    expect(retry.outcome).toBe('null')
    expect(retry.decision).toBe('disqualified-no-provenance')
    expect(result.warnings.some((w) => /remained unrecovered after one retry/.test(w))).toBe(true)
    // 1 surviving confirmed vote → confirmed.
    expect(result.value[0]!.verdict).toBe('confirmed')
  })

  it('retries each disqualified vote EXACTLY once — never a retry-of-a-retry', async () => {
    const { rt, run } = externalRetryRun({
      overrides: { claims: ['c0'], votes: 3, refuteThreshold: 2 },
      firstSeen: (l) => l.endsWith(':1'), // only vote 1 seen; votes 0 and 2 disqualified
      retrySeen: () => false,             // retries self-answer → not recovered
    })
    await run

    const labels = rt.calls.map((c) => c.opts?.label ?? '')
    const retryVoteCalls = labels.filter((l) => /:verify:0:\d:retry$/.test(l))
    expect(retryVoteCalls.sort()).toEqual([
      'adversarialVerification:verify:0:0:retry',
      'adversarialVerification:verify:0:2:retry',
    ])
    // No label is ever retried twice.
    expect(labels.some((l) => l.includes(':retry:retry'))).toBe(false)
    // Exactly ONE retry-pass checker.
    expect(labels.filter((l) => l.includes(':provenance-check:retry'))).toHaveLength(1)
  })

  it('a retry whose AGENT fails (null) leaves the vote null with no control decision', async () => {
    const { run } = externalRetryRun({
      overrides: { claims: ['c0'], votes: 2, refuteThreshold: 2 },
      firstSeen: (l) => !l.endsWith(':1'),
      retrySeen: () => true,        // provenance would be fine, but the agent returned null
      retryVoteFor: () => null,
    })
    const result = await run

    expect(result.value[0]!.votes[1]).toBeNull()
    const retry = result.trail.find((r) => r.stage.endsWith(':verify:0:1:retry'))!
    expect(retry.outcome).toBe('null')
    // A plain agent failure on the retry is NOT a disqualification — no decision.
    expect(retry).not.toHaveProperty('decision')
    expect(result.value[0]!.verdict).toBe('confirmed')
  })

  it('does NOT retry (and fires no second checker) when every vote has provenance', async () => {
    const { rt, run } = externalRetryRun({
      overrides: { claims: ['c0'], votes: 2, refuteThreshold: 2 },
      firstSeen: () => true, // all seen → nothing to retry
      retrySeen: () => true,
    })
    const result = await run

    const labels = rt.calls.map((c) => c.opts?.label ?? '')
    expect(labels.some((l) => l.includes(':retry'))).toBe(false)
    // The only checker record is the first pass — it stays the last trail record.
    expect(result.trail.filter((r) => r.stage.includes(':provenance-check'))).toHaveLength(1)
    expect(result.trail.at(-1)!.stage.endsWith(':provenance-check')).toBe(true)
    expect(result.trail).toHaveLength(result.stats.agentsSpawned)
    expect(result.value[0]!.verdict).toBe('confirmed')
  })

  it('keeps trail.length === agentsSpawned across recovery AND re-disqualification in one run', async () => {
    const { run } = externalRetryRun({
      overrides: { claims: ['c0', 'c1'], votes: 2, refuteThreshold: 2 },
      firstSeen: (l) => !l.endsWith(':1'),         // vote 1 of BOTH claims disqualified
      retrySeen: (l) => l.includes(':0:1:retry'),  // only c0's retry recovers
    })
    const result = await run

    expect(result.trail).toHaveLength(result.stats.agentsSpawned)
    // c0's vote 1 recovered; c1's did not.
    expect(result.value[0]!.votes[1]).not.toBeNull()
    expect(result.value[1]!.votes[1]).toBeNull()
    expect(result.warnings.some((w) => /1 gate-nullified verifier votes RECOVERED/.test(w))).toBe(true)
    expect(result.warnings.some((w) => /1 gate-nullified verifier votes remained unrecovered/.test(w))).toBe(true)
  })

  it('the retry re-spawn inherits the verifier model/effort/agentType; the retry checker is haiku', async () => {
    const { rt, run } = externalRetryRun({
      overrides: { claims: ['c0'], votes: 2, refuteThreshold: 2, effort: 'high' },
      firstSeen: (l) => !l.endsWith(':1'),
      retrySeen: () => true,
    })
    await run

    const retryVote = rt.calls.find((c) => (c.opts?.label ?? '').endsWith(':verify:0:1:retry'))!
    expect(retryVote.opts?.agentType).toBe(OPENCODE)
    expect(retryVote.opts?.model).toBe(BEST_MODEL) // effectiveModel default
    expect(retryVote.opts?.effort).toBe('high')

    const retryChecker = rt.calls.find((c) => (c.opts?.label ?? '').includes(':provenance-check:retry'))!
    expect(retryChecker.opts?.model).toBe('haiku')
    expect((retryChecker.opts?.label ?? '').includes(':verify:')).toBe(false)
  })

  it('the retry re-spawn reuses the disqualified vote\'s lens', async () => {
    const capturedRetryPrompts: string[] = []
    const origLabels: string[] = []
    const retryLabels: string[] = []
    const rt = new FakeRuntime({
      onAgent: (call) => {
        const label = call.opts?.label ?? ''
        if (label.includes(':provenance-check:retry')) {
          const results = retryLabels.map((l) => ({ label: l, cliSeen: true }))
          return JSON.stringify({ anchored: true, results })
        }
        if (label.includes(':provenance-check')) {
          const results = origLabels.map((l) => ({ label: l, cliSeen: !l.endsWith(':1') }))
          return JSON.stringify({ anchored: true, results })
        }
        if (label.includes(':verify:') && label.includes(':retry')) {
          retryLabels.push(label)
          capturedRetryPrompts.push(call.prompt)
          return confirmedVote
        }
        if (label.includes(':verify:')) { origLabels.push(label); return confirmedVote }
        return confirmedVote
      },
    })

    await adversarialVerification(rt, makeOptions({
      claims: ['c0'], votes: 2, verifierType: OPENCODE, cacheWarm: false,
      lenses: ['correctness', 'security'],
    }))

    // Vote index 1 (lens 'security') was disqualified and retried.
    expect(capturedRetryPrompts).toHaveLength(1)
    expect(capturedRetryPrompts[0]!).toContain('security')
  })
})

// ---------------------------------------------------------------------------
// Provenance gate — salvage-aware EFFECTIVE label (card #1824029483854726303 fix round).
//
// agentWithSchemaSalvage respawns a schema-failed call under `<label>:salvage`; the
// credited value can come from EITHER transcript. The provenance checker must scan the
// transcript that PRODUCED the credited value (the effective label), not always the
// original — otherwise a self-answer in the salvage respawn is credited on the original's
// CLI call (counterfeit) and, conversely, a genuine salvage CLI call is unjustly rejected.
// ---------------------------------------------------------------------------
describe('adversarialVerification — provenance gate: salvage-aware effective label', () => {
  const OPENCODE = 'workflow-toolbox:opencode-verifier'

  it('CREDITS a salvage-produced vote when the CLI ran in the SALVAGE transcript', async () => {
    const rt = new FakeRuntime({
      onAgent: (call) => {
        const label = call.opts?.label ?? ''
        if (label.includes(':provenance-check')) {
          // Original had NO CLI (it failed pre-CLI); the salvage respawn DID invoke it.
          return JSON.stringify({ anchored: true, results: [
            { label: 'adversarialVerification:verify:0:0', cliSeen: false },
            { label: 'adversarialVerification:verify:0:0:salvage', cliSeen: true },
          ] })
        }
        if (label === 'adversarialVerification:verify:0:0:salvage') return confirmedVote // salvage produces the value
        if (label === 'adversarialVerification:verify:0:0') return null                  // native fails → triggers salvage
        return confirmedVote
      },
    })
    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'], votes: 1, refuteThreshold: 1, verifierType: OPENCODE, cacheWarm: false,
    }))
    // Real salvage-produced vote (CLI in the salvage transcript) → credited, not rejected.
    expect(result.value[0]!.verdict).toBe('confirmed')
    expect(result.value[0]!.votes[0]).toEqual(confirmedVote)
    expect(result.warnings.some((w) => /DISQUALIFIED/.test(w))).toBe(false)
  })

  it('DISQUALIFIES a salvage-produced vote whose CLI ran only in the ORIGINAL (salvage self-answered)', async () => {
    const rt = new FakeRuntime({
      onAgent: (call) => {
        const label = call.opts?.label ?? ''
        if (label.includes(':provenance-check')) {
          // Original DID invoke the CLI (then failed schema); the salvage respawn
          // SELF-ANSWERED (no CLI). The CREDITED value came from the salvage → reject it.
          return JSON.stringify({ anchored: true, results: [
            { label: 'adversarialVerification:verify:0:0', cliSeen: true },
            { label: 'adversarialVerification:verify:0:0:salvage', cliSeen: false },
          ] })
        }
        if (label === 'adversarialVerification:verify:0:0:salvage') return confirmedVote
        if (label === 'adversarialVerification:verify:0:0') return null
        // The retry (fired because the vote is disqualified) plain-fails → no recovery.
        if (label.startsWith('adversarialVerification:verify:0:0:retry')) return null
        return confirmedVote
      },
    })
    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'], votes: 1, refuteThreshold: 1, verifierType: OPENCODE, cacheWarm: false,
    }))
    // Counterfeit salvage vote rejected (effective = the salvage transcript, no CLI);
    // the retry did not recover → unverifiable. WITHOUT the effective-label fix the base
    // transcript's CLI would credit the self-answer → confirmed (the bug).
    expect(result.value[0]!.verdict).toBe('unverifiable')
    const orig = result.trail.find((r) => r.stage === 'adversarialVerification:verify:0:0')!
    expect(orig.outcome).toBe('null')
    expect(orig.decision).toBe('disqualified-no-provenance')
    expect(result.warnings.some((w) => /DISQUALIFIED/.test(w))).toBe(true)
  })
})
