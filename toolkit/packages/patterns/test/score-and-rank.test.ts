import { describe, it, expect } from 'vitest'
import { FakeRuntime, parseDigest } from '@workflow-toolbox/runtime'
import { scoreAndRank } from '../src/score-and-rank.js'
import type { ScoreAndRankOptions, ScoreDimension } from '../src/score-and-rank.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TWO_DIMS: Array<ScoreDimension<string>> = [
  { name: 'impact', prompt: (f) => `impact of ${f}` },
  { name: 'opportunity', prompt: (f) => `opportunity of ${f}` },
]

function makeOptions(
  overrides: Partial<ScoreAndRankOptions<string>> = {},
): ScoreAndRankOptions<string> {
  return {
    items: ['a', 'b', 'c'],
    dimensions: TWO_DIMS,
    cutoff: { type: 'threshold', min: 1 },
    ...overrides,
  }
}

// A score call carries the pattern-owned schema with a numeric `score`.
function isScoreCall(opts: unknown): boolean {
  const o = opts as { schema?: { properties?: { score?: unknown } } } | undefined
  return o?.schema?.properties?.score !== undefined
}

// Resolve the dimension name from a score label: scoreAndRank:score:<i>:<dim>
function dimOf(label: string | undefined): string | undefined {
  return label?.split(':').at(3)
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('scoreAndRank — config validation', () => {
  it('rejects empty items', async () => {
    const rt = new FakeRuntime()
    await expect(scoreAndRank(rt, makeOptions({ items: [] }))).rejects.toThrow(/items/i)
  })

  it('rejects empty dimensions', async () => {
    const rt = new FakeRuntime()
    await expect(scoreAndRank(rt, makeOptions({ dimensions: [] }))).rejects.toThrow(/dimension/i)
  })

  it('rejects a topK cutoff with k < 1', async () => {
    const rt = new FakeRuntime()
    await expect(scoreAndRank(rt, makeOptions({ cutoff: { type: 'topK', k: 0 } }))).rejects.toThrow(/topK/i)
  })

  it('rejects a threshold cutoff with a non-finite min', async () => {
    const rt = new FakeRuntime()
    await expect(
      scoreAndRank(rt, makeOptions({ cutoff: { type: 'threshold', min: Number.POSITIVE_INFINITY } })),
    ).rejects.toThrow(/finite/i)
  })

  it('rejects an unknown cutoff type', async () => {
    const rt = new FakeRuntime()
    const bad = makeOptions({ cutoff: { type: 'nonsense' } as unknown as ScoreAndRankOptions<string>['cutoff'] })
    await expect(scoreAndRank(rt, bad)).rejects.toThrow(/cutoff/i)
  })
})

// ---------------------------------------------------------------------------
// agentType routing (scoreType) — the scorer is the only role this pattern spawns
// ---------------------------------------------------------------------------

describe('scoreAndRank — agentType routing', () => {
  it('omits agentType on every call when no scoreType is set', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 4, reason: 'r' }) })
    await scoreAndRank(rt, makeOptions())
    expect(rt.calls.every((c) => c.opts?.agentType === undefined)).toBe(true)
  })

  it('threads scoreType to every score agent', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 4, reason: 'r' }) })
    await scoreAndRank(rt, makeOptions({ scoreType: 'codex:codex-rescue' }))
    // 3 items * 2 dimensions = 6 score calls
    expect(rt.calls.length).toBe(6)
    expect(rt.calls.every((c) => c.opts?.agentType === 'codex:codex-rescue')).toBe(true)
  })

  it('rejects an empty or whitespace-only scoreType', async () => {
    const rt = new FakeRuntime()
    await expect(scoreAndRank(rt, makeOptions({ scoreType: '' }))).rejects.toThrow(/scoreType/)
    await expect(scoreAndRank(rt, makeOptions({ scoreType: '   ' }))).rejects.toThrow(/scoreType/)
  })
})

// ---------------------------------------------------------------------------
// Happy path — scoring, combine (product), ranking, cutoff
// ---------------------------------------------------------------------------

