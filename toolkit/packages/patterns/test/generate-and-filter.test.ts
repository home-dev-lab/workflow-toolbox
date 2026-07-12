import { describe, it, expect } from 'vitest'
import { FakeRuntime, parseDigest } from '@workflow-toolbox/runtime'
import { generateAndFilter } from '../src/generate-and-filter.js'
import type { GenerateAndFilterOptions } from '../src/generate-and-filter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(
  overrides: Partial<GenerateAndFilterOptions<string>> = {},
): GenerateAndFilterOptions<string> {
  return {
    count: 3,
    generatePrompt: (i) => `generate candidate ${i}`,
    filterPrompt: (c) => `filter: ${c}`,
    // cacheWarm now defaults to TRUE at the pattern level — pin it false here
    // so every PRE-EXISTING test in this file keeps testing exactly what it
    // always tested, decoupled from the new default.
    cacheWarm: false,
    ...overrides,
  }
}

// Control schema shape returned by the filter stage
const FILTER_SCHEMA_SHAPE = {
  type: 'object',
  properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['pass', 'reason'],
  additionalProperties: false,
}

// Detect if a call is a filter call (has the filter control schema)
function isFilterCall(opts: unknown): boolean {
  const o = opts as { schema?: { properties?: { pass?: unknown; reason?: unknown } } } | undefined
  return o?.schema?.properties?.pass !== undefined && o?.schema?.properties?.reason !== undefined
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('generateAndFilter — config validation', () => {
  it('rejects when count < 1', async () => {
    const rt = new FakeRuntime()
    await expect(generateAndFilter(rt, makeOptions({ count: 0 }))).rejects.toThrow()
    await expect(generateAndFilter(rt, makeOptions({ count: -1 }))).rejects.toThrow()
  })

  it('rejection message mentions count', async () => {
    const rt = new FakeRuntime()
    await expect(generateAndFilter(rt, makeOptions({ count: 0 }))).rejects.toThrow(/count/i)
  })
})

// ---------------------------------------------------------------------------
// agentType routing (generateType / filterType) — per-role cross-family routing
// ---------------------------------------------------------------------------

describe('generateAndFilter — agentType routing', () => {
  it('omits agentType on every call when neither generateType nor filterType is set', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ok' })
    await generateAndFilter(rt, makeOptions())
    expect(rt.calls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('threads generateType to the generate agents only (not filter)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ok' })
    await generateAndFilter(rt, makeOptions({ generateType: 'codex:codex-rescue' }))
    const generateCalls = rt.calls.filter((c) => c.opts?.label?.startsWith('generateAndFilter:generate:'))
    const filterCalls = rt.calls.filter((c) => c.opts?.label?.startsWith('generateAndFilter:filter:'))
    expect(generateCalls.length).toBe(3)
    expect(generateCalls.every((c) => c.opts?.agentType === 'codex:codex-rescue')).toBe(true)
    expect(filterCalls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('threads filterType to the filter agents only (not generate)', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ok' })
    await generateAndFilter(rt, makeOptions({ filterType: 'workflow-toolbox:opencode-verifier' }))
    const generateCalls = rt.calls.filter((c) => c.opts?.label?.startsWith('generateAndFilter:generate:'))
    const filterCalls = rt.calls.filter((c) => c.opts?.label?.startsWith('generateAndFilter:filter:'))
    expect(filterCalls.length).toBe(3)
    expect(filterCalls.every((c) => c.opts?.agentType === 'workflow-toolbox:opencode-verifier')).toBe(true)
    expect(generateCalls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('rejects an empty or whitespace-only generateType', async () => {
    const rt = new FakeRuntime()
    await expect(generateAndFilter(rt, makeOptions({ generateType: '' }))).rejects.toThrow(/generateType/)
    await expect(generateAndFilter(rt, makeOptions({ generateType: '   ' }))).rejects.toThrow(/generateType/)
  })

  it('rejects an empty or whitespace-only filterType', async () => {
    const rt = new FakeRuntime()
    await expect(generateAndFilter(rt, makeOptions({ filterType: '' }))).rejects.toThrow(/filterType/)
    await expect(generateAndFilter(rt, makeOptions({ filterType: '   ' }))).rejects.toThrow(/filterType/)
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('generateAndFilter — happy path', () => {
  it('emits a phase digest with generated/kept/rejected/failed counts', async () => {
    let n = 0
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) {
          n++
          return n === 1 ? { pass: false, reason: 'too noisy' } : { pass: true, reason: 'fine' }
        }
        return 'candidate'
      },
    })
    await generateAndFilter(rt, makeOptions({ count: 3, phase: 'gen-phase' }))
    const digest = rt.logs.map(parseDigest).find((d) => d?.stage === 'generateAndFilter')
    expect(digest?.counts).toEqual({ requested: 3, kept: 2, rejected: 1, failed: 0 })
    expect(digest?.phase).toBe('gen-phase')
  })

  it('returns all candidates that pass, with exact stats and empty warnings', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) {
          return { pass: true, reason: 'looks good' }
        }
        return 'generated-candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 3 }))

    expect(result.warnings).toHaveLength(0)
    expect(result.value).toHaveLength(3)
    expect(result.value).toEqual(['generated-candidate', 'generated-candidate', 'generated-candidate'])
    expect(result.stats.itemsIn).toBe(3)
    expect(result.stats.itemsOut).toBe(3)
    expect(result.stats.dropped).toBe(0)
    expect(result.stats.truncated).toBe(0)
    // 3 generate + 3 filter = 6
    expect(result.stats.agentsSpawned).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// pass=false → excluded but NOT dropped
// ---------------------------------------------------------------------------

describe('generateAndFilter — pass=false excluded, not dropped', () => {
  it('excluded candidates reduce itemsOut but not increase dropped', async () => {
    let genCount = 0
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) {
          // First candidate fails, rest pass
          genCount++
          return genCount === 1
            ? { pass: false, reason: 'too noisy' }
            : { pass: true, reason: 'fine' }
        }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 3 }))

    expect(result.stats.itemsIn).toBe(3)
    expect(result.stats.itemsOut).toBe(2)
    expect(result.stats.dropped).toBe(0)  // rejections are NOT drops
    expect(result.value).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Null agent results → dropped + warning + logged
// ---------------------------------------------------------------------------

describe('generateAndFilter — null agent results', () => {
  it('counts dropped when generate returns null', async () => {
    let genCallCount = 0
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) {
          return { pass: true, reason: 'ok' }
        }
        genCallCount++
        if (genCallCount === 1) return null  // first generation fails
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 3 }))

    expect(result.stats.dropped).toBe(1)
    expect(result.stats.itemsOut).toBe(2)
    expect(result.warnings.some(w => w.includes('generation'))).toBe(true)
    expect(rt.logs.some(l => l.includes('generation'))).toBe(true)
  })

  it('counts dropped when filter returns null (fail-closed — candidate excluded)', async () => {
    let filterCallCount = 0
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) {
          filterCallCount++
          if (filterCallCount === 2) return null  // second filter fails
          return { pass: true, reason: 'ok' }
        }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 3 }))

    expect(result.stats.dropped).toBe(1)
    expect(result.stats.itemsOut).toBe(2)
    expect(result.warnings.some(w => w.includes('filter') || w.includes('filtering'))).toBe(true)
    expect(rt.logs.some(l => l.includes('filter') || l.includes('filtering'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Mixed scenario: some pass, some fail, some null
// ---------------------------------------------------------------------------

describe('generateAndFilter — mixed scenario', () => {
  it('handles pass/fail/null with exact stats', async () => {
    // count=4: gen-0 null, gen-1 passes filter, gen-2 filter rejects, gen-3 filter null
    let genCount = 0
    let filterCount = 0
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) {
          filterCount++
          if (filterCount === 1) return { pass: true, reason: 'good' }    // gen-1
          if (filterCount === 2) return { pass: false, reason: 'bad' }    // gen-2
          if (filterCount === 3) return null                               // gen-3
          return { pass: true, reason: 'ok' }
        }
        genCount++
        if (genCount === 1) return null  // gen-0 null
        return `candidate-${genCount}`
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 4 }))

    // gen-0 dropped (null gen), gen-1 passes, gen-2 rejected (not dropped), gen-3 dropped (null filter)
    expect(result.stats.itemsIn).toBe(4)
    expect(result.stats.itemsOut).toBe(1)
    expect(result.stats.dropped).toBe(2)  // gen-0 + gen-3 (null filter = fail-closed = drop)
    expect(result.value).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Phase propagation
// ---------------------------------------------------------------------------

describe('generateAndFilter — phase propagation', () => {
  it('forwards opts.phase to every agent call', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'c'
      },
    })

    await generateAndFilter(rt, makeOptions({ count: 2, phase: 'gen-phase' }))

    expect(rt.calls.every(c => c.phase === 'gen-phase')).toBe(true)
  })

  it('leaves phase undefined when not set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'c'
      },
    })

    await generateAndFilter(rt, makeOptions({ count: 1 }))

    expect(rt.calls.every(c => c.phase === undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe('generateAndFilter — labels', () => {
  it('assigns correct label shapes', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'c'
      },
    })

    await generateAndFilter(rt, makeOptions({ count: 2 }))

    const labels = rt.calls.map(c => c.opts?.label)
    expect(labels).toContain('generateAndFilter:generate:0')
    expect(labels).toContain('generateAndFilter:generate:1')
    expect(labels).toContain('generateAndFilter:filter:0')
    expect(labels).toContain('generateAndFilter:filter:1')
  })
})

