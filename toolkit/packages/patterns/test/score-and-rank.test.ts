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
    // cacheWarm now defaults to TRUE at the pattern level — pin it false here
    // so every PRE-EXISTING test in this file keeps testing exactly what it
    // always tested, decoupled from the new default.
    cacheWarm: false,
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
      phase: 'score-phase',
    })

    const digest = rt.logs.map(parseDigest).find((d) => d?.stage === 'scoreAndRank')
    expect(digest?.counts).toEqual({ requested: 5, kept: 2, cut: 1, dropped: 1, truncated: 1 })
    expect(digest?.phase).toBe('score-phase')
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
        // The structured-output salvage respawn for the dead dimension must
        // fail too — this test scripts a dimension that is REALLY dead.
        if (opts?.label?.endsWith(':salvage') === true) return null
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
    // both dimensions of 'b' still spawned (parallel — fail-closed is post-hoc),
    // +1 salvage respawn for the dead score cell
    expect(result.stats.agentsSpawned).toBe(7)
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

// ---------------------------------------------------------------------------
// cacheWarm (default TRUE, mechanism a — first-completes-then-burst; opt OUT
// with cacheWarm: false)
//
// Model-agnostic by design: dimensions may each override their own model, so
// mechanism (a) (peel out one of the REAL score calls) is used rather than a
// warmup agent guessing a single model for the whole burst.
// ---------------------------------------------------------------------------

describe('scoreAndRank — cacheWarm=false (explicit opt-out)', () => {
  it('disables staggering entirely: later scores start before (item0,dim0) resolves', async () => {
    let laterScoreStartedBeforeFirstResolved = false
    let firstResolved = false
    let resolveFirst: (v: { score: number; reason: string }) => void = () => {}

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (opts?.label === 'scoreAndRank:score:0:impact') {
          return new Promise<{ score: number; reason: string }>((resolve) => {
            resolveFirst = (v) => { firstResolved = true; resolve(v) }
          })
        }
        if (!firstResolved) laterScoreStartedBeforeFirstResolved = true
        return { score: 3, reason: 'r' }
      },
    })

    const promise = scoreAndRank(rt, makeOptions({ cacheWarm: false }))
    await Promise.resolve()
    await Promise.resolve()

    expect(laterScoreStartedBeforeFirstResolved).toBe(true)
    resolveFirst({ score: 5, reason: 'warmed' })
    await promise
  })

  it('produces identical stats/value to cacheWarm:true — cacheWarm only affects timing, not outcome', async () => {
    const onAgent = () => ({ score: 3, reason: 'r' })
    const rtFalse = new FakeRuntime({ onAgent })
    const rtTrue = new FakeRuntime({ onAgent })

    const resultFalse = await scoreAndRank(rtFalse, makeOptions({ cacheWarm: false }))
    const resultTrue = await scoreAndRank(rtTrue, makeOptions({ cacheWarm: true }))

    expect(resultFalse.stats).toEqual(resultTrue.stats)
    expect(resultFalse.value).toEqual(resultTrue.value)
  })
})

describe('scoreAndRank — cacheWarm omitted (defaults to TRUE)', () => {
  it('staggers by default when the option is not passed at all', async () => {
    let laterScoreStartedBeforeFirstResolved = false
    let firstResolved = false
    let resolveFirst: (v: { score: number; reason: string }) => void = () => {}

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (opts?.label === 'scoreAndRank:score:0:impact') {
          return new Promise<{ score: number; reason: string }>((resolve) => {
            resolveFirst = (v) => { firstResolved = true; resolve(v) }
          })
        }
        if (!firstResolved) laterScoreStartedBeforeFirstResolved = true
        return { score: 3, reason: 'r' }
      },
    })

    // Bypass this file's makeOptions() (which pins cacheWarm:false for the
    // OTHER tests in this file) — construct the options object directly, with
    // the cacheWarm key genuinely ABSENT, to prove the PATTERN's own default.
    const promise = scoreAndRank(rt, {
      items: ['a', 'b', 'c'],
      dimensions: TWO_DIMS,
      cutoff: { type: 'threshold', min: 1 },
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(laterScoreStartedBeforeFirstResolved).toBe(false)
    resolveFirst({ score: 5, reason: 'warmed' })
    await promise
  })
})

