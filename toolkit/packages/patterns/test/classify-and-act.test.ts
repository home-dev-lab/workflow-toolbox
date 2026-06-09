import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import { classifyAndAct } from '../src/classify-and-act.js'
import type { ClassifyAndActOptions } from '../src/classify-and-act.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CATEGORIES = ['docs', 'bug', 'feature'] as const

function makeOptions(
  overrides: Partial<ClassifyAndActOptions<string>> = {},
): ClassifyAndActOptions<string> {
  return {
    items: ['item-0', 'item-1'],
    categories: [...CATEGORIES],
    classifyPrompt: (item) => `classify: ${item}`,
    actions: {
      docs: { prompt: (item) => `docs action: ${item}` },
      bug: { prompt: (item) => `bug action: ${item}` },
      feature: { prompt: (item) => `feature action: ${item}` },
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Config validation (throw synchronously)
// ---------------------------------------------------------------------------

describe('classifyAndAct — config validation', () => {
  it('rejects when categories is empty', async () => {
    const rt = new FakeRuntime()
    await expect(classifyAndAct(rt, makeOptions({ categories: [] }))).rejects.toThrow(/categories/)
  })

  it('rejects when categories has duplicates', async () => {
    const rt = new FakeRuntime()
    await expect(
      classifyAndAct(rt, makeOptions({ categories: ['a', 'a', 'b'] })),
    ).rejects.toThrow(/duplicate/)
  })

  it('rejects when a category is missing from actions, naming the missing ones', async () => {
    const rt = new FakeRuntime()
    await expect(
      classifyAndAct(rt, makeOptions({
        categories: ['docs', 'bug', 'missing1', 'missing2'],
        actions: { docs: { prompt: () => '' }, bug: { prompt: () => '' } },
      })),
    ).rejects.toThrow(/missing1/)
  })

  it('rejects when maxItems < 1', async () => {
    const rt = new FakeRuntime()
    await expect(classifyAndAct(rt, makeOptions({ maxItems: 0 }))).rejects.toThrow()
  })

  it('rejection message contains corrective action instruction', async () => {
    const rt = new FakeRuntime()
    await expect(
      classifyAndAct(rt, makeOptions({
        categories: ['docs', 'orphan'],
        actions: { docs: { prompt: () => '' } },
      })),
    ).rejects.toThrow(/add an entry to options\.actions|remove the category/i)
  })
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('classifyAndAct — happy path', () => {
  it('returns correct value, exact stats, and empty warnings', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        // classify stage: return category from the enum
        if (opts?.schema !== undefined) {
          const schema = opts.schema as { properties?: { category?: { enum?: string[] } } }
          if (schema.properties?.category?.enum !== undefined) {
            return { category: 'docs' }
          }
        }
        // act stage: return string result
        return 'action-result'
      },
    })

    const result = await classifyAndAct(rt, makeOptions())

    expect(result.warnings).toHaveLength(0)
    expect(result.value).toHaveLength(2)
    expect(result.value[0]).toEqual({ item: 'item-0', category: 'docs', result: 'action-result' })
    expect(result.value[1]).toEqual({ item: 'item-1', category: 'docs', result: 'action-result' })
    expect(result.stats.itemsIn).toBe(2)
    expect(result.stats.itemsOut).toBe(2)
    expect(result.stats.dropped).toBe(0)
    expect(result.stats.truncated).toBe(0)
    // 2 items × (1 classify + 1 act) = 4 agents
    expect(result.stats.agentsSpawned).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Null agent results → dropped + warning + logged
// ---------------------------------------------------------------------------

describe('classifyAndAct — null agent results', () => {
  it('counts dropped when classify returns null', async () => {
    // classify returns null for item-0, succeeds for item-1
    let callCount = 0
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        callCount++
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) {
          // classify stage
          if (callCount === 1) return null  // item-0 fails
          return { category: 'docs' }
        }
        return 'action-result'
      },
    })

    const result = await classifyAndAct(rt, makeOptions())

    expect(result.stats.itemsIn).toBe(2)
    expect(result.stats.dropped).toBe(1)
    expect(result.stats.itemsOut).toBe(1)
    expect(result.warnings.some(w => w.includes('classification'))).toBe(true)
    // Warning must also appear in rt.logs
    expect(rt.logs.some(l => l.includes('classification'))).toBe(true)
  })

  it('counts dropped when act returns null', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) {
          return { category: 'docs' }
        }
        // act stage returns null
        return null
      },
    })

    const result = await classifyAndAct(rt, makeOptions())

    expect(result.stats.dropped).toBe(2)
    expect(result.stats.itemsOut).toBe(0)
    expect(result.warnings.some(w => w.includes('action'))).toBe(true)
    expect(rt.logs.some(l => l.includes('action'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Unknown category defense
// ---------------------------------------------------------------------------

describe('classifyAndAct — unknown category defense', () => {
  it('drops items when classify returns a category not in actions', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) {
          // Return a category outside the defined actions (defensive)
          return { category: 'not-in-actions' }
        }
        return 'action-result'
      },
    })

    const result = await classifyAndAct(rt, makeOptions())

    expect(result.stats.dropped).toBeGreaterThan(0)
    expect(result.warnings.some(w => w.includes('classification'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe('classifyAndAct — truncation', () => {
  it('applies maxItems cap and reports truncated count + warning', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) {
          return { category: 'docs' }
        }
        return 'action-result'
      },
    })

    const result = await classifyAndAct(rt, makeOptions({
      items: ['a', 'b', 'c', 'd', 'e'],
      maxItems: 2,
    }))

    expect(result.stats.truncated).toBe(3)
    expect(result.stats.itemsIn).toBe(5)
    // only 2 kept items processed
    expect(result.stats.agentsSpawned).toBe(4) // 2 × (classify + act)
    expect(result.warnings.some(w => w.includes('truncated'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Phase propagation
// ---------------------------------------------------------------------------

describe('classifyAndAct — phase propagation', () => {
  it('forwards opts.phase to every agent call', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) {
          return { category: 'docs' }
        }
        return 'action-result'
      },
    })

    await classifyAndAct(rt, makeOptions({ phase: 'my-phase' }))

    expect(rt.calls.every(c => c.phase === 'my-phase')).toBe(true)
  })

  it('leaves phase undefined when opts.phase is not set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) {
          return { category: 'docs' }
        }
        return 'action-result'
      },
    })

    await classifyAndAct(rt, makeOptions())

    expect(rt.calls.every(c => c.phase === undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe('classifyAndAct — labels', () => {
  it('assigns correct label shapes to classify and act calls', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) {
          return { category: 'docs' }
        }
        return 'action-result'
      },
    })

    await classifyAndAct(rt, makeOptions({ items: ['only-item'] }))

    const labels = rt.calls.map(c => c.opts?.label)
    expect(labels).toContain('classifyAndAct:classify:0')
    expect(labels.some(l => l?.startsWith('classifyAndAct:act:docs:'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Schema forwarded to classify stage
// ---------------------------------------------------------------------------

describe('classifyAndAct — control schema', () => {
  it('passes a schema with enum of all categories to classify agents', async () => {
    let capturedSchema: unknown = null
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown[] } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) {
          capturedSchema = schema
          return { category: 'bug' }
        }
        return 'action-result'
      },
    })

    await classifyAndAct(rt, makeOptions({ items: ['one'] }))

    expect(capturedSchema).not.toBeNull()
    const s = capturedSchema as { properties: { category: { enum: string[] } } }
    expect(s.properties.category.enum).toEqual(expect.arrayContaining(['docs', 'bug', 'feature']))
    expect(s.properties.category.enum).toHaveLength(3)
  })

  it('forwards per-action schema to the act agent', async () => {
    const actionSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
    let actCallSchema: unknown = null

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown[] } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) {
          return { category: 'docs' }
        }
        actCallSchema = opts?.schema ?? null
        return { text: 'result' }
      },
    })

    await classifyAndAct(rt, makeOptions({
      items: ['one'],
      actions: {
        docs: { prompt: () => 'do docs', schema: actionSchema },
        bug: { prompt: () => 'do bug' },
        feature: { prompt: () => 'do feature' },
      },
    }))

    expect(actCallSchema).toEqual(actionSchema)
  })

  it('forwards per-action model to the act agent', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown[] } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) {
          return { category: 'bug' }
        }
        return 'done'
      },
    })

    await classifyAndAct(rt, makeOptions({
      items: ['one'],
      actions: {
        docs: { prompt: () => 'docs' },
        bug: { prompt: () => 'bug', model: 'haiku' },
        feature: { prompt: () => 'feature' },
      },
    }))

    const actCall = rt.calls.find(c => c.opts?.label?.startsWith('classifyAndAct:act:bug:'))
    expect(actCall?.opts?.model).toBe('haiku')
  })
})

