import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@dwt/runtime'
import type { WorkflowRuntime } from '@dwt/runtime'
import { loopUntilDone } from '../src/loop-until-done.js'
import type { LoopUntilDoneOptions } from '../src/loop-until-done.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A body that increments a counter and reports progress. */
function counterBody(target: number) {
  return async (_rt: WorkflowRuntime, state: number) => {
    const newState = state + 1
    return { state: newState, done: newState >= target, progressed: true }
  }
}

/** A body that never progresses. */
const dryBody = async (_rt: WorkflowRuntime, state: number) =>
  ({ state, progressed: false as const })

/** A body that throws. */
const throwingBody: LoopUntilDoneOptions<unknown>['body'] = async () => {
  throw new Error('body-error')
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('loopUntilDone — config validation', () => {
  it('rejects when maxIterations < 1', async () => {
    const rt = new FakeRuntime()
    await expect(
      loopUntilDone(rt, { initial: 0, maxIterations: 0, body: counterBody(5) }),
    ).rejects.toThrow(/maxIterations.*>=.*1/)
  })

  it('rejects when dryRounds < 1', async () => {
    const rt = new FakeRuntime()
    await expect(
      loopUntilDone(rt, { initial: 0, dryRounds: 0, body: counterBody(5) }),
    ).rejects.toThrow(/dryRounds.*>=.*1/)
  })

  it('rejects when budgetFloor < 0', async () => {
    const rt = new FakeRuntime({ budgetTotal: 100 })
    await expect(
      loopUntilDone(rt, { initial: 0, budgetFloor: -1, maxIterations: 10, body: counterBody(5) }),
    ).rejects.toThrow(/budgetFloor.*>=.*0/)
  })

  it('rejects when budgetFloor is the only stop condition and total is null', async () => {
    const rt = new FakeRuntime()  // budgetTotal = null (default)
    await expect(
      loopUntilDone(rt, { initial: 0, budgetFloor: 10, body: counterBody(5) }),
    ).rejects.toThrow(/budgetFloor.*only stop condition|no budget target/)
  })

  it('does NOT reject when budgetFloor accompanies maxIterations even with null total', async () => {
    const rt = new FakeRuntime()  // budgetTotal = null
    // Should succeed (budgetFloor is inert but other conditions exist)
    const result = await loopUntilDone(rt, {
      initial: 0,
      budgetFloor: 10,
      maxIterations: 3,
      body: counterBody(10),
    })
    expect(result.value.stoppedBy).toBe('maxIterations')
    expect(result.warnings.some(w => w.includes('inert'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Compile-time check: omitting all stop conditions is a TS error
// ---------------------------------------------------------------------------

describe('loopUntilDone — compile-time stop condition enforcement', () => {
  it('TypeScript rejects options with no stop condition (verified via @ts-expect-error)', () => {
    // If this @ts-expect-error is NOT suppressing a real error, tsc fails with
    // "Unused '@ts-expect-error' directive" — proving the type constraint is enforced.
    type NoStopCondition = {
      initial: number
      body: LoopUntilDoneOptions<number>['body']
    }
    // @ts-expect-error — NoStopCondition is not assignable to LoopUntilDoneOptions
    const check: LoopUntilDoneOptions<number> = { initial: 0, body: async (_rt, state) => ({ state }) } as NoStopCondition
    void check
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Stops by 'done'
// ---------------------------------------------------------------------------

describe('loopUntilDone — stops by done', () => {
  it('stops when body returns done=true, stoppedBy=done, no warning', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 10,
      body: counterBody(3),
    })

    expect(result.value.stoppedBy).toBe('done')
    expect(result.value.iterations).toBe(3)
    expect(result.value.state).toBe(3)
    expect(result.warnings).toHaveLength(0)
    // stats: itemsIn = itemsOut = completed iterations
    expect(result.stats.itemsIn).toBe(3)
    expect(result.stats.itemsOut).toBe(3)
    expect(result.stats.agentsSpawned).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Stops by 'maxIterations'
// ---------------------------------------------------------------------------

describe('loopUntilDone — stops by maxIterations', () => {
  it('stops when maxIterations exhausted, stoppedBy=maxIterations, emits warning', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 3,
      body: counterBody(100),  // never reaches done naturally
    })

    expect(result.value.stoppedBy).toBe('maxIterations')
    expect(result.value.iterations).toBe(3)
    expect(result.warnings.some(w => w.includes('maxIterations'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Stops by 'dryRounds'
// ---------------------------------------------------------------------------

describe('loopUntilDone — stops by dryRounds', () => {
  it('stops when consecutive dry rounds reached, stoppedBy=dryRounds', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 0,
      dryRounds: 3,
      body: dryBody,
    })

    expect(result.value.stoppedBy).toBe('dryRounds')
    expect(result.value.iterations).toBe(3)
    expect(result.warnings.some(w => w.includes('dryRounds'))).toBe(true)
  })

  it('resets dry counter when progress is made', async () => {
    const rt = new FakeRuntime()
    let iteration = 0

    const result = await loopUntilDone(rt, {
      initial: 0,
      dryRounds: 2,
      maxIterations: 10,
      body: async (_rt, state) => {
        iteration++
        // Progress on iterations 1, 3 — dry on 2, 4, 5
        // dry counter: 0 → dry(1)=1 → progress(3)=0 → dry(4)=1 → dry(5)=2 → stop
        if (iteration === 1 || iteration === 3) {
          return { state: state + 1, progressed: true }
        }
        return { state, progressed: false }
      },
    })

    expect(result.value.stoppedBy).toBe('dryRounds')
    expect(result.value.iterations).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Stops by 'budgetFloor'
// ---------------------------------------------------------------------------

describe('loopUntilDone — stops by budgetFloor', () => {
  it('stops when remaining budget reaches floor, stoppedBy=budgetFloor', async () => {
    // Budget: total=100, cost per agent call=30
    // After each iteration: remaining = 100 - 30*n
    // floor=25: after iter 3, remaining=10 <= 25 → stop before iter 4
    const rt = new FakeRuntime({ budgetTotal: 100, agentTokenCost: 30 })

    const result = await loopUntilDone(rt, {
      initial: 0,
      budgetFloor: 25,
      maxIterations: 20,
      body: async (bodyRt, state) => {
        // Call agent to consume budget
        await bodyRt.agent('dummy')
        return { state: state + 1, progressed: true }
      },
    })

    expect(result.value.stoppedBy).toBe('budgetFloor')
    expect(result.warnings.some(w => w.includes('budgetFloor'))).toBe(true)
    expect(result.warnings.some(w => w.includes('remaining') && w.includes('floor'))).toBe(true)
  })

  it('emits inert-floor warning when budgetFloor set but total is null', async () => {
    const rt = new FakeRuntime()  // null total

    const result = await loopUntilDone(rt, {
      initial: 0,
      budgetFloor: 10,
      dryRounds: 2,
      body: dryBody,
    })

    expect(result.warnings.some(w => w.includes('inert'))).toBe(true)
    // Loop proceeds on dryRounds
    expect(result.value.stoppedBy).toBe('dryRounds')
  })

  it('floor pre-empts a body that would have returned done (documented precedence)', async () => {
    // total=50, cost=30, floor=25: iter 1 runs (remaining 50 > 25), spends 30 →
    // remaining 20. Before iter 2: 20 <= 25 → stop. The body WOULD have
    // returned done=true on iteration 2 — it never runs: once the floor is
    // crossed, the spend a completing iteration needs is exactly what the
    // floor protects (header contract).
    const rt = new FakeRuntime({ budgetTotal: 50, agentTokenCost: 30 })

    const result = await loopUntilDone(rt, {
      initial: 0,
      budgetFloor: 25,
      body: async (bodyRt, state, iteration) => {
        await bodyRt.agent('dummy')
        return { state: state + 1, done: iteration >= 2 }
      },
    })

    expect(result.value.stoppedBy).toBe('budgetFloor')
    expect(result.value.iterations).toBe(1)
    expect(result.value.state).toBe(1)
  })

  it('budgetFloor=0 stops only when the budget is fully exhausted', async () => {
    // total=60, cost=30: iter 1 → remaining 30 > 0; iter 2 → remaining 0;
    // before iter 3: 0 <= 0 → stop. floor=0 is legal (§8 boundary).
    const rt = new FakeRuntime({ budgetTotal: 60, agentTokenCost: 30 })

    const result = await loopUntilDone(rt, {
      initial: 0,
      budgetFloor: 0,
      body: async (bodyRt, state) => {
        await bodyRt.agent('dummy')
        return { state: state + 1 }
      },
    })

    expect(result.value.stoppedBy).toBe('budgetFloor')
    expect(result.value.iterations).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Body throw propagates
// ---------------------------------------------------------------------------

describe('loopUntilDone — body throw propagates', () => {
  it('propagates body errors (programmer errors must not be swallowed)', async () => {
    const rt = new FakeRuntime()

    await expect(
      loopUntilDone(rt, {
        initial: 0,
        maxIterations: 5,
        body: throwingBody,
      }),
    ).rejects.toThrow('body-error')
  })
})

// ---------------------------------------------------------------------------
// Stats semantics
// ---------------------------------------------------------------------------

describe('loopUntilDone — stats', () => {
  it('has agentsSpawned=0 always (body agents are callers responsibility)', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 3,
      body: counterBody(100),
    })

    expect(result.stats.agentsSpawned).toBe(0)
  })

  it('has dropped=0 and truncated=0 always', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 5,
      body: counterBody(3),
    })

    expect(result.stats.dropped).toBe(0)
    expect(result.stats.truncated).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Iteration counting starts from 1, state accumulates correctly
// ---------------------------------------------------------------------------

describe('loopUntilDone — iteration and state tracking', () => {
  it('passes correct iteration numbers to body (1-based)', async () => {
    const rt = new FakeRuntime()
    const seenIterations: number[] = []

    await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 3,
      body: async (_rt, state, iteration) => {
        seenIterations.push(iteration)
        return { state: state + 1, progressed: true }
      },
    })

    expect(seenIterations).toEqual([1, 2, 3])
  })

  it('state flows from tick to tick correctly', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 'a',
      maxIterations: 3,
      body: async (_rt, state) => ({ state: state + 'x', progressed: true }),
    })

    expect(result.value.state).toBe('axxx')
  })
})

// ---------------------------------------------------------------------------
// Trail — multi-tick: length === iterations executed
// ---------------------------------------------------------------------------

describe('loopUntilDone — trail: multi-tick length === iterations', () => {
  it('trail is defined and length equals number of executed iterations', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 4,
      body: counterBody(100),  // never done naturally, stopped by maxIterations
    })

    expect(result.trail).toBeDefined()
    expect(result.value.iterations).toBe(4)
    expect(result.trail!.length).toBe(4)
    expect(result.trail!.length).toBe(result.value.iterations)
  })

  it('trail length matches when stopped by done before maxIterations', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 10,
      body: counterBody(3),  // done=true at iteration 3
    })

    expect(result.value.iterations).toBe(3)
    expect(result.trail!.length).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Trail — tick stages are 0-based loopUntilDone:tick:<i>
// ---------------------------------------------------------------------------

describe('loopUntilDone — trail: tick stage naming (0-based)', () => {
  it('stage names are loopUntilDone:tick:0, :1, :2 for 3 iterations', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 3,
      body: counterBody(100),
    })

    const stages = result.trail!.map(r => r.stage)
    expect(stages).toEqual([
      'loopUntilDone:tick:0',
      'loopUntilDone:tick:1',
      'loopUntilDone:tick:2',
    ])
  })

  it('trail records have no label (no agent spawned)', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 2,
      body: counterBody(100),
    })

    for (const rec of result.trail!) {
      expect(rec).not.toHaveProperty('label')
    }
  })
})

// ---------------------------------------------------------------------------
// Trail — outcome per tick reflects body result
// ---------------------------------------------------------------------------

describe('loopUntilDone — trail: outcome per tick', () => {
  it('outcome=ok when body returns non-null state', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 3,
      body: counterBody(100),
    })

    for (const rec of result.trail!) {
      expect(rec.outcome).toBe('ok')
    }
  })

  it('outcome=null when body returns null-like (null state value)', async () => {
    const rt = new FakeRuntime()
    let callCount = 0

    // body returns null state on tick 2 (index 1)
    const result = await loopUntilDone(rt, {
      initial: 0 as number | null,
      maxIterations: 3,
      body: async () => {
        callCount++
        if (callCount === 2) {
          return { state: null, progressed: false }
        }
        return { state: callCount, progressed: true }
      },
    })

    expect(result.trail![1]!.outcome).toBe('null')
    expect(result.trail![0]!.outcome).toBe('ok')
    expect(result.trail![2]!.outcome).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// Trail — stop-decision visible on last tick record
// ---------------------------------------------------------------------------

describe('loopUntilDone — trail: stop decision on last tick', () => {
  it('last trail record carries stoppedBy value as decision when stopped by maxIterations', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 3,
      body: counterBody(100),
    })

    const lastRec = result.trail![result.trail!.length - 1]!
    expect(lastRec.decision).toBe('maxIterations')
  })

  it('last trail record carries stoppedBy=done when body signals done', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 0,
      maxIterations: 10,
      body: counterBody(2),
    })

    const lastRec = result.trail![result.trail!.length - 1]!
    expect(lastRec.decision).toBe('done')
  })

  it('last trail record carries stoppedBy=dryRounds when dry limit hit', async () => {
    const rt = new FakeRuntime()

    const result = await loopUntilDone(rt, {
      initial: 0,
      dryRounds: 2,
      body: dryBody,
    })

    const lastRec = result.trail![result.trail!.length - 1]!
    expect(lastRec.decision).toBe('dryRounds')
  })
})

// ---------------------------------------------------------------------------
// Trail — zero-iteration edge case (budgetFloor fires before first body run)
// ---------------------------------------------------------------------------

describe('loopUntilDone — trail: zero iterations (empty trail)', () => {
  it('trail is an empty array when no iterations execute (budgetFloor fires immediately)', async () => {
    // total=10, floor=15 → remaining(10) <= floor(15) before first iteration
    const rt = new FakeRuntime({ budgetTotal: 10, agentTokenCost: 0 })

    const result = await loopUntilDone(rt, {
      initial: 0,
      budgetFloor: 15,
      maxIterations: 10,
      body: counterBody(100),
    })

    expect(result.value.iterations).toBe(0)
    expect(result.trail).toBeDefined()
    expect(result.trail!.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Trail — determinism: two runs produce identical trail
// ---------------------------------------------------------------------------

describe('loopUntilDone — trail: determinism', () => {
  it('two runs with same inputs produce identical trail', async () => {
    const makeRt = () => new FakeRuntime()
    const opts = () => ({
      initial: 0,
      maxIterations: 4,
      body: counterBody(100),
    } as const)

    const r1 = await loopUntilDone(makeRt(), opts())
    const r2 = await loopUntilDone(makeRt(), opts())

    expect(r1.trail).toEqual(r2.trail)
  })
})
