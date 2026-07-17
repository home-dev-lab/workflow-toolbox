import { describe, it, expect } from 'vitest'
import { FakeRuntime, parseDigest } from '@workflow-toolbox/runtime'
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
    // cacheWarm now defaults to TRUE at the pattern level — pin it false here
    // so every PRE-EXISTING test in this file keeps testing exactly what it
    // always tested, decoupled from the new default. The cacheWarm-specific
    // describe blocks below override this explicitly where they need to.
    cacheWarm: false,
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
// agentType routing (taskType / synthesisType) — per-role cross-family routing
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — agentType routing', () => {
  it('omits agentType on every call when neither taskType nor synthesisType is set', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ok' })
    await fanOutAndSynthesize(rt, makeOptions())
    expect(rt.calls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('threads taskType to the fan-out task agents only (not synthesis)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ok' })
    await fanOutAndSynthesize(rt, makeOptions({ taskType: 'codex:codex-rescue' }))
    const taskCalls = rt.calls.filter((c) => !isSynthesisCall(c.opts?.label))
    const synthCalls = rt.calls.filter((c) => isSynthesisCall(c.opts?.label))
    expect(taskCalls.length).toBe(3)
    expect(taskCalls.every((c) => c.opts?.agentType === 'codex:codex-rescue')).toBe(true)
    expect(synthCalls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('threads synthesisType to the synthesis agent only (not the tasks)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ok' })
    await fanOutAndSynthesize(rt, makeOptions({ synthesisType: 'workflow-toolbox:opencode-verifier' }))
    const taskCalls = rt.calls.filter((c) => !isSynthesisCall(c.opts?.label))
    const synthCalls = rt.calls.filter((c) => isSynthesisCall(c.opts?.label))
    expect(synthCalls.length).toBe(1)
    expect(synthCalls.every((c) => c.opts?.agentType === 'workflow-toolbox:opencode-verifier')).toBe(true)
    expect(taskCalls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('rejects an empty or whitespace-only taskType', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ok' })
    await expect(fanOutAndSynthesize(rt, makeOptions({ taskType: '' }))).rejects.toThrow(/taskType/)
    await expect(fanOutAndSynthesize(rt, makeOptions({ taskType: '   ' }))).rejects.toThrow(/taskType/)
  })

  it('rejects an empty or whitespace-only synthesisType', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ok' })
    await expect(fanOutAndSynthesize(rt, makeOptions({ synthesisType: '' }))).rejects.toThrow(/synthesisType/)
    await expect(fanOutAndSynthesize(rt, makeOptions({ synthesisType: '   ' }))).rejects.toThrow(/synthesisType/)
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — happy path', () => {
  it('emits a phase digest with the synthesis handoff output + task counts', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'synthesis-result' : 'part-result'),
    })
    await fanOutAndSynthesize(rt, makeOptions({ phase: 'fan-phase' }))
    const digest = rt.logs.map(parseDigest).find((d) => d?.stage === 'fanOutAndSynthesize')
    expect(digest?.counts).toEqual({ tasks: 3, completed: 3 })
    expect(digest?.output).toBe('synthesis from 3/3 tasks')
    expect(digest?.phase).toBe('fan-phase')
  })

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

// ---------------------------------------------------------------------------
// Effort forwarding
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — effort forwarding', () => {
  it('forwards taskEffort to task agents and synthesisEffort to synthesis agent', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'done'
        return 'part'
      },
    })

    await fanOutAndSynthesize(rt, makeOptions({ taskEffort: 'low', synthesisEffort: 'high' }))

    const taskCalls = rt.calls.filter(c => !isSynthesisCall(c.opts?.label))
    const synthCall = rt.calls.find(c => isSynthesisCall(c.opts?.label))

    expect(taskCalls.every(c => c.opts?.effort === 'low')).toBe(true)
    expect(synthCall?.opts?.effort).toBe('high')
  })
})

// ---------------------------------------------------------------------------
// Effort in the audit trail
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// cacheWarm (default TRUE, mechanism a — first-completes-then-burst; opt OUT
// with cacheWarm: false)
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — cacheWarm=false (explicit opt-out)', () => {
  it('disables staggering entirely: later tasks start before task:0 resolves', async () => {
    let laterTaskStartedBeforeFirstResolved = false
    let firstResolved = false
    let resolveFirst: (v: string) => void = () => {}

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        if (opts?.label === 'fanOutAndSynthesize:task:0') {
          return new Promise<string>((resolve) => {
            resolveFirst = (v) => { firstResolved = true; resolve(v) }
          })
        }
        if (!firstResolved) laterTaskStartedBeforeFirstResolved = true
        return 'part'
      },
    })

    const promise = fanOutAndSynthesize(rt, makeOptions({ cacheWarm: false }))
    await Promise.resolve()
    await Promise.resolve()

    expect(laterTaskStartedBeforeFirstResolved).toBe(true)
    resolveFirst('part-from-0')
    await promise
  })

  it('produces identical stats/trail to cacheWarm:true — cacheWarm only affects timing, not outcome', async () => {
    const responses = ['part-a', 'part-b', 'part-c', 'synthesis']
    const rtFalse = new FakeRuntime({ responses })
    const rtTrue = new FakeRuntime({ responses })

    const resultFalse = await fanOutAndSynthesize(rtFalse, makeOptions({ cacheWarm: false }))
    const resultTrue = await fanOutAndSynthesize(rtTrue, makeOptions({ cacheWarm: true }))

    expect(resultFalse.stats).toEqual(resultTrue.stats)
    expect(resultFalse.trail).toEqual(resultTrue.trail)
    expect(resultFalse.value).toEqual(resultTrue.value)
  })
})