describe('scoreAndRank — happy path', () => {
  it('combines dimensions by product and ranks descending', async () => {
    // a: impact 2 × opportunity 3 = 6 ; b: 4 × 5 = 20 ; c: 1 × 1 = 1
    const scores: Record<string, Record<string, number>> = {
      a: { impact: 2, opportunity: 3 },
      b: { impact: 4, opportunity: 5 },
      c: { impact: 1, opportunity: 1 },
    }
    const rt = new FakeRuntime({
      onAgent: ({ prompt, opts }) => {
        const dim = dimOf(opts?.label)
        const item = prompt.split(' ').at(-1) as string
        return { score: scores[item]![dim!]!, reason: 'r' }
      },
    })

    const result = await scoreAndRank(rt, makeOptions({ cutoff: { type: 'threshold', min: 1 } }))

    expect(result.value.map((s) => s.item)).toEqual(['b', 'a', 'c'])
    expect(result.value.map((s) => s.score)).toEqual([20, 6, 1])
    expect(result.value[0]!.scores).toEqual([4, 5])
    expect(result.warnings).toHaveLength(0)
    expect(result.stats.itemsIn).toBe(3)
    expect(result.stats.itemsOut).toBe(3)
    expect(result.stats.dropped).toBe(0)
    expect(result.stats.truncated).toBe(0)
    // 3 items × 2 dimensions = 6 agents
    expect(result.stats.agentsSpawned).toBe(6)
  })

  it('emits a phase digest whose requested partitions into kept/cut/dropped/truncated', async () => {
    // 5 items, maxItems 4 → 1 truncated. Of 4 scored (single dim):
    // 'b' fails (null) → 1 dropped; a=6,c=3,d=1 ranked; topK 2 → kept [a,c], cut [d].
    const scores: Record<string, number | null> = { a: 6, b: null, c: 3, d: 1 }
    const rt = new FakeRuntime({
      onAgent: ({ prompt }) => {
        const s = scores[prompt.split(' ').at(-1) as string]
        return s === null ? null : { score: s, reason: 'r' }
      },
    })

    await scoreAndRank(rt, {
      items: ['a', 'b', 'c', 'd', 'e'],
      dimensions: [{ name: 'x', prompt: (f) => `x of ${f}` }],
      maxItems: 4,
      cutoff: { type: 'topK', k: 2 },
    })

    const digest = rt.logs.map(parseDigest).find((d) => d?.stage === 'scoreAndRank')
    expect(digest?.counts).toEqual({ requested: 5, kept: 2, cut: 1, dropped: 1, truncated: 1 })
    // the partition holds: kept + cut + dropped + truncated === requested
    const c = digest?.counts ?? {}
    expect((c.kept ?? 0) + (c.cut ?? 0) + (c.dropped ?? 0) + (c.truncated ?? 0)).toBe(c.requested ?? 0)
  })

  it('topK cutoff keeps the K highest, logs the rest as cut (not dropped)', async () => {
    const scores: Record<string, number> = { a: 6, b: 20, c: 1 }
    const rt = new FakeRuntime({
      // single dimension → combined score == that dimension's score
      onAgent: ({ prompt }) => {
        const item = prompt.split(' ').at(-1) as string
        return { score: scores[item]!, reason: 'r' }
      },
    })

    const result = await scoreAndRank(rt, {
      items: ['a', 'b', 'c'],
      dimensions: [{ name: 'x', prompt: (f) => `x of ${f}` }],
      cutoff: { type: 'topK', k: 2 },
    })

    expect(result.value.map((s) => s.item)).toEqual(['b', 'a'])
    expect(result.stats.itemsOut).toBe(2)
    expect(result.stats.dropped).toBe(0)
    expect(rt.logs.some((l) => l.includes('1 of 3 ranked items cut by the topK cutoff'))).toBe(true)
  })

  it('threshold cutoff excludes below-min, derivable rejected count', async () => {
    const scores: Record<string, number> = { a: 6, b: 20, c: 1 }
    const rt = new FakeRuntime({
      onAgent: ({ prompt }) => ({ score: scores[prompt.split(' ').at(-1) as string]!, reason: 'r' }),
    })

    const result = await scoreAndRank(rt, {
      items: ['a', 'b', 'c'],
      dimensions: [{ name: 'x', prompt: (f) => `x of ${f}` }],
      cutoff: { type: 'threshold', min: 5 },
    })

    expect(result.value.map((s) => s.item)).toEqual(['b', 'a'])
    const rejected = result.stats.itemsIn - result.stats.truncated - result.stats.dropped - result.stats.itemsOut
    expect(rejected).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Custom combine
// ---------------------------------------------------------------------------

describe('scoreAndRank — custom combine', () => {
  it('uses the supplied pure combiner instead of product', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 3, reason: 'r' }) })

    const result = await scoreAndRank(rt, makeOptions({
      items: ['a'],
      // sum instead of product: 3 + 3 = 6
      combine: (scores) => scores.reduce((x, y) => x + y, 0),
      cutoff: { type: 'threshold', min: 0 },
    }))

    expect(result.value[0]!.score).toBe(6)
    expect(result.value[0]!.scores).toEqual([3, 3])
  })
})