// ---------------------------------------------------------------------------
// Filter control schema owned by pattern
// ---------------------------------------------------------------------------

describe('generateAndFilter — filter control schema', () => {
  it('passes the filter schema with pass+reason to filter agents', async () => {
    let capturedSchema: unknown = null
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) {
          capturedSchema = opts?.schema
          return { pass: true, reason: 'ok' }
        }
        return 'candidate'
      },
    })

    await generateAndFilter(rt, makeOptions({ count: 1 }))

    expect(capturedSchema).toMatchObject(FILTER_SCHEMA_SHAPE)
  })

  it('forwards generateSchema to generate agents', async () => {
    const genSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    let capturedGenSchema: unknown = null

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        capturedGenSchema = opts?.schema
        return { text: 'gen' }
      },
    })

    await generateAndFilter(rt, makeOptions({ count: 1, generateSchema: genSchema }))

    expect(capturedGenSchema).toEqual(genSchema)
  })

  it('forwards generateModel to generate agents', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'c'
      },
    })

    await generateAndFilter(rt, makeOptions({ count: 1, generateModel: 'haiku' }))

    const genCall = rt.calls.find(c => c.opts?.label?.startsWith('generateAndFilter:generate:'))
    expect(genCall?.opts?.model).toBe('haiku')
  })
})