describe('scoreAndRank — cacheWarm=true (staggered)', () => {
  it('awaits the FIRST (item0,dim0) score call to completion before the rest are invoked', async () => {
    let laterScoreStartedBeforeFirstResolved = false
    let firstResolved = false
    let resolveFirst: (v: { score: number; reason: string }) => void = () => {}

    const rt = new FakeRuntime({
      onAgent: ({ opts }) => {
        if (opts?.label === 'scoreAndRank:score:0:impact') {
          return new Promise<{ score: number; reason: string }>((resolve) => {
            resolveFirst = (v) => { firstResolved = true; resolve(v) }
          })
        }
        if (!firstResolved) laterScoreStartedBeforeFirstResolved = true
        return { score: 3, reason: 'r' }
      },
    })

    const promise = scoreAndRank(rt, makeOptions({ cacheWarm: true }))
    await Promise.resolve()
    await Promise.resolve()

    expect(laterScoreStartedBeforeFirstResolved).toBe(false)
    expect(rt.calls.map(c => c.opts?.label)).toEqual(['scoreAndRank:score:0:impact'])

    resolveFirst({ score: 5, reason: 'warmed' })
    const result = await promise

    expect(result.stats.agentsSpawned).toBe(6) // 3 items x 2 dims
  })

  it('does not add an extra agent — stats/agentsSpawned match the un-staggered run', async () => {
    const onAgent = () => ({ score: 3, reason: 'r' })
    const rtWarm = new FakeRuntime({ onAgent })
    const rtPlain = new FakeRuntime({ onAgent })

    const resultWarm = await scoreAndRank(rtWarm, makeOptions({ cacheWarm: true }))
    const resultPlain = await scoreAndRank(rtPlain, makeOptions())

    expect(resultWarm.stats).toEqual(resultPlain.stats)
    expect(resultWarm.value).toEqual(resultPlain.value)
  })

  it('is a no-op (no staggering) for a single (item, dimension) task', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 3, reason: 'r' }) })
    const result = await scoreAndRank(rt, makeOptions({
      items: ['solo'],
      dimensions: [{ name: 'impact', prompt: (f) => `impact of ${f}` }],
      cutoff: { type: 'threshold', min: 0 },
      cacheWarm: true,
    }))
    expect(result.stats.agentsSpawned).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Stage salting (card #1816036725248493168) — per-invocation discriminator
// ---------------------------------------------------------------------------

describe('scoreAndRank — stage salting', () => {
  const soloDims: Array<ScoreDimension<string>> = [{ name: 'impact', prompt: (f) => `impact of ${f}` }]
  const soloOpts = { items: ['solo'], dimensions: soloDims, cutoff: { type: 'threshold' as const, min: 0 } }

  it('two invocations on the SAME rt: first bare, second salted " #2" on every label', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 3, reason: 'r' }) })

    await scoreAndRank(rt, makeOptions(soloOpts))
    const firstLabels = rt.calls.map((c) => c.opts?.label)

    await scoreAndRank(rt, makeOptions(soloOpts))
    const secondLabels = rt.calls.slice(firstLabels.length).map((c) => c.opts?.label)

    expect(firstLabels).toEqual(['scoreAndRank:score:0:impact'])
    expect(secondLabels).toEqual(['scoreAndRank:score:0:impact #2'])
  })

  it('trail.stage === the rt.agent label for the same step, on the salted (2nd) invocation', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 3, reason: 'r' }) })
    await scoreAndRank(rt, makeOptions(soloOpts))
    const result = await scoreAndRank(rt, makeOptions(soloOpts))

    const secondCalls = rt.calls.slice(1)
    for (const record of result.trail) {
      const match = secondCalls.find((c) => c.opts?.label === record.stage)
      expect(match, `no rt.agent call found with label === trail.stage "${record.stage}"`).toBeDefined()
    }
    expect(result.trail.map((r) => r.stage)).toEqual(['scoreAndRank:score:0:impact #2'])
  })

  it('an explicit stageKey salts every stage/label of that invocation, including a salvage record', async () => {
    // score returns null once → structured-output salvage respawn fires; its
    // schema-less answer is also non-JSON, so salvage fails too.
    const rt = new FakeRuntime({
      onAgent: ({ opts }) => (isScoreCall(opts) ? null : 'not-json'),
    })

    const result = await scoreAndRank(rt, makeOptions({ ...soloOpts, stageKey: 'my-key' }))

    expect(rt.calls.map((c) => c.opts?.label)).toEqual([
      'scoreAndRank:score:0:impact #my-key',
      'scoreAndRank:score:0:impact #my-key:salvage',
    ])
    expect(result.trail.map((r) => r.stage)).toEqual([
      'scoreAndRank:score:0:impact #my-key',
      'scoreAndRank:score:0:impact #my-key:salvage',
    ])
    expect(result.warnings.join(' ')).not.toMatch(/stageKey/)
  })

  it('distinct rt instances stay isolated — both get the bare first invocation', async () => {
    const rt1 = new FakeRuntime({ onAgent: () => ({ score: 3, reason: 'r' }) })
    const rt2 = new FakeRuntime({ onAgent: () => ({ score: 3, reason: 'r' }) })

    await scoreAndRank(rt1, makeOptions(soloOpts))
    await scoreAndRank(rt2, makeOptions(soloOpts))

    expect(rt1.calls.map((c) => c.opts?.label)).toEqual(['scoreAndRank:score:0:impact'])
    expect(rt2.calls.map((c) => c.opts?.label)).toEqual(['scoreAndRank:score:0:impact'])
  })

  it('digest.stage stays bare even on a salted (2nd) invocation', async () => {
    const rt = new FakeRuntime({ onAgent: () => ({ score: 3, reason: 'r' }) })
    await scoreAndRank(rt, makeOptions(soloOpts))
    await scoreAndRank(rt, makeOptions(soloOpts))

    const digests = rt.logs.map(parseDigest).filter((d) => d?.stage === 'scoreAndRank')
    expect(digests).toHaveLength(2)
    for (const d of digests) expect(d?.stage).toBe('scoreAndRank')
  })
})