describe('fanOutAndSynthesize — cacheWarm omitted (defaults to TRUE)', () => {
  it('stagger by default when the option is not passed at all', async () => {
    let laterTaskStartedBeforeFirstResolved = false
    let firstResolved = false
    let resolveFirst: (v: string) => void = () => {}

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        if (opts?.label === 'fanOutAndSynthesize:task:0') {
          return new Promise<string>((resolve) => {
            resolveFirst = (v) => { firstResolved = true; resolve(v) }
          })
        }
        if (!firstResolved) laterTaskStartedBeforeFirstResolved = true
        return 'part'
      },
    })

    // Bypass this file's makeOptions() (which pins cacheWarm:false for the
    // OTHER tests in this file) — construct the options object directly, with
    // the cacheWarm key genuinely ABSENT, to prove the PATTERN's own default.
    const promise = fanOutAndSynthesize(rt, {
      tasks: ['task-0', 'task-1', 'task-2'],
      taskPrompt: (task, i) => `process task ${i}: ${task}`,
      synthesisPrompt: (parts) => `synthesize: ${parts.join(', ')}`,
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(laterTaskStartedBeforeFirstResolved).toBe(false)
    resolveFirst('part-from-0')
    await promise
  })
})

describe('fanOutAndSynthesize — cacheWarm=true (staggered)', () => {
  it('awaits task:0 to completion before task:1/task:2 are invoked', async () => {
    let laterTaskStartedBeforeFirstResolved = false
    let firstResolved = false
    let resolveFirst: (v: string) => void = () => {}

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        if (opts?.label === 'fanOutAndSynthesize:task:0') {
          return new Promise<string>((resolve) => {
            resolveFirst = (v) => { firstResolved = true; resolve(v) }
          })
        }
        if (!firstResolved) laterTaskStartedBeforeFirstResolved = true
        return 'part'
      },
    })

    const promise = fanOutAndSynthesize(rt, makeOptions({ cacheWarm: true }))
    await Promise.resolve()
    await Promise.resolve()

    expect(laterTaskStartedBeforeFirstResolved).toBe(false)
    expect(rt.calls.map(c => c.opts?.label)).toEqual(['fanOutAndSynthesize:task:0'])

    resolveFirst('part-from-0')
    const result = await promise

    expect(result.stats.agentsSpawned).toBe(4)
    expect(result.stats.dropped).toBe(0)
  })

  it('does not add an extra agent — stats/agentsSpawned match the un-staggered run', async () => {
    const responses = ['part-a', 'part-b', 'part-c', 'synthesis']
    const rtWarm = new FakeRuntime({ responses })
    const rtPlain = new FakeRuntime({ responses })

    const resultWarm = await fanOutAndSynthesize(rtWarm, makeOptions({ cacheWarm: true }))
    const resultPlain = await fanOutAndSynthesize(rtPlain, makeOptions())

    expect(resultWarm.stats).toEqual(resultPlain.stats)
    expect(resultWarm.trail).toEqual(resultPlain.trail)
  })

  it('is a no-op (no staggering) when there is only 1 task', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isSynthesisCall(opts?.label) ? 'synth' : 'part'),
    })

    const result = await fanOutAndSynthesize(rt, makeOptions({ tasks: ['only'], cacheWarm: true }))

    expect(result.stats.agentsSpawned).toBe(2) // 1 task + 1 synthesis
    expect(rt.calls.map(c => c.opts?.label)).toEqual([
      'fanOutAndSynthesize:task:0',
      'fanOutAndSynthesize:synthesize',
    ])
  })
})

describe('fanOutAndSynthesize — trail: effort override', () => {
  it('records effort field on task records when taskEffort is set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        return 'part'
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions({ taskEffort: 'low' }))

    const trail = result.trail!
    expect(trail[0]!.effort).toBe('low')
    expect(trail[1]!.effort).toBe('low')
    expect(trail[2]!.effort).toBe('low')
    // synthesis record has no effort override
    expect(trail[3]!).not.toHaveProperty('effort')
  })

  it('records effort field on synthesis record when synthesisEffort is set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        return 'part'
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions({ synthesisEffort: 'high' }))

    const trail = result.trail!
    // task records have no effort override
    expect(trail[0]!).not.toHaveProperty('effort')
    // synthesis record carries effort
    expect(trail[3]!.effort).toBe('high')
  })

  it('omits effort field when no effort override is set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isSynthesisCall(opts?.label)) return 'synth'
        return 'part'
      },
    })

    const result = await fanOutAndSynthesize(rt, makeOptions())

    for (const rec of result.trail!) {
      expect(rec).not.toHaveProperty('effort')
    }
  })
})