// ---------------------------------------------------------------------------
// Rejection visibility: logged live, but neither a warning nor a drop (review M3)
// ---------------------------------------------------------------------------

describe('generateAndFilter — rejection count is logged, not warned', () => {
  it('logs pass=false rejections without polluting warnings or dropped', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) =>
        opts?.label?.startsWith('generateAndFilter:filter')
          ? { pass: false, reason: 'nope' }
          : 'candidate',
    })

    const result = await generateAndFilter(rt, {
      count: 3,
      generatePrompt: (i) => `gen ${i}`,
      filterPrompt: (c) => `filter ${c}`,
    })

    expect(result.value).toEqual([])
    expect(result.stats).toEqual({
      itemsIn: 3,
      itemsOut: 0,
      agentsSpawned: 6,
      dropped: 0,
      truncated: 0,
    })
    // Rejection is the filter WORKING — visible live, but not degradation
    expect(rt.logs.some(l => l.includes('3 of 3 candidates rejected by filter'))).toBe(true)
    expect(result.warnings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Audit trail — trail invariants
// ---------------------------------------------------------------------------

describe('generateAndFilter — audit trail', () => {
  it('trail is always defined on the result', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'candidate'
      },
    })
    const result = await generateAndFilter(rt, makeOptions({ count: 2 }))
    expect(result.trail).toBeDefined()
  })

  it('happy path: trail.length === agentsSpawned, correct stages and outcomes', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 3 }))

    expect(result.trail).toBeDefined()
    const trail = result.trail!
    // 3 generate + 3 filter = 6
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(6)

    // deterministic order: item 0 generate, item 0 filter, item 1 generate, item 1 filter, ...
    expect(trail.at(0)!.stage).toBe('generateAndFilter:generate:0')
    expect(trail.at(0)!.outcome).toBe('ok')

    expect(trail.at(1)!.stage).toBe('generateAndFilter:filter:0')
    expect(trail.at(1)!.outcome).toBe('ok')
    expect(trail.at(1)!.decision).toBe('pass')

    expect(trail.at(2)!.stage).toBe('generateAndFilter:generate:1')
    expect(trail.at(2)!.outcome).toBe('ok')

    expect(trail.at(3)!.stage).toBe('generateAndFilter:filter:1')
    expect(trail.at(3)!.outcome).toBe('ok')
    expect(trail.at(3)!.decision).toBe('pass')

    expect(trail.at(4)!.stage).toBe('generateAndFilter:generate:2')
    expect(trail.at(4)!.outcome).toBe('ok')

    expect(trail.at(5)!.stage).toBe('generateAndFilter:filter:2')
    expect(trail.at(5)!.outcome).toBe('ok')
    expect(trail.at(5)!.decision).toBe('pass')
  })

  it('generate null: outcome=null record, no filter record for that item, trail.length === agentsSpawned', async () => {
    // item 0 generate returns null → dropped, pipeline exits for that item
    let genCount = 0
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        genCount++
        if (genCount === 1) return null
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 2 }))

    const trail = result.trail!
    // item-0: 1 generate (null). item-1: 1 generate + 1 filter. total=3
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(3)

    expect(trail.at(0)!.stage).toBe('generateAndFilter:generate:0')
    expect(trail.at(0)!.outcome).toBe('null')

    expect(trail.at(1)!.stage).toBe('generateAndFilter:generate:1')
    expect(trail.at(1)!.outcome).toBe('ok')

    expect(trail.at(2)!.stage).toBe('generateAndFilter:filter:1')
    expect(trail.at(2)!.outcome).toBe('ok')
    expect(trail.at(2)!.decision).toBe('pass')
  })

  it('filter null: outcome=null record present, trail.length === agentsSpawned', async () => {
    // item 1 filter returns null → dropped (fail-closed)
    let filterCount = 0
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) {
          filterCount++
          if (filterCount === 2) return null
          return { pass: true, reason: 'ok' }
        }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 3 }))

    const trail = result.trail!
    // 3 generate + 3 filter = 6 agents, all spawned (filter null still spawned)
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(6)

    const filterRecord1 = trail.find(r => r.stage === 'generateAndFilter:filter:1')!
    expect(filterRecord1.outcome).toBe('null')
    expect(filterRecord1).not.toHaveProperty('decision')
  })

  it('filter pass=false: filter record outcome=ok, decision=fail', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: false, reason: 'bad' }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 2 }))

    const trail = result.trail!
    // 2 generate + 2 filter = 4 agents (pass=false does NOT drop → filter still runs to completion)
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(4)

    const filterRecord = trail.find(r => r.stage === 'generateAndFilter:filter:0')!
    expect(filterRecord.outcome).toBe('ok')
    expect(filterRecord.decision).toBe('fail')
  })

  it('model override present in generate trail records when generateModel set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 1, generateModel: 'haiku' }))

    const trail = result.trail!
    const genRecord = trail.find(r => r.stage === 'generateAndFilter:generate:0')!
    expect(genRecord.model).toBe('haiku')
  })

  it('model absent from generate trail records when generateModel not set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 1 }))

    const trail = result.trail!
    const genRecord = trail.find(r => r.stage === 'generateAndFilter:generate:0')!
    expect(genRecord).not.toHaveProperty('model')
  })

  it('model override present in filter trail records when filterModel set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 1, filterModel: 'haiku' }))

    const trail = result.trail!
    const filterRecord = trail.find(r => r.stage === 'generateAndFilter:filter:0')!
    expect(filterRecord.model).toBe('haiku')
  })

  it('model absent from filter trail records when filterModel not set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 1 }))

    const trail = result.trail!
    const filterRecord = trail.find(r => r.stage === 'generateAndFilter:filter:0')!
    expect(filterRecord).not.toHaveProperty('model')
  })

  it('generate records have no decision field', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 1 }))

    const trail = result.trail!
    const genRecord = trail.find(r => r.stage === 'generateAndFilter:generate:0')!
    expect(genRecord).not.toHaveProperty('decision')
  })

  it('determinism: same scenario run twice produces identical trails', async () => {
    function makeRt() {
      let filterCount = 0
      return new FakeRuntime({
        onAgent: ({ opts }) => {
          if (isFilterCall(opts)) {
            filterCount++
            return filterCount % 2 === 0
              ? { pass: false, reason: 'nope' }
              : { pass: true, reason: 'ok' }
          }
          return 'candidate'
        },
      })
    }

    const resultA = await generateAndFilter(makeRt(), makeOptions({ count: 4 }))
    const resultB = await generateAndFilter(makeRt(), makeOptions({ count: 4 }))

    expect(resultA.trail).toEqual(resultB.trail)
  })
})

