import { describe, it, expect } from 'vitest'
import { FakeRuntime, parseDigest } from '@workflow-toolbox/runtime'
import { planAndExecute } from '../src/plan-and-execute.js'
import type { PlanAndExecuteOptions, PlannedSubtask, PlanAndExecuteResult } from '../src/plan-and-execute.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(
  overrides: Partial<PlanAndExecuteOptions<string>> = {},
): PlanAndExecuteOptions<string> {
  return {
    planPrompt: 'Create a plan for the task',
    workerPrompt: (subtask, i) => `execute subtask ${i}: ${subtask.description}`,
    synthesisPrompt: (results) => `synthesize: ${results.join(', ')}`,
    ...overrides,
  }
}

function makePlan(descriptions: string[]): { subtasks: PlannedSubtask[] } {
  return { subtasks: descriptions.map(d => ({ description: d })) }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('planAndExecute — config validation', () => {
  it('rejects when planPrompt is empty (trimmed)', async () => {
    const rt = new FakeRuntime()
    await expect(
      planAndExecute(rt, makeOptions({ planPrompt: '   ' })),
    ).rejects.toThrow(/planPrompt.*empty/)
  })

  it('rejects when maxSubtasks < 1', async () => {
    const rt = new FakeRuntime()
    await expect(
      planAndExecute(rt, makeOptions({ maxSubtasks: 0 })),
    ).rejects.toThrow(/maxSubtasks.*>=.*1/)
  })
})

// ---------------------------------------------------------------------------
// agentType routing (planType / workerType / synthesisType) — per-role
// cross-family routing.
// ---------------------------------------------------------------------------

function routingOnAgent({ opts }: { opts?: { label?: string } }): unknown {
  const label = opts?.label ?? ''
  if (label === 'planAndExecute:plan') return makePlan(['s0', 's1', 's2'])
  return 'ok'
}

describe('planAndExecute — agentType routing', () => {
  it('omits agentType on every call when none of planType/workerType/synthesisType is set', async () => {
    const rt = new FakeRuntime({ onAgent: routingOnAgent })
    await planAndExecute(rt, makeOptions())
    expect(rt.calls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('threads planType to the plan agent only', async () => {
    const rt = new FakeRuntime({ onAgent: routingOnAgent })
    await planAndExecute(rt, makeOptions({ planType: 'codex:codex-rescue' }))
    const planCalls = rt.calls.filter((c) => c.opts?.label === 'planAndExecute:plan')
    const otherCalls = rt.calls.filter((c) => c.opts?.label !== 'planAndExecute:plan')
    expect(planCalls.length).toBe(1)
    expect(planCalls.every((c) => c.opts?.agentType === 'codex:codex-rescue')).toBe(true)
    expect(otherCalls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('threads workerType to the worker agents only', async () => {
    const rt = new FakeRuntime({ onAgent: routingOnAgent })
    await planAndExecute(rt, makeOptions({ workerType: 'workflow-toolbox:opencode-verifier' }))
    const workCalls = rt.calls.filter((c) => c.opts?.label?.startsWith('planAndExecute:work:'))
    const otherCalls = rt.calls.filter((c) => !c.opts?.label?.startsWith('planAndExecute:work:'))
    expect(workCalls.length).toBe(3)
    expect(workCalls.every((c) => c.opts?.agentType === 'workflow-toolbox:opencode-verifier')).toBe(true)
    expect(otherCalls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('threads synthesisType to the synthesis agent only', async () => {
    const rt = new FakeRuntime({ onAgent: routingOnAgent })
    await planAndExecute(rt, makeOptions({ synthesisType: 'codex:codex-rescue' }))
    const synthCalls = rt.calls.filter((c) => c.opts?.label === 'planAndExecute:synthesize')
    const otherCalls = rt.calls.filter((c) => c.opts?.label !== 'planAndExecute:synthesize')
    expect(synthCalls.length).toBe(1)
    expect(synthCalls.every((c) => c.opts?.agentType === 'codex:codex-rescue')).toBe(true)
    expect(otherCalls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('rejects an empty or whitespace-only planType', async () => {
    const rt = new FakeRuntime()
    await expect(planAndExecute(rt, makeOptions({ planType: '' }))).rejects.toThrow(/planType/)
    await expect(planAndExecute(rt, makeOptions({ planType: '   ' }))).rejects.toThrow(/planType/)
  })

  it('rejects an empty or whitespace-only workerType', async () => {
    const rt = new FakeRuntime()
    await expect(planAndExecute(rt, makeOptions({ workerType: '' }))).rejects.toThrow(/workerType/)
    await expect(planAndExecute(rt, makeOptions({ workerType: '   ' }))).rejects.toThrow(/workerType/)
  })

  it('rejects an empty or whitespace-only synthesisType', async () => {
    const rt = new FakeRuntime()
    await expect(planAndExecute(rt, makeOptions({ synthesisType: '' }))).rejects.toThrow(/synthesisType/)
    await expect(planAndExecute(rt, makeOptions({ synthesisType: '   ' }))).rejects.toThrow(/synthesisType/)
  })
})

// ---------------------------------------------------------------------------
// Phase digest on the failure early-return
// ---------------------------------------------------------------------------

describe('planAndExecute — failure digest', () => {
  it('emits a digest when the planner produces no subtasks', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (opts?.label === 'planAndExecute:plan' ? makePlan([]) : null),
    })
    await planAndExecute(rt, makeOptions())
    const digest = rt.logs.map(parseDigest).find((d) => d?.stage === 'planAndExecute')
    expect(digest).toBeDefined()
    expect(digest?.counts).toEqual({ planned: 0, executed: 0, dropped: 0, truncated: 0 })
    expect(digest?.output).toBe('synthesis: none')
  })
})

// ---------------------------------------------------------------------------
// Loss-breakdown digest — dropped (null workers) + truncated (cap) are surfaced
// in the digest counts, not just in stats, so observe can render the loss funnel.
// ---------------------------------------------------------------------------

describe('planAndExecute — loss-breakdown digest', () => {
  const digestOf = (rt: FakeRuntime) =>
    rt.logs.map(parseDigest).find((d) => d?.stage === 'planAndExecute')

  it('a clean run emits zero losses (planned, executed, dropped:0, truncated:0)', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1', 's2'])
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })
    await planAndExecute(rt, makeOptions())
    expect(digestOf(rt)?.counts).toEqual({ planned: 3, executed: 3, dropped: 0, truncated: 0 })
  })

  it('surfaces BOTH dropped (null worker) and truncated (cap) in one breakdown', async () => {
    // Plan 5, cap to 3 (truncated=2); of the 3 kept workers, work:1 returns null (dropped=1).
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1', 's2', 's3', 's4'])
        if (label === 'planAndExecute:work:1') return null
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })
    const result = await planAndExecute(rt, makeOptions({ maxSubtasks: 3 }))
    // digest mirrors the stats loss counters (planned pre-cap = 5, executed = 2)
    expect(digestOf(rt)?.counts).toEqual({ planned: 5, executed: 2, dropped: 1, truncated: 2 })
    expect(result.stats.dropped).toBe(1)
    expect(result.stats.truncated).toBe(2)
  })

  it('the all-workers-failed early-return still emits the dropped count', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1'])
        if (label.startsWith('planAndExecute:work:')) return null
        return null
      },
    })
    await planAndExecute(rt, makeOptions())
    expect(digestOf(rt)?.counts).toEqual({ planned: 2, executed: 0, dropped: 2, truncated: 0 })
  })

  // The observe funnel (total=planned, survivor=executed, losses=[dropped,truncated]) only renders
  // correctly while planned === executed + dropped + truncated. That holds because `planned` is the
  // PRE-cap planner count (kept = planned − truncated; executed = kept − dropped). Guard the relation
  // STRUCTURALLY across scenarios so a future "simplify planned to the post-cap kept count" edit fails
  // here, and assert the digest counts mirror result.stats (no hand-maintained drift between them).
  it('every emit satisfies the funnel-balance invariant and mirrors result.stats', async () => {
    const scenarios: Array<{ plan: string[]; maxSubtasks?: number; nullWork: ReadonlySet<number> }> = [
      { plan: ['s0', 's1', 's2'], nullWork: new Set() },                                   // clean
      { plan: ['s0', 's1', 's2', 's3', 's4'], maxSubtasks: 3, nullWork: new Set([1]) },    // dropped + truncated
      { plan: ['s0', 's1'], nullWork: new Set([0, 1]) },                                    // all workers fail
    ]
    for (const sc of scenarios) {
      const rt = new FakeRuntime({
        onAgent: ({ opts }) => {
          const label = opts?.label ?? ''
          if (label === 'planAndExecute:plan') return makePlan(sc.plan)
          const m = /planAndExecute:work:(\d+)/.exec(label)
          if (m) return sc.nullWork.has(Number(m[1])) ? null : 'r'
          if (label === 'planAndExecute:synthesize') return 'done'
          return null
        },
      })
      const result = await planAndExecute(rt, makeOptions(sc.maxSubtasks !== undefined ? { maxSubtasks: sc.maxSubtasks } : {}))
      const c = digestOf(rt)!.counts as { planned: number; executed: number; dropped: number; truncated: number }
      expect(c.planned).toBe(c.executed + c.dropped + c.truncated)
      expect(c).toEqual({
        planned: result.stats.itemsIn,
        executed: result.stats.itemsOut,
        dropped: result.stats.dropped,
        truncated: result.stats.truncated,
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('planAndExecute — happy path', () => {
  it('returns synthesized value with correct stats', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['subtask-0', 'subtask-1', 'subtask-2'])
        if (label.startsWith('planAndExecute:work:')) return `result-${label.split(':').pop()}`
        if (label === 'planAndExecute:synthesize') return 'synthesis-result'
        return null
      },
    })

    const result = await planAndExecute(rt, makeOptions())

    expect(result.warnings).toHaveLength(0)
    expect(result.value).toBe('synthesis-result')
    // itemsIn = planned subtasks (pre-cap) = 3
    expect(result.stats.itemsIn).toBe(3)
    // itemsOut = non-null worker results = 3
    expect(result.stats.itemsOut).toBe(3)
    expect(result.stats.dropped).toBe(0)
    expect(result.stats.truncated).toBe(0)
    // 1 planner + 3 workers + 1 synthesis = 5
    expect(result.stats.agentsSpawned).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Planner returns null — short-circuit
// ---------------------------------------------------------------------------

describe('planAndExecute — planner null', () => {
  it('returns null when planner returns null, agentsSpawned=1, no workers or synthesis', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return null
        return 'should-not-be-called'
      },
    })

    const result = await planAndExecute(rt, makeOptions())

    expect(result.value).toBeNull()
    expect(result.stats.agentsSpawned).toBe(1)
    // No worker or synthesis calls
    const nonPlannerCalls = rt.calls.filter(c => c.opts?.label !== 'planAndExecute:plan')
    expect(nonPlannerCalls).toHaveLength(0)
    expect(result.warnings.some(w => w.includes('planner') && w.includes('null'))).toBe(true)
    // itemsIn = 0 (nothing planned)
    expect(result.stats.itemsIn).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cap on planner output
// ---------------------------------------------------------------------------

describe('planAndExecute — maxSubtasks cap', () => {
  it('caps planner output, reports truncation, itemsIn = pre-cap count', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1', 's2', 's3', 's4'])
        if (label.startsWith('planAndExecute:work:')) return 'result'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    const result = await planAndExecute(rt, makeOptions({ maxSubtasks: 2 }))

    // itemsIn = pre-cap count = 5
    expect(result.stats.itemsIn).toBe(5)
    expect(result.stats.truncated).toBe(3)
    // Only 2 workers spawned
    const workerCalls = rt.calls.filter(c => c.opts?.label?.startsWith('planAndExecute:work:'))
    expect(workerCalls).toHaveLength(2)
    expect(result.warnings.some(w => w.includes('truncated') || w.includes('maxSubtasks'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// All workers null — synthesis skipped
// ---------------------------------------------------------------------------

describe('planAndExecute — all workers null', () => {
  it('skips synthesis when all workers return null, returns null + warning', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1'])
        if (label.startsWith('planAndExecute:work:')) return null
        if (label === 'planAndExecute:synthesize') return 'should-not-be-called'
        return null
      },
    })

    const result = await planAndExecute(rt, makeOptions())

    expect(result.value).toBeNull()
    expect(rt.calls.find(c => c.opts?.label === 'planAndExecute:synthesize')).toBeUndefined()
    expect(result.warnings.some(w => w.includes('all workers failed') || w.includes('synthesis skipped'))).toBe(true)
    // agentsSpawned = 1 planner + 2 workers = 3 (no synthesis)
    expect(result.stats.agentsSpawned).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Partial workers null
// ---------------------------------------------------------------------------

describe('planAndExecute — partial workers null', () => {
  it('drops null workers, warns, synthesizes non-null results', async () => {
    const capturedResults: string[] = []

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1', 's2'])
        if (label === 'planAndExecute:work:0') return 'r0'
        if (label === 'planAndExecute:work:1') return null
        if (label === 'planAndExecute:work:2') return 'r2'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    await planAndExecute(rt, makeOptions({
      synthesisPrompt: (results) => {
        capturedResults.push(...results)
        return 'synth'
      },
    }))

    expect(capturedResults).toHaveLength(2)
    expect(capturedResults).toContain('r0')
    expect(capturedResults).toContain('r2')
  })
})

// ---------------------------------------------------------------------------
// Synthesis null → value null + warning
// ---------------------------------------------------------------------------

describe('planAndExecute — synthesis null', () => {
  it('returns null and emits warning when synthesis returns null', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1'])
        if (label.startsWith('planAndExecute:work:')) return 'result'
        if (label === 'planAndExecute:synthesize') return null
        return null
      },
    })

    const result = await planAndExecute(rt, makeOptions())

    expect(result.value).toBeNull()
    expect(result.warnings.some(w => w.includes('synthesis') && w.includes('null'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Phase forwarding
// ---------------------------------------------------------------------------

describe('planAndExecute — phase forwarding', () => {
  it('forwards phase to all agent calls', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0'])
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    await planAndExecute(rt, makeOptions({ phase: 'exec-phase' }))

    expect(rt.calls.every(c => c.phase === 'exec-phase')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe('planAndExecute — labels', () => {
  it('assigns correct label shapes for plan, work, synthesize calls', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1'])
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    await planAndExecute(rt, makeOptions())

    const labels = rt.calls.map(c => c.opts?.label)
    expect(labels).toContain('planAndExecute:plan')
    expect(labels).toContain('planAndExecute:work:0')
    expect(labels).toContain('planAndExecute:work:1')
    expect(labels).toContain('planAndExecute:synthesize')
  })
})

// ---------------------------------------------------------------------------
// Plan control schema shape
// ---------------------------------------------------------------------------

describe('planAndExecute — plan control schema', () => {
  it('forwards owned subtasks schema to planner call', async () => {
    let capturedSchema: unknown = null

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') {
          capturedSchema = opts?.schema
          return makePlan(['s0'])
        }
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    await planAndExecute(rt, makeOptions())

    expect(capturedSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        subtasks: expect.objectContaining({
          type: 'array',
          minItems: 1,
        }),
      }),
      required: expect.arrayContaining(['subtasks']),
      additionalProperties: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Model forwarding
// ---------------------------------------------------------------------------

describe('planAndExecute — model forwarding', () => {
  it('forwards planModel, workerModel, synthesisModel', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0'])
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    await planAndExecute(rt, makeOptions({
      planModel: 'opus',
      workerModel: 'haiku',
      synthesisModel: 'sonnet',
    }))

    const planCall = rt.calls.find(c => c.opts?.label === 'planAndExecute:plan')
    const workerCalls = rt.calls.filter(c => c.opts?.label?.startsWith('planAndExecute:work:'))
    const synthCall = rt.calls.find(c => c.opts?.label === 'planAndExecute:synthesize')

    expect(planCall?.opts?.model).toBe('opus')
    expect(workerCalls.every(c => c.opts?.model === 'haiku')).toBe(true)
    expect(synthCall?.opts?.model).toBe('sonnet')
  })
})

// ---------------------------------------------------------------------------
// workerPrompt receives subtask and index
// ---------------------------------------------------------------------------

describe('planAndExecute — workerPrompt', () => {
  it('passes subtask description and index to workerPrompt', async () => {
    const capturedCalls: Array<{ desc: string; idx: number }> = []

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['do-alpha', 'do-beta'])
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    await planAndExecute(rt, makeOptions({
      workerPrompt: (subtask, i) => {
        capturedCalls.push({ desc: subtask.description, idx: i })
        return `do: ${subtask.description}`
      },
    }))

    expect(capturedCalls).toHaveLength(2)
    expect(capturedCalls[0]).toEqual({ desc: 'do-alpha', idx: 0 })
    expect(capturedCalls[1]).toEqual({ desc: 'do-beta', idx: 1 })
  })
})

// ---------------------------------------------------------------------------
// workerResults — exposed in PlanAndExecuteResult
// ---------------------------------------------------------------------------

describe('planAndExecute — workerResults', () => {
  it('happy path: workerResults deep-equals scripted worker outputs in subtask order', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1', 's2'])
        if (label === 'planAndExecute:work:0') return 'result-0'
        if (label === 'planAndExecute:work:1') return 'result-1'
        if (label === 'planAndExecute:work:2') return 'result-2'
        if (label === 'planAndExecute:synthesize') return 'synthesis-output'
        return null
      },
    })

    const result = await planAndExecute(rt, makeOptions())

    expect(result.value).toBe('synthesis-output')
    expect((result as PlanAndExecuteResult<string, string>).workerResults).toEqual(['result-0', 'result-1', 'result-2'])
  })

  it('planner-null: workerResults is []', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (opts?.label === 'planAndExecute:plan') return null
        return 'should-not-be-called'
      },
    })

    const result = await planAndExecute(rt, makeOptions()) as PlanAndExecuteResult<string, string>

    expect(result.workerResults).toEqual([])
  })

  it('all-workers-null: workerResults is []', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1'])
        if (label.startsWith('planAndExecute:work:')) return null
        return 'should-not-be-called'
      },
    })

    const result = await planAndExecute(rt, makeOptions()) as PlanAndExecuteResult<string, string>

    expect(result.workerResults).toEqual([])
  })

  it('partial failure: workerResults contains survivors in index order', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1', 's2'])
        if (label === 'planAndExecute:work:0') return 'r0'
        if (label === 'planAndExecute:work:1') return null
        if (label === 'planAndExecute:work:2') return 'r2'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    const result = await planAndExecute(rt, makeOptions()) as PlanAndExecuteResult<string, string>

    // survivors in index order: r0 first, r2 second
    expect(result.workerResults).toEqual(['r0', 'r2'])
  })
})

// ---------------------------------------------------------------------------
// trail — audit trail population
// ---------------------------------------------------------------------------

describe('planAndExecute — trail', () => {
  it('planner-null: trail has exactly 1 record (planner) with outcome null', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (opts?.label === 'planAndExecute:plan') return null
        return 'should-not-be-called'
      },
    })

    const result = await planAndExecute(rt, makeOptions()) as PlanAndExecuteResult<string, string>

    expect(result.trail).toHaveLength(1)
    expect(result.trail![0]).toEqual({
      stage: 'planAndExecute:plan',
      outcome: 'null',
    })
    // invariant: trail.length === agentsSpawned
    expect(result.trail!.length).toBe(result.stats.agentsSpawned)
  })

  it('all-workers-null: trail has planner + workers, NO synthesis record', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1'])
        if (label.startsWith('planAndExecute:work:')) return null
        return 'should-not-be-called'
      },
    })

    const result = await planAndExecute(rt, makeOptions()) as PlanAndExecuteResult<string, string>
    const trail = result.trail!

    // 1 planner + 2 workers = 3 records, no synthesis
    expect(trail).toHaveLength(3)
    expect(trail.at(0)!.stage).toBe('planAndExecute:plan')
    expect(trail.at(0)!.outcome).toBe('ok')
    expect(trail.at(1)!.stage).toBe('planAndExecute:work:0')
    expect(trail.at(1)!.outcome).toBe('null')
    expect(trail.at(2)!.stage).toBe('planAndExecute:work:1')
    expect(trail.at(2)!.outcome).toBe('null')
    // no synthesis record
    expect(trail.find(r => r.stage === 'planAndExecute:synthesize')).toBeUndefined()
    // invariant
    expect(trail.length).toBe(result.stats.agentsSpawned)
  })

  it('partial failure: null worker record at the right index position with outcome null', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1', 's2'])
        if (label === 'planAndExecute:work:0') return 'r0'
        if (label === 'planAndExecute:work:1') return null
        if (label === 'planAndExecute:work:2') return 'r2'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    const result = await planAndExecute(rt, makeOptions()) as PlanAndExecuteResult<string, string>

    // trail: planner(ok), work:0(ok), work:1(null), work:2(ok), synthesize(ok) = 5
    expect(result.trail).toHaveLength(5)
    const work1 = result.trail!.find(r => r.stage === 'planAndExecute:work:1')
    expect(work1).toBeDefined()
    expect(work1!.outcome).toBe('null')
    const work0 = result.trail!.find(r => r.stage === 'planAndExecute:work:0')
    expect(work0!.outcome).toBe('ok')
    const work2 = result.trail!.find(r => r.stage === 'planAndExecute:work:2')
    expect(work2!.outcome).toBe('ok')
    // invariant
    expect(result.trail!.length).toBe(result.stats.agentsSpawned)
  })

  it('model overrides: trail records carry model when set, absent when unset', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0'])
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    const result = await planAndExecute(rt, makeOptions({
      planModel: 'opus',
      workerModel: 'haiku',
      synthesisModel: 'sonnet',
    })) as PlanAndExecuteResult<string, string>

    const planRec = result.trail!.find(r => r.stage === 'planAndExecute:plan')
    const workRec = result.trail!.find(r => r.stage === 'planAndExecute:work:0')
    const synthRec = result.trail!.find(r => r.stage === 'planAndExecute:synthesize')

    expect(planRec!.model).toBe('opus')
    expect(workRec!.model).toBe('haiku')
    expect(synthRec!.model).toBe('sonnet')
  })

  it('no model overrides: model key is ABSENT (not undefined-valued) on all trail records', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0'])
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    const result = await planAndExecute(rt, makeOptions()) as PlanAndExecuteResult<string, string>

    for (const rec of result.trail!) {
      expect(rec).not.toHaveProperty('model')
    }
  })

  it('decision: planner ok record has decision subtasks=<n> reflecting post-cap count', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1', 's2', 's3', 's4'])
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    // maxSubtasks=3 caps from 5 → 3
    const result = await planAndExecute(rt, makeOptions({ maxSubtasks: 3 })) as PlanAndExecuteResult<string, string>

    const planRec = result.trail!.find(r => r.stage === 'planAndExecute:plan')
    expect(planRec!.decision).toBe('subtasks=3')
  })

  it('decision: planner ok without cap reflects full subtask count', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1'])
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    const result = await planAndExecute(rt, makeOptions()) as PlanAndExecuteResult<string, string>

    const planRec = result.trail!.find(r => r.stage === 'planAndExecute:plan')
    expect(planRec!.decision).toBe('subtasks=2')
  })

  it('determinism: same scripted scenario twice produces identical trails', async () => {
    function makeRt() {
      return new FakeRuntime({
        onAgent: ({ opts }) => {
          const label = opts?.label ?? ''
          if (label === 'planAndExecute:plan') return makePlan(['s0', 's1', 's2'])
          if (label === 'planAndExecute:work:0') return 'r0'
          if (label === 'planAndExecute:work:1') return null
          if (label === 'planAndExecute:work:2') return 'r2'
          if (label === 'planAndExecute:synthesize') return 'synth'
          return null
        },
      })
    }

    const resultA = await planAndExecute(makeRt(), makeOptions()) as PlanAndExecuteResult<string, string>
    const resultB = await planAndExecute(makeRt(), makeOptions()) as PlanAndExecuteResult<string, string>

    expect(resultA.trail).toEqual(resultB.trail)
  })

  it('happy path: full trail has planner+workers+synthesis, invariant holds', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1'])
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    const result = await planAndExecute(rt, makeOptions()) as PlanAndExecuteResult<string, string>
    const trail = result.trail!

    // 1 planner + 2 workers + 1 synthesis = 4
    expect(trail).toHaveLength(4)
    expect(trail.at(0)!.stage).toBe('planAndExecute:plan')
    expect(trail.at(0)!.outcome).toBe('ok')
    expect(trail.at(1)!.stage).toBe('planAndExecute:work:0')
    expect(trail.at(2)!.stage).toBe('planAndExecute:work:1')
    const synthRec = trail.find(r => r.stage === 'planAndExecute:synthesize')
    expect(synthRec).toBeDefined()
    expect(synthRec!.outcome).toBe('ok')
    // invariant
    expect(trail.length).toBe(result.stats.agentsSpawned)
  })
})