// ---------------------------------------------------------------------------
// Fail-closed: a null dimension score drops the whole item
// ---------------------------------------------------------------------------

describe('scoreAndRank — fail-closed per item', () => {
  it('drops an item when any dimension score is null', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ prompt, opts }) => {
        const dim = dimOf(opts?.label)
        const item = prompt.split(' ').at(-1) as string
        // item 'b' fails its 'opportunity' dimension
        if (item === 'b' && dim === 'opportunity') return null
        return { score: 3, reason: 'r' }
      },
    })

    const result = await scoreAndRank(rt, makeOptions({ cutoff: { type: 'threshold', min: 0 } }))

    expect(result.value.map((s) => s.item).sort()).toEqual(['a', 'c'])
    expect(result.stats.dropped).toBe(1)
    expect(result.stats.itemsOut).toBe(2)
    // both dimensions of 'b' still spawned (parallel — fail-closed is post-hoc)
    expect(result.stats.agentsSpawned).toBe(6)
    expect(result.warnings.some((w) => w.includes('dropped'))).toBe(true)
    expect(rt.logs.some((l) => l.includes('dropped'))).toBe(true)
  })
})

describe('scoreAndRank — fail-closed on non-finite scores', () => {
  it('drops an item whose dimension score is NaN (never ranked; warns non-finite)', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ prompt, opts }) => {
        const dim = dimOf(opts?.label)
        const item = prompt.split(' ').at(-1) as string
        if (item === 'b' && dim === 'opportunity') return { score: NaN, reason: 'r' }
        return { score: 3, reason: 'r' }
      },
    })

    const result = await scoreAndRank(rt, makeOptions({ cutoff: { type: 'threshold', min: 0 } }))

    expect(result.value.map((s) => s.item).sort()).toEqual(['a', 'c'])
    expect(result.stats.dropped).toBe(1)
    expect(result.value.every((s) => Number.isFinite(s.score))).toBe(true)
    expect(result.warnings.some((w) => w.includes('non-finite'))).toBe(true)
  })

  it('drops an Infinity-scored item in topK mode — no junk survivor smuggled in by position', async () => {
    const scores: Record<string, number> = { a: 6, b: Number.POSITIVE_INFINITY, c: 1 }
    const rt = new FakeRuntime({
      onAgent: ({ prompt }) => ({ score: scores[prompt.split(' ').at(-1) as string]!, reason: 'r' }),
    })

    const result = await scoreAndRank(rt, {
      items: ['a', 'b', 'c'],
      dimensions: [{ name: 'x', prompt: (f) => `x of ${f}` }],
      cutoff: { type: 'topK', k: 2 },
    })

    // Without the finiteness guard, Infinity would sort #1 and survive, cutting 'c'.
    expect(result.value.map((s) => s.item)).toEqual(['a', 'c'])
    expect(result.stats.dropped).toBe(1)
    expect(result.value.every((s) => Number.isFinite(s.score))).toBe(true)
  })

  it('drops items when combine() itself returns a non-finite value from finite inputs', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 2, reason: 'r' }) })

    const result = await scoreAndRank(rt, makeOptions({
      items: ['a', 'b'],
      combine: () => NaN,
      cutoff: { type: 'threshold', min: 0 },
    }))

    expect(result.value).toEqual([])
    expect(result.stats.dropped).toBe(2)
    expect(result.stats.itemsOut).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Truncation via maxItems
// ---------------------------------------------------------------------------