// ---------------------------------------------------------------------------
// Effort forwarding
// ---------------------------------------------------------------------------

describe('generateAndFilter — effort forwarding', () => {
  it('forwards generateEffort to generate agents and filterEffort to filter agents', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'candidate'
      },
    })

    await generateAndFilter(rt, makeOptions({ count: 2, generateEffort: 'medium', filterEffort: 'high' }))

    const generateCalls = rt.calls.filter(c => c.opts?.label?.startsWith('generateAndFilter:generate:'))
    const filterCalls = rt.calls.filter(c => c.opts?.label?.startsWith('generateAndFilter:filter:'))

    expect(generateCalls.every(c => c.opts?.effort === 'medium')).toBe(true)
    expect(filterCalls.every(c => c.opts?.effort === 'high')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Effort in the audit trail
// ---------------------------------------------------------------------------

describe('generateAndFilter — trail: effort field', () => {
  it('effort override present in generate trail records when generateEffort set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 1, generateEffort: 'medium' }))

    const trail = result.trail!
    const genRecord = trail.find(r => r.stage === 'generateAndFilter:generate:0')!
    expect(genRecord.effort).toBe('medium')
  })

  it('effort absent from generate trail records when generateEffort not set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 1 }))

    const trail = result.trail!
    const genRecord = trail.find(r => r.stage === 'generateAndFilter:generate:0')!
    expect(genRecord).not.toHaveProperty('effort')
  })

  it('effort override present in filter trail records when filterEffort set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 1, filterEffort: 'high' }))

    const trail = result.trail!
    const filterRecord = trail.find(r => r.stage === 'generateAndFilter:filter:0')!
    expect(filterRecord.effort).toBe('high')
  })

  it('effort absent from filter trail records when filterEffort not set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        return 'candidate'
      },
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 1 }))

    const trail = result.trail!
    const filterRecord = trail.find(r => r.stage === 'generateAndFilter:filter:0')!
    expect(filterRecord).not.toHaveProperty('effort')
  })
})