// ---------------------------------------------------------------------------
// Stage salting (card #1816036725248493168) — per-invocation discriminator
// ---------------------------------------------------------------------------

describe('fanOutAndSynthesize — stage salting', () => {
  const salterOnAgent = ({ opts }: { opts?: { label?: string } }): unknown =>
    opts?.label?.includes(':synthesize') === true ? 'synth' : 'part'

  const singleTaskOpts = { tasks: ['task-0'] }

  it('two invocations on the SAME rt: first bare, second salted " #2" on every label', async () => {
    const rt = new FakeRuntime({ onAgent: salterOnAgent })

    await fanOutAndSynthesize(rt, makeOptions(singleTaskOpts))
    const firstLabels = rt.calls.map((c) => c.opts?.label)

    await fanOutAndSynthesize(rt, makeOptions(singleTaskOpts))
    const secondLabels = rt.calls.slice(firstLabels.length).map((c) => c.opts?.label)

    expect(firstLabels).toEqual(['fanOutAndSynthesize:task:0', 'fanOutAndSynthesize:synthesize'])
    expect(secondLabels).toEqual(['fanOutAndSynthesize:task:0 #2', 'fanOutAndSynthesize:synthesize #2'])
  })

  it('trail.stage === the rt.agent label for the same step, on the salted (2nd) invocation', async () => {
    const rt = new FakeRuntime({ onAgent: salterOnAgent })
    await fanOutAndSynthesize(rt, makeOptions(singleTaskOpts))
    const result = await fanOutAndSynthesize(rt, makeOptions(singleTaskOpts))

    const secondCalls = rt.calls.slice(2)
    for (const record of result.trail) {
      const match = secondCalls.find((c) => c.opts?.label === record.stage)
      expect(match, `no rt.agent call found with label === trail.stage "${record.stage}"`).toBeDefined()
    }
    expect(result.trail.map((r) => r.stage)).toEqual([
      'fanOutAndSynthesize:task:0 #2',
      'fanOutAndSynthesize:synthesize #2',
    ])
  })

  it('an explicit stageKey salts every stage/label of that invocation, including a salvage record', async () => {
    // the task call returns null once → structured-output salvage respawn
    // fires (fanOutAndSynthesize's task has no schema by default, so — like
    // classifyAndAct's generate stage — the native call goes through the
    // schema-less passthrough and salvage never fires there; use taskSchema
    // to force the schema-bearing path).
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (opts?.label?.includes(':task:') === true ? null : 'not-json'),
    })

    const result = await fanOutAndSynthesize(rt, makeOptions({
      ...singleTaskOpts,
      taskSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false },
      stageKey: 'my-key',
    }))

    expect(rt.calls.map((c) => c.opts?.label)).toEqual([
      'fanOutAndSynthesize:task:0 #my-key',
      'fanOutAndSynthesize:task:0 #my-key:salvage',
    ])
    expect(result.trail.map((r) => r.stage)).toEqual([
      'fanOutAndSynthesize:task:0 #my-key',
      'fanOutAndSynthesize:task:0 #my-key:salvage',
    ])
    expect(result.warnings.join(' ')).not.toMatch(/stageKey/)
  })

  it('distinct rt instances stay isolated — both get the bare first invocation', async () => {
    const rt1 = new FakeRuntime({ onAgent: salterOnAgent })
    const rt2 = new FakeRuntime({ onAgent: salterOnAgent })

    await fanOutAndSynthesize(rt1, makeOptions(singleTaskOpts))
    await fanOutAndSynthesize(rt2, makeOptions(singleTaskOpts))

    expect(rt1.calls.map((c) => c.opts?.label)).toEqual(['fanOutAndSynthesize:task:0', 'fanOutAndSynthesize:synthesize'])
    expect(rt2.calls.map((c) => c.opts?.label)).toEqual(['fanOutAndSynthesize:task:0', 'fanOutAndSynthesize:synthesize'])
  })

  it('digest.stage stays bare even on a salted (2nd) invocation', async () => {
    const rt = new FakeRuntime({ onAgent: salterOnAgent })
    await fanOutAndSynthesize(rt, makeOptions(singleTaskOpts))
    await fanOutAndSynthesize(rt, makeOptions(singleTaskOpts))

    const digests = rt.logs.map(parseDigest).filter((d) => d?.stage === 'fanOutAndSynthesize')
    expect(digests).toHaveLength(2)
    for (const d of digests) expect(d?.stage).toBe('fanOutAndSynthesize')
  })
})