describe('scoreAndRank — maxItems truncation', () => {
  it('scores only the first maxItems items and reports truncation', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 2, reason: 'r' }) })

    const result = await scoreAndRank(rt, makeOptions({
      items: ['a', 'b', 'c', 'd', 'e'],
      dimensions: [{ name: 'x', prompt: (f) => `x of ${f}` }],
      maxItems: 2,
      cutoff: { type: 'threshold', min: 0 },
    }))

    expect(result.stats.itemsIn).toBe(5)
    expect(result.stats.truncated).toBe(3)
    expect(result.stats.agentsSpawned).toBe(2) // 2 kept × 1 dim
    expect(result.warnings.some((w) => w.includes('not scored'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Model threading
// ---------------------------------------------------------------------------

describe('scoreAndRank — model threading', () => {
  it('applies scoreModel to every score agent', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 1, reason: 'r' }) })
    await scoreAndRank(rt, makeOptions({ scoreModel: 'haiku', cutoff: { type: 'threshold', min: 0 } }))
    expect(rt.calls.every((c) => c.opts?.model === 'haiku')).toBe(true)
  })

  it('a dimension model overrides scoreModel for that dimension only', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 1, reason: 'r' }) })
    await scoreAndRank(rt, {
      items: ['a'],
      scoreModel: 'haiku',
      dimensions: [
        { name: 'cheap', prompt: (f) => `c ${f}` },
        { name: 'rich', prompt: (f) => `r ${f}`, model: 'opus' },
      ],
      cutoff: { type: 'threshold', min: 0 },
    })
    const cheap = rt.calls.find((c) => dimOf(c.opts?.label) === 'cheap')
    const rich = rt.calls.find((c) => dimOf(c.opts?.label) === 'rich')
    expect(cheap?.opts?.model).toBe('haiku')
    expect(rich?.opts?.model).toBe('opus')
  })

  it('leaves model undefined when neither scoreModel nor dimension model set', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 1, reason: 'r' }) })
    await scoreAndRank(rt, makeOptions({ cutoff: { type: 'threshold', min: 0 } }))
    expect(rt.calls.every((c) => c.opts?.model === undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Phase + labels + control schema
// ---------------------------------------------------------------------------

describe('scoreAndRank — phase, labels, schema', () => {
  it('forwards opts.phase to every agent call', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 1, reason: 'r' }) })
    await scoreAndRank(rt, makeOptions({ phase: 'score-phase', cutoff: { type: 'threshold', min: 0 } }))
    expect(rt.calls.every((c) => c.phase === 'score-phase')).toBe(true)
  })

  it('assigns scoreAndRank:score:<i>:<dim> labels', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 1, reason: 'r' }) })
    await scoreAndRank(rt, makeOptions({ items: ['a'], cutoff: { type: 'threshold', min: 0 } }))
    const labels = rt.calls.map((c) => c.opts?.label)
    expect(labels).toContain('scoreAndRank:score:0:impact')
    expect(labels).toContain('scoreAndRank:score:0:opportunity')
  })

  it('passes the score control schema to every score agent', async () => {
    let captured: unknown = null
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (isScoreCall(opts)) captured = opts?.schema
        return { score: 1, reason: 'r' }
      },
    })
    await scoreAndRank(rt, makeOptions({ items: ['a'], cutoff: { type: 'threshold', min: 0 } }))
    expect(captured).toMatchObject({
      type: 'object',
      properties: { score: { type: 'number' }, reason: { type: 'string' } },
      required: ['score', 'reason'],
      additionalProperties: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

describe('scoreAndRank — audit trail', () => {
  it('trail.length === agentsSpawned and carries score decisions', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 4, reason: 'r' }) })
    const result = await scoreAndRank(rt, makeOptions({ items: ['a'], cutoff: { type: 'threshold', min: 0 } }))

    expect(result.trail).toHaveLength(result.stats.agentsSpawned)
    expect(result.trail).toHaveLength(2)
    expect(result.trail[0]!.stage).toBe('scoreAndRank:score:0:impact')
    expect(result.trail[0]!.outcome).toBe('ok')
    expect(result.trail[0]!.decision).toBe('score=4')
    expect(result.trail[1]!.stage).toBe('scoreAndRank:score:0:opportunity')
  })

  it('records a null outcome for a failed dimension score', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (dimOf(opts?.label) === 'opportunity' ? null : { score: 3, reason: 'r' }),
    })
    const result = await scoreAndRank(rt, makeOptions({ items: ['a'], cutoff: { type: 'threshold', min: 0 } }))

    const oppRecord = result.trail.find((r) => r.stage === 'scoreAndRank:score:0:opportunity')!
    expect(oppRecord.outcome).toBe('null')
    expect(oppRecord).not.toHaveProperty('decision')
  })

  it('includes model in trail records when a model is in effect, absent otherwise', async () => {
    const withModel = new FakeRuntime({ onAgent: () => ({ score: 1, reason: 'r' }) })
    const r1 = await scoreAndRank(withModel, makeOptions({ items: ['a'], scoreModel: 'haiku', cutoff: { type: 'threshold', min: 0 } }))
    expect(r1.trail.every((r) => r.model === 'haiku')).toBe(true)

    const noModel = new FakeRuntime({ onAgent: () => ({ score: 1, reason: 'r' }) })
    const r2 = await scoreAndRank(noModel, makeOptions({ items: ['a'], cutoff: { type: 'threshold', min: 0 } }))
    expect(r2.trail.every((r) => !Object.prototype.hasOwnProperty.call(r, 'model'))).toBe(true)
  })

  it('determinism: same scenario twice yields identical trails and order', async () => {
    function run() {
      const scores: Record<string, Record<string, number>> = {
        a: { impact: 2, opportunity: 3 },
        b: { impact: 4, opportunity: 5 },
      }
      const rt = new FakeRuntime({
        onAgent: ({ prompt, opts }) => {
          const dim = dimOf(opts?.label)!
          const item = prompt.split(' ').at(-1) as string
          return { score: scores[item]![dim]!, reason: 'r' }
        },
      })
      return scoreAndRank(rt, makeOptions({ items: ['a', 'b'], cutoff: { type: 'topK', k: 2 } }))
    }
    const a = await run()
    const b = await run()
    expect(a.trail).toEqual(b.trail)
    expect(a.value.map((s) => s.item)).toEqual(b.value.map((s) => s.item))
  })
})