// ---------------------------------------------------------------------------
// cacheWarm (default TRUE, mechanism a — first-completes-then-burst, over
// rt.pipeline; opt OUT with cacheWarm: false)
// ---------------------------------------------------------------------------

describe('generateAndFilter — cacheWarm=false (explicit opt-out)', () => {
  it('disables staggering entirely: candidate 1 starts before candidate 0 finishes', async () => {
    let laterCandidateStarted = false
    let gen0Resolved = false
    let resolveGen0: (v: string) => void = () => {}

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = (opts as { label?: string } | undefined)?.label ?? ''
        if (label === 'generateAndFilter:generate:0') {
          return new Promise<string>((resolve) => {
            resolveGen0 = (v) => { gen0Resolved = true; resolve(v) }
          })
        }
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        if (!gen0Resolved) laterCandidateStarted = true
        return 'candidate'
      },
    })

    const promise = generateAndFilter(rt, makeOptions({ cacheWarm: false }))
    await Promise.resolve()
    await Promise.resolve()

    expect(laterCandidateStarted).toBe(true)
    resolveGen0('candidate-0')
    await promise
  })

  it('produces identical stats/trail to cacheWarm:true — cacheWarm only affects timing, not outcome', async () => {
    const onAgent = ({ opts }: { opts?: unknown }): unknown =>
      isFilterCall(opts) ? { pass: true, reason: 'ok' } : 'candidate'

    const rtFalse = new FakeRuntime({ onAgent })
    const rtTrue = new FakeRuntime({ onAgent })

    const resultFalse = await generateAndFilter(rtFalse, makeOptions({ cacheWarm: false }))
    const resultTrue = await generateAndFilter(rtTrue, makeOptions({ cacheWarm: true }))

    expect(resultFalse.stats).toEqual(resultTrue.stats)
    expect(resultFalse.trail).toEqual(resultTrue.trail)
  })
})