// ---------------------------------------------------------------------------
// Effort forwarding
// ---------------------------------------------------------------------------

describe('planAndExecute — effort forwarding', () => {
  it('forwards planEffort, workerEffort, synthesisEffort', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0'])
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    await planAndExecute(rt, makeOptions({
      planEffort: 'high',
      workerEffort: 'medium',
      synthesisEffort: 'max',
    }))

    const planCall = rt.calls.find(c => c.opts?.label === 'planAndExecute:plan')
    const workerCalls = rt.calls.filter(c => c.opts?.label?.startsWith('planAndExecute:work:'))
    const synthCall = rt.calls.find(c => c.opts?.label === 'planAndExecute:synthesize')

    expect(planCall?.opts?.effort).toBe('high')
    expect(workerCalls.every(c => c.opts?.effort === 'medium')).toBe(true)
    expect(synthCall?.opts?.effort).toBe('max')
  })
})

// ---------------------------------------------------------------------------
// Effort in the audit trail
// ---------------------------------------------------------------------------

describe('planAndExecute — trail: effort field', () => {
  it('effort overrides: trail records carry effort when set, absent when unset', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0'])
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    const result = await planAndExecute(rt, makeOptions({
      planEffort: 'high',
      workerEffort: 'medium',
      synthesisEffort: 'max',
    })) as PlanAndExecuteResult<string, string>

    const planRec = result.trail!.find(r => r.stage === 'planAndExecute:plan')
    const workRec = result.trail!.find(r => r.stage === 'planAndExecute:work:0')
    const synthRec = result.trail!.find(r => r.stage === 'planAndExecute:synthesize')

    expect(planRec!.effort).toBe('high')
    expect(workRec!.effort).toBe('medium')
    expect(synthRec!.effort).toBe('max')
  })

  it('no effort overrides: effort key is ABSENT (not undefined-valued) on all trail records', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0'])
        if (label.startsWith('planAndExecute:work:')) return 'r'
        if (label === 'planAndExecute:synthesize') return 'done'
        return null
      },
    })

    const result = await planAndExecute(rt, makeOptions()) as PlanAndExecuteResult<string, string>

    for (const rec of result.trail!) {
      expect(rec).not.toHaveProperty('effort')
    }
  })
})

