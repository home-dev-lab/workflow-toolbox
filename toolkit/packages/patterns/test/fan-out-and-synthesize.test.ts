import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import { fanOutAndSynthesize } from '../src/fan-out-and-synthesize.js'
import type { FanOutAndSynthesizeOptions } from '../src/fan-out-and-synthesize.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(
  overrides: Partial<FanOutAndSynthesizeOptions<string, string>> = {},
): FanOutAndSynthesizeOptions<string, string> {
  return {
    tasks: ['task-0', 'task-1', 'task-2'],
    taskPrompt: (task, i) => `process task ${i}: ${task}`,
    synthesisPrompt: (parts) => `synthesize: ${parts.join(', ')}`,
    ...overrides,
  }
}

// Detect synthesis call by label
function isSynthesisCall(label: string | undefined): boolean {
  return label === 'fanOutAndSynthesize:synthesize'
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — config validation', () => {
  it('rejects when tasks is empty', async () => {
    const rt = new FakeRuntime()
    await expect(fanOutAndSynthesize(rt, makeOptions({ tasks: [] }))).rejects.toThrow(/nothing to fan out/i)
  })

  it('rejects when maxItems < 1', async () => {
    const rt = new FakeRuntime()
    await expect(fanOutAndSynthesize(rt, makeOptions({ maxItems: 0 }))).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — happy path', () => {
  it('returns correct value, exact stats, and empty warnings', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synthesis-result'
        return 'part-result'
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions())

    expect(result.warnings).toHaveLength(0)
    expect(result.value).toBe('synthesis-result')
    expect(result.stats.itemsIn).toBe(3)
    expect(result.stats.itemsOut).toBe(3)
    expect(result.stats.dropped).toBe(0)
    expect(result.stats.truncated).toBe(0)
    // 3 task agents + 1 synthesis = 4
    expect(result.stats.agentsSpawned).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// All parts null → synthesis NOT spawned
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — all parts null', () => {
  it('returns null value, does NOT spawn synthesis, agentsSpawned = N', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synthesis'
        return null  // all task agents return null
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions())

    expect(result.value).toBeNull()
    // synthesis must NOT be spawned
    expect(rt.calls.find(c => isSynthesisCall(c.opts?.label))).toBeUndefined()
    expect(result.stats.agentsSpawned).toBe(3)  // only task agents
    expect(result.warnings.some(w => w.includes('synthesis skipped') || w.includes('no parts'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Synthesis null → value null + warning
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — synthesis null', () => {
  it('returns null and emits warning when synthesis agent returns null', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return null
        return 'part'
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions())

    expect(result.value).toBeNull()
    expect(result.warnings.some(w => w.includes('synthesis') && w.includes('null'))).toBe(true)
    expect(rt.logs.some(l => l.includes('synthesis') && l.includes('null'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Partial null fan-out
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — partial null fan-out', () => {
  it('drops null parts, warns, passes only non-null parts to synthesis', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) {
          // We'll verify parts via synthesisPrompt inspection
          return 'synthesis'
        }
        const label = opts?.label ?? ''
        // task:1 returns null
        if (label === 'fanOutAndSynthesize:task:1') return null
        return `part-from-${label}`
      },
    })

    const capturedPrompts: string[] = []
    const optsCopy = makeOptions({
      synthesisPrompt: (parts) => {
        capturedPrompts.push(...parts)
        return `synth: ${parts.join(',')}`
      },
    })

    const result = await fanOutAndSynthesize(rt, optsCopy)

    expect(result.stats.dropped).toBe(1)
    expect(result.stats.itemsOut).toBe(2)
    expect(result.warnings.some(w => w.includes('null'))).toBe(true)
    // synthesis received only non-null parts (2 parts)
    expect(capturedPrompts).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — truncation', () => {
  it('applies maxItems cap and reports truncated + warning', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        return 'part'
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions({
      tasks: ['a', 'b', 'c', 'd', 'e'],
      maxItems: 3,
    }))

    expect(result.stats.truncated).toBe(2)
    expect(result.stats.itemsIn).toBe(5)
    expect(result.stats.agentsSpawned).toBe(4)  // 3 tasks + 1 synthesis
    expect(result.warnings.some(w => w.includes('truncated'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Phase propagation
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — phase propagation', () => {
  it('forwards opts.phase to all agent calls', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        return 'part'
      },
    })

    await fanOutAndSynthesize(rt, makeOptions({ phase: 'fan-phase' }))

    expect(rt.calls.every(c => c.phase === 'fan-phase')).toBe(true)
  })

  it('leaves phase undefined when not set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        return 'part'
      },
    })

    await fanOutAndSynthesize(rt, makeOptions())

    expect(rt.calls.every(c => c.phase === undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — labels', () => {
  it('assigns correct label shapes to task and synthesis calls', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        return 'part'
      },
    })

    await fanOutAndSynthesize(rt, makeOptions({ tasks: ['x', 'y'] }))

    const labels = rt.calls.map(c => c.opts?.label)
    expect(labels).toContain('fanOutAndSynthesize:task:0')
    expect(labels).toContain('fanOutAndSynthesize:task:1')
    expect(labels).toContain('fanOutAndSynthesize:synthesize')
  })
})

// ---------------------------------------------------------------------------
// synthesisPrompt receives non-null parts in order
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — synthesisPrompt receives correct parts', () => {
  it('passes only non-null parts, in original order', async () => {
    const capturedParts: string[] = []

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'done'
        const label = opts?.label ?? ''
        if (label === 'fanOutAndSynthesize:task:1') return null
        return `result-${label.split(':').pop() ?? ''}`
      },
    })

    await fanOutAndSynthesize(rt, makeOptions({
      tasks: ['a', 'b', 'c'],
      synthesisPrompt: (parts) => {
        capturedParts.push(...parts)
        return 'synth'
      },
    }))

    // task:1 was null → only task:0 and task:2
    expect(capturedParts).toHaveLength(2)
    expect(capturedParts[0]).toBe('result-0')
    expect(capturedParts[1]).toBe('result-2')
  })
})