// ---------------------------------------------------------------------------
// Effort threading
// ---------------------------------------------------------------------------

describe('scoreAndRank — effort threading', () => {
  it('applies scoreEffort to every score agent', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 1, reason: 'r' }) })
    await scoreAndRank(rt, makeOptions({ scoreEffort: 'low', cutoff: { type: 'threshold', min: 0 } }))
    expect(rt.calls.every((c) => c.opts?.effort === 'low')).toBe(true)
  })

  it('a dimension effort overrides scoreEffort for that dimension only', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 1, reason: 'r' }) })
    await scoreAndRank(rt, {
      items: ['a'],
      scoreEffort: 'low',
      dimensions: [
        { name: 'cheap', prompt: (f) => `c ${f}` },
        { name: 'rich', prompt: (f) => `r ${f}`, effort: 'max' },
      ],
      cutoff: { type: 'threshold', min: 0 },
    })
    const cheap = rt.calls.find((c) => dimOf(c.opts?.label) === 'cheap')
    const rich = rt.calls.find((c) => dimOf(c.opts?.label) === 'rich')
    expect(cheap?.opts?.effort).toBe('low')
    expect(rich?.opts?.effort).toBe('max')
  })

  it('leaves effort undefined when neither scoreEffort nor dimension effort set', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 1, reason: 'r' }) })
    await scoreAndRank(rt, makeOptions({ cutoff: { type: 'threshold', min: 0 } }))
    expect(rt.calls.every((c) => c.opts?.effort === undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Effort in the audit trail
// ---------------------------------------------------------------------------

describe('scoreAndRank — trail: effort field', () => {
  it('includes effort in trail records when an effort is in effect, absent otherwise', async () => {
    const withEffort = new FakeRuntime({ onAgent: () => ({ score: 1, reason: 'r' }) })
    const r1 = await scoreAndRank(withEffort, makeOptions({ items: ['a'], scoreEffort: 'low', cutoff: { type: 'threshold', min: 0 } }))
    expect(r1.trail.every((r) => r.effort === 'low')).toBe(true)

    const noEffort = new FakeRuntime({ onAgent: () => ({ score: 1, reason: 'r' }) })
    const r2 = await scoreAndRank(noEffort, makeOptions({ items: ['a'], cutoff: { type: 'threshold', min: 0 } }))
    expect(r2.trail.every((r) => !Object.prototype.hasOwnProperty.call(r, 'effort'))).toBe(true)
  })
})