describe('generateAndFilter — cacheWarm omitted (defaults to TRUE)', () => {
  it('staggers by default when the option is not passed at all', async () => {
    let laterCandidateStarted = false
    let gen0Resolved = false
    let resolveGen0: (v: string) => void = () => {}

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = (opts as { label?: string } | undefined)?.label ?? ''
        if (label === 'generateAndFilter:generate:0') {
          return new Promise<string>((resolve) => {
            resolveGen0 = (v) => { gen0Resolved = true; resolve(v) }
          })
        }
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        if (!gen0Resolved) laterCandidateStarted = true
        return 'candidate'
      },
    })

    // Bypass this file's makeOptions() (which pins cacheWarm:false for the
    // OTHER tests in this file) — construct the options object directly, with
    // the cacheWarm key genuinely ABSENT, to prove the PATTERN's own default.
    const promise = generateAndFilter(rt, {
      count: 3,
      generatePrompt: (i) => `generate candidate ${i}`,
      filterPrompt: (c) => `filter: ${c}`,
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(laterCandidateStarted).toBe(false)
    resolveGen0('candidate-0')
    await promise
  })
})

describe('generateAndFilter — cacheWarm=true (staggered)', () => {
  it('runs candidate 0 through generate+filter fully before candidate 1/2 start', async () => {
    let laterCandidateStarted = false
    let gen0Resolved = false
    let resolveGen0: (v: string) => void = () => {}

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const label = (opts as { label?: string } | undefined)?.label ?? ''
        if (label === 'generateAndFilter:generate:0') {
          return new Promise<string>((resolve) => {
            resolveGen0 = (v) => { gen0Resolved = true; resolve(v) }
          })
        }
        if (isFilterCall(opts)) return { pass: true, reason: 'ok' }
        // Any OTHER generate call (candidate 1/2) — must not fire before gen0 resolves.
        if (!gen0Resolved) laterCandidateStarted = true
        return 'candidate'
      },
    })

    const promise = generateAndFilter(rt, makeOptions({ cacheWarm: true }))
    await Promise.resolve()
    await Promise.resolve()

    expect(laterCandidateStarted).toBe(false)
    expect(rt.calls.map(c => c.opts?.label)).toEqual(['generateAndFilter:generate:0'])

    resolveGen0('candidate-0')
    const result = await promise

    expect(result.stats.agentsSpawned).toBe(6) // 3 candidates x (generate + filter)
  })

  it('does not add an extra agent — stats/agentsSpawned match the un-staggered run', async () => {
    const onAgent = ({ opts }: { opts?: unknown }): unknown =>
      isFilterCall(opts) ? { pass: true, reason: 'ok' } : 'candidate'

    const rtWarm = new FakeRuntime({ onAgent })
    const rtPlain = new FakeRuntime({ onAgent })

    const resultWarm = await generateAndFilter(rtWarm, makeOptions({ cacheWarm: true }))
    const resultPlain = await generateAndFilter(rtPlain, makeOptions())

    expect(resultWarm.stats).toEqual(resultPlain.stats)
    expect(resultWarm.trail).toEqual(resultPlain.trail)
  })

  it('is a no-op (no staggering) when count is 1', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isFilterCall(opts) ? { pass: true, reason: 'ok' } : 'candidate'),
    })

    const result = await generateAndFilter(rt, makeOptions({ count: 1, cacheWarm: true }))

    expect(result.stats.agentsSpawned).toBe(2) // 1 generate + 1 filter
  })
})