// ---------------------------------------------------------------------------
// Flattening detector — SCALE-FREE, and deliberately weaker than tournament's.
//
// Same hazard (a scorer that does not discriminate makes the ranking arbitrary,
// so the cutoff cuts on order rather than merit), but this pattern's `score` is
// UNBOUNDED and its scale belongs to the caller — `combine` is arbitrary. A
// fixed "spread below N" threshold would impose a scale the pattern refuses on
// purpose and would fire constantly on any caller whose natural range is small.
// So the only statement that needs no units is the strongest one: every score
// identical. It under-detects by design; that is the right trade for a check
// that must never cry on a legitimate scale.
// ---------------------------------------------------------------------------

describe('scoreAndRank — flattening detector', () => {
  const flatAt = (v: number) => ({ onAgent: ({ opts }: { opts?: { schema?: unknown } }) =>
    isScoreCall(opts) ? { score: v, reason: 'flat' } : null })

  it('WARNS when every item receives the identical score', async () => {
    const rt = new FakeRuntime(flatAt(3))
    const result = await scoreAndRank(rt, makeOptions())
    expect(result.warnings.filter(w => /IDENTICAL score/.test(w))).toHaveLength(1)
  })

  it('is SCALE-FREE — fires the same on a tiny range as on a large one', async () => {
    // 0.001 everywhere is as flat as 1000 everywhere. A threshold-based test
    // would miss one of these; this is why the check is equality, not spread.
    const tiny = new FakeRuntime(flatAt(0.001))
    const huge = new FakeRuntime(flatAt(1000))
    const a = await scoreAndRank(tiny, makeOptions({ cutoff: { type: 'topK', k: 3 } }))
    const b = await scoreAndRank(huge, makeOptions({ cutoff: { type: 'topK', k: 3 } }))
    expect(a.warnings.filter(w => /IDENTICAL score/.test(w))).toHaveLength(1)
    expect(b.warnings.filter(w => /IDENTICAL score/.test(w))).toHaveLength(1)
  })

  it('stays SILENT when scores differ, even barely', async () => {
    // Deliberate: a near-flat set does NOT fire. Under-detection is the accepted
    // cost of never misreading a caller's legitimate narrow scale.
    //
    // ⚠ The score compared is the COMBINED one (product of dimensions by
    // default), not a single dimension. A first version of this fixture varied
    // the raw scores per CALL and every item still combined to the identical
    // product — the detector fired and was right; the fixture was naive. Vary
    // per ITEM, which is what the detector actually reads.
    const rt = new FakeRuntime({
      onAgent: ({ prompt, opts }) => {
        if (!isScoreCall(opts)) return null
        const item = String(prompt).trim().split(/\s+/).pop()
        return { score: item === 'a' ? 1 : item === 'b' ? 1.0001 : 1.0002, reason: 'r' }
      },
    })
    const result = await scoreAndRank(rt, makeOptions({ cutoff: { type: 'topK', k: 3 } }))
    expect(result.warnings.filter(w => /IDENTICAL score/.test(w))).toHaveLength(0)
  })

  it('does not fire on a single ranked item — equality needs two to mean anything', async () => {
    const rt = new FakeRuntime(flatAt(5))
    const result = await scoreAndRank(rt, makeOptions({ items: ['solo'], cutoff: { type: 'topK', k: 1 } }))
    expect(result.warnings.filter(w => /IDENTICAL score/.test(w))).toHaveLength(0)
  })
})