// ---------------------------------------------------------------------------
// cacheWarm (opt-in, mechanism a — first-completes-then-burst, on the WORKER stage)
// ---------------------------------------------------------------------------

describe('planAndExecute — cacheWarm=false (default, inert)', () => {
  it('is byte-identical to omitting the option: same stats, same trail', async () => {
    const onAgent = ({ opts }: { opts?: { label?: string } }): unknown => {
      const label = opts?.label ?? ''
      if (label === 'planAndExecute:plan') return makePlan(['s0', 's1', 's2'])
      if (label.startsWith('planAndExecute:work:')) return 'r'
      if (label === 'planAndExecute:synthesize') return 'done'
      return null
    }

    const rtOmitted = new FakeRuntime({ onAgent })
    const rtFalse = new FakeRuntime({ onAgent })

    const resultOmitted = await planAndExecute(rtOmitted, makeOptions())
    const resultFalse = await planAndExecute(rtFalse, makeOptions({ cacheWarm: false }))

    expect(resultFalse.stats).toEqual(resultOmitted.stats)
    expect(resultFalse.trail).toEqual(resultOmitted.trail)
    expect(rtFalse.calls.map(c => c.opts?.label)).toEqual(rtOmitted.calls.map(c => c.opts?.label))
  })
})

describe('planAndExecute — cacheWarm=true (staggered)', () => {
  it('awaits work:0 to completion before work:1/work:2 are invoked', async () => {
    let laterWorkerStartedBeforeFirstResolved = false
    let firstResolved = false
    let resolveFirst: (v: string) => void = () => {}

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = opts?.label ?? ''
        if (label === 'planAndExecute:plan') return makePlan(['s0', 's1', 's2'])
        if (label === 'planAndExecute:synthesize') return 'done'
        if (label === 'planAndExecute:work:0') {
          return new Promise<string>((resolve) => {
            resolveFirst = (v) => { firstResolved = true; resolve(v) }
          })
        }
        if (!firstResolved) laterWorkerStartedBeforeFirstResolved = true
        return 'r'
      },
    })

    const promise = planAndExecute(rt, makeOptions({ cacheWarm: true }))
    // Flush enough microtasks for the plan call (a real awaited agent() call)
    // to resolve and the worker fan-out to begin.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(laterWorkerStartedBeforeFirstResolved).toBe(false)
    const workerLabelsSeen = rt.calls.map(c => c.opts?.label).filter(l => l?.startsWith('planAndExecute:work:'))
    expect(workerLabelsSeen).toEqual(['planAndExecute:work:0'])

    resolveFirst('r0')
    const result = await promise as PlanAndExecuteResult<string, string>

    expect(result.stats.agentsSpawned).toBe(5) // 1 plan + 3 workers + 1 synthesis
  })

  it('does not add an extra agent — stats/agentsSpawned match the un-staggered run', async () => {
    const onAgent = ({ opts }: { opts?: { label?: string } }): unknown => {
      const label = opts?.label ?? ''
      if (label === 'planAndExecute:plan') return makePlan(['s0', 's1', 's2'])
      if (label.startsWith('planAndExecute:work:')) return 'r'
      if (label === 'planAndExecute:synthesize') return 'done'
      return null
    }

    const rtWarm = new FakeRuntime({ onAgent })
    const rtPlain = new FakeRuntime({ onAgent })

    const resultWarm = await planAndExecute(rtWarm, makeOptions({ cacheWarm: true }))
    const resultPlain = await planAndExecute(rtPlain, makeOptions())

    expect(resultWarm.stats).toEqual(resultPlain.stats)
    expect(resultWarm.trail).toEqual(resultPlain.trail)
  })
})