// ---------------------------------------------------------------------------
// Audit trail — B2b additions
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — trail: happy path', () => {
  it('returns defined trail with correct count, order, stages, and outcomes', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synthesis-result'
        return 'part-result'
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions())

    // trail must always be defined
    expect(result.trail).toBeDefined()
    const trail = result.trail!

    // invariant: trail.length === agentsSpawned (3 tasks + 1 synthesis = 4)
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(4)

    // task records come first, in index order [0..2]
    expect(trail[0]!.stage).toBe('fanOutAndSynthesize:task:0')
    expect(trail[0]!.outcome).toBe('ok')
    expect(trail[1]!.stage).toBe('fanOutAndSynthesize:task:1')
    expect(trail[1]!.outcome).toBe('ok')
    expect(trail[2]!.stage).toBe('fanOutAndSynthesize:task:2')
    expect(trail[2]!.outcome).toBe('ok')

    // synthesis record last
    expect(trail[3]!.stage).toBe('fanOutAndSynthesize:synthesize')
    expect(trail[3]!.outcome).toBe('ok')
  })

  it('has no decision field on any record (fanOut records carry no decision)', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synthesis-result'
        return 'part-result'
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions())
    for (const rec of result.trail!) {
      expect(rec).not.toHaveProperty('decision')
    }
  })
})

describe('fanOutAndSynthesize — trail: null-result cases', () => {
  it('records outcome=null for null task agents, invariant holds (all-null, no synthesis)', async () => {
    const rt = new FakeRuntime({
      onAgent: () => null,
    })

    const result = await fanOutAndSynthesize(rt, makeOptions())

    expect(result.trail).toBeDefined()
    const trail = result.trail!

    // synthesis NOT spawned → 3 records only
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(3)

    // all task records = outcome null, in index order
    expect(trail[0]!.stage).toBe('fanOutAndSynthesize:task:0')
    expect(trail[0]!.outcome).toBe('null')
    expect(trail[1]!.stage).toBe('fanOutAndSynthesize:task:1')
    expect(trail[1]!.outcome).toBe('null')
    expect(trail[2]!.stage).toBe('fanOutAndSynthesize:task:2')
    expect(trail[2]!.outcome).toBe('null')
  })

  it('records outcome=null for synthesis when synthesis agent returns null', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return null
        return 'part'
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions())

    expect(result.trail).toBeDefined()
    const trail = result.trail!

    // invariant: 3 tasks + 1 synthesis = 4
    expect(trail).toHaveLength(4)
    expect(trail[3]!.stage).toBe('fanOutAndSynthesize:synthesize')
    expect(trail[3]!.outcome).toBe('null')
  })

  it('records null outcome at correct index for a partial-null fan-out', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        if (opts?.label === 'fanOutAndSynthesize:task:1') return null
        return 'part'
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions())

    expect(result.trail).toBeDefined()
    const trail = result.trail!

    // 3 tasks + 1 synthesis = 4
    expect(trail).toHaveLength(4)
    expect(trail[0]!.outcome).toBe('ok')
    expect(trail[1]!.outcome).toBe('null')  // task:1 was null
    expect(trail[2]!.outcome).toBe('ok')
    expect(trail[3]!.outcome).toBe('ok')    // synthesis succeeded
  })
})

describe('fanOutAndSynthesize — trail: model override', () => {
  it('records model field on task records when taskModel is set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        return 'part'
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions({ taskModel: 'opus' }))

    const trail = result.trail!
    // task records carry model
    expect(trail[0]!.model).toBe('opus')
    expect(trail[1]!.model).toBe('opus')
    expect(trail[2]!.model).toBe('opus')
    // synthesis record has no model override
    expect(trail[3]!).not.toHaveProperty('model')
  })

  it('records model field on synthesis record when synthesisModel is set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        return 'part'
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions({ synthesisModel: 'sonnet' }))

    const trail = result.trail!
    // task records have no model override
    expect(trail[0]!).not.toHaveProperty('model')
    // synthesis record carries model
    expect(trail[3]!.model).toBe('sonnet')
  })

  it('omits model field when no model override is set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        return 'part'
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions())

    for (const rec of result.trail!) {
      expect(rec).not.toHaveProperty('model')
    }
  })
})

describe('fanOutAndSynthesize — trail: determinism', () => {
  it('produces identical trail on two runs of the same scenario', async () => {
    const makeRt = () => new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        return 'part'
      },
    })

    const resultA = await fanOutAndSynthesize(makeRt(), makeOptions())
    const resultB = await fanOutAndSynthesize(makeRt(), makeOptions())

    expect(resultA.trail).toEqual(resultB.trail)
  })
})

// ---------------------------------------------------------------------------
// Schema + model forwarding
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — schema/model forwarding', () => {
  it('forwards taskSchema to task agents', async () => {
    const taskSchema = { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] }
    let capturedSchema: unknown = null

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'done'
        capturedSchema = opts?.schema
        return { val: 'x' }
      },
    })

    await fanOutAndSynthesize(rt, makeOptions({ tasks: ['one'], taskSchema }))

    expect(capturedSchema).toEqual(taskSchema)
  })

  it('forwards synthesisModel to synthesis agent', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'done'
        return 'part'
      },
    })

    await fanOutAndSynthesize(rt, makeOptions({ synthesisModel: 'opus' }))

    const synthCall = rt.calls.find(c => isSynthesisCall(c.opts?.label))
    expect(synthCall?.opts?.model).toBe('opus')
  })
})