// ---------------------------------------------------------------------------
// Audit trail — trail invariants
// ---------------------------------------------------------------------------

describe('classifyAndAct — audit trail', () => {
  it('trail is always defined on the result', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown[] } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) return { category: 'docs' }
        return 'action-result'
      },
    })
    const result = await classifyAndAct(rt, makeOptions())
    expect(result.trail).toBeDefined()
  })

  it('happy path: trail.length === agentsSpawned, correct stages and outcomes', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown[] } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) return { category: 'docs' }
        return 'action-result'
      },
    })

    const result = await classifyAndAct(rt, makeOptions({ items: ['item-0', 'item-1'] }))

    expect(result.trail).toBeDefined()
    const trail = result.trail!
    // 2 items × (classify + act) = 4
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(4)

    // stages in deterministic order: item 0 classify, item 0 act, item 1 classify, item 1 act
    expect(trail.at(0)!.stage).toBe('classifyAndAct:classify:0')
    expect(trail.at(0)!.outcome).toBe('ok')
    expect(trail.at(0)!.decision).toBe('docs')

    expect(trail.at(1)!.stage).toBe('classifyAndAct:act:docs:0')
    expect(trail.at(1)!.outcome).toBe('ok')

    expect(trail.at(2)!.stage).toBe('classifyAndAct:classify:1')
    expect(trail.at(2)!.outcome).toBe('ok')
    expect(trail.at(2)!.decision).toBe('docs')

    expect(trail.at(3)!.stage).toBe('classifyAndAct:act:docs:1')
    expect(trail.at(3)!.outcome).toBe('ok')
  })

  it('dropped-item (classify null): outcome=null record present, trail.length === agentsSpawned', async () => {
    // item-0 classify returns null → dropped, item-1 succeeds
    let classifyCount = 0
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown[] } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) {
          classifyCount++
          if (classifyCount === 1) return null
          return { category: 'docs' }
        }
        return 'action-result'
      },
    })

    const result = await classifyAndAct(rt, makeOptions({ items: ['item-0', 'item-1'] }))

    const trail = result.trail!
    // item-0: 1 classify (null) → 1 agent. item-1: 1 classify + 1 act → 2 agents. total=3
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(3)

    // item-0 classify null record at index 0
    expect(trail.at(0)!.stage).toBe('classifyAndAct:classify:0')
    expect(trail.at(0)!.outcome).toBe('null')
    expect(trail.at(0)!).not.toHaveProperty('decision')

    // item-1 classify ok at index 1
    expect(trail.at(1)!.stage).toBe('classifyAndAct:classify:1')
    expect(trail.at(1)!.outcome).toBe('ok')
    expect(trail.at(1)!.decision).toBe('docs')

    // item-1 act ok at index 2
    expect(trail.at(2)!.stage).toBe('classifyAndAct:act:docs:1')
    expect(trail.at(2)!.outcome).toBe('ok')
  })

  it('dropped-item (act null): outcome=null record present, trail.length === agentsSpawned', async () => {
    // Both items classify ok → 'docs', act returns null for item-0 only
    let actCount = 0
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown[] } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) return { category: 'docs' }
        actCount++
        if (actCount === 1) return null
        return 'action-result'
      },
    })

    const result = await classifyAndAct(rt, makeOptions({ items: ['item-0', 'item-1'] }))

    const trail = result.trail!
    // 2 classify + 2 act = 4 agents total
    expect(trail).toHaveLength(result.stats.agentsSpawned)
    expect(trail).toHaveLength(4)

    // item-0: classify ok, act null
    expect(trail.at(0)!.stage).toBe('classifyAndAct:classify:0')
    expect(trail.at(0)!.outcome).toBe('ok')
    expect(trail.at(0)!.decision).toBe('docs')

    expect(trail.at(1)!.stage).toBe('classifyAndAct:act:docs:0')
    expect(trail.at(1)!.outcome).toBe('null')

    // item-1: classify ok, act ok
    expect(trail.at(2)!.stage).toBe('classifyAndAct:classify:1')
    expect(trail.at(2)!.outcome).toBe('ok')

    expect(trail.at(3)!.stage).toBe('classifyAndAct:act:docs:1')
    expect(trail.at(3)!.outcome).toBe('ok')
  })

  it('model override present in trail records when classifyModel set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown[] } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) return { category: 'docs' }
        return 'action-result'
      },
    })

    const result = await classifyAndAct(rt, makeOptions({
      items: ['item-0'],
      classifyModel: 'haiku',
    }))

    const trail = result.trail!
    const classifyRecord = trail.find(r => r.stage === 'classifyAndAct:classify:0')!
    expect(classifyRecord.model).toBe('haiku')
  })

  it('model absent from classify trail records when classifyModel not set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown[] } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) return { category: 'docs' }
        return 'action-result'
      },
    })

    const result = await classifyAndAct(rt, makeOptions({ items: ['item-0'] }))

    const trail = result.trail!
    const classifyRecord = trail.find(r => r.stage === 'classifyAndAct:classify:0')!
    expect(classifyRecord).not.toHaveProperty('model')
  })

  it('act trail records carry per-action model when set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown[] } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) return { category: 'bug' }
        return 'done'
      },
    })

    const result = await classifyAndAct(rt, makeOptions({
      items: ['item-0'],
      actions: {
        docs: { prompt: () => 'docs' },
        bug: { prompt: () => 'bug', model: 'haiku' },
        feature: { prompt: () => 'feature' },
      },
    }))

    const trail = result.trail!
    const actRecord = trail.find(r => r.stage === 'classifyAndAct:act:bug:0')!
    expect(actRecord.model).toBe('haiku')
  })

  it('act trail records have no model when per-action model not set', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown[] } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) return { category: 'docs' }
        return 'action-result'
      },
    })

    const result = await classifyAndAct(rt, makeOptions({ items: ['item-0'] }))

    const trail = result.trail!
    const actRecord = trail.find(r => r.stage === 'classifyAndAct:act:docs:0')!
    expect(actRecord).not.toHaveProperty('model')
  })

  it('act records have no decision field', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        const schema = opts?.schema as { properties?: { category?: { enum?: unknown[] } } } | undefined
        if (schema?.properties?.category?.enum !== undefined) return { category: 'docs' }
        return 'action-result'
      },
    })

    const result = await classifyAndAct(rt, makeOptions({ items: ['item-0'] }))

    const trail = result.trail!
    const actRecord = trail.find(r => r.stage.startsWith('classifyAndAct:act:'))!
    expect(actRecord).not.toHaveProperty('decision')
  })

  it('determinism: same scenario run twice produces identical trails', async () => {
    function makeRt() {
      return new FakeRuntime({
        onAgent: ({ opts }) => {
          const schema = opts?.schema as { properties?: { category?: { enum?: unknown[] } } } | undefined
          if (schema?.properties?.category?.enum !== undefined) return { category: 'feature' }
          return 'result'
        },
      })
    }

    const resultA = await classifyAndAct(makeRt(), makeOptions({ items: ['x', 'y', 'z'] }))
    const resultB = await classifyAndAct(makeRt(), makeOptions({ items: ['x', 'y', 'z'] }))

    expect(resultA.trail).toEqual(resultB.trail)
  })
})
