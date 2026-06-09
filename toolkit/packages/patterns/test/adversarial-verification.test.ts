import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@dwt/runtime'
import { adversarialVerification } from '../src/adversarial-verification.js'
import type { AdversarialVerificationOptions, VerifierVote } from '../src/adversarial-verification.js'

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
// Cap — truncated claims kept as unverifiable
// ---------------------------------------------------------------------------

describe('adversarialVerification — cap truncation', () => {
  it('truncated claims appear in output as unverifiable with empty votes', async () => {
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

    // Last 3: unverifiable with empty votes
    for (const v of result.value.slice(2)) {
      expect(v.verdict).toBe('unverifiable')
      expect(v.votes).toHaveLength(0)
    }

    expect(result.warnings.some(w => w.includes('truncated') && w.includes('maxVerifyClaims'))).toBe(true)
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
// Model sensitivity — default is opus
// ---------------------------------------------------------------------------

describe('adversarialVerification — model', () => {
  it('defaults to opus model on verifier calls', async () => {
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    await adversarialVerification(rt, makeOptions({ claims: ['c0'], votes: 1, refuteThreshold: 1 }))

    expect(rt.calls[0]!.opts?.model).toBe('opus')
  })

  it('emits downgrade warning when non-opus model specified', async () => {
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
  it('records model on every verifier record even without explicit override (opus default is explicitly passed)', async () => {
    // adversarialVerification always passes effectiveModel ('opus' when no override),
    // so model is always present in the trail — this is intentional and documented.
    const rt = new FakeRuntime({
      onAgent: () => confirmedVote,
    })

    const result = await adversarialVerification(rt, makeOptions({
      claims: ['c0'],
      votes: 1,
      refuteThreshold: 1,
    }))

    const trail = result.trail!
    expect(trail[0]!.model).toBe('opus')
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
