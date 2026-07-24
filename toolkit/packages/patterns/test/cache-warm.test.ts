import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import type { AgentOptions } from '@workflow-toolbox/runtime'
import {
  parallelWithCacheWarm,
  pipelineWithCacheWarm,
  runCacheWarmup,
} from '../src/cache-warm.js'

// ---------------------------------------------------------------------------
// parallelWithCacheWarm — mechanism (a) over rt.parallel
// ---------------------------------------------------------------------------

describe('parallelWithCacheWarm — enabled=false (inert)', () => {
  it('is byte-identical to rt.parallel(thunks): same results, same call order', async () => {
    const rt = new FakeRuntime({ onAgent: ({ index }) => `r${index}` })
    const thunks = [0, 1, 2].map((i) => async () => rt.agent<string>(`p${i}`))

    const results = await parallelWithCacheWarm(rt, thunks, false)

    expect(results).toEqual(['r1', 'r2', 'r3'])
    expect(rt.calls.map((c) => c.prompt)).toEqual(['p0', 'p1', 'p2'])
  })

  it('does not stagger even with 2+ thunks when disabled', async () => {
    let secondStartedBeforeFirstResolved = false
    let firstResolved = false
    let resolveFirst: (v: string) => void = () => {}

    const rt = new FakeRuntime({
      onAgent: ({ prompt }) => {
        if (prompt === 'p0') {
          return new Promise<string>((resolve) => {
            resolveFirst = (v) => { firstResolved = true; resolve(v) }
          })
        }
        if (!firstResolved) secondStartedBeforeFirstResolved = true
        return 'ok'
      },
    })

    const thunks = [0, 1].map((i) => async () => rt.agent<string>(`p${i}`))
    const promise = parallelWithCacheWarm(rt, thunks, false)

    // Flush one microtask turn — with concurrency, thunk[1] should already have
    // been invoked even though thunk[0] is still pending.
    await Promise.resolve()
    expect(secondStartedBeforeFirstResolved).toBe(true)

    resolveFirst('p0-result')
    await promise
  })
})

describe('parallelWithCacheWarm — enabled=true, <2 thunks (no-op)', () => {
  it('falls back to rt.parallel unchanged for 0 thunks', async () => {
    const rt = new FakeRuntime()
    const results = await parallelWithCacheWarm(rt, [], true)
    expect(results).toEqual([])
  })

  it('falls back to rt.parallel unchanged for exactly 1 thunk', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'solo' })
    const thunks = [async () => rt.agent<string>('only')]
    const results = await parallelWithCacheWarm(rt, thunks, true)
    expect(results).toEqual(['solo'])
    expect(rt.calls).toHaveLength(1)
  })
})

describe('parallelWithCacheWarm — enabled=true, 2+ thunks (staggered)', () => {
  it('awaits thunks[0] to completion BEFORE invoking the rest', async () => {
    let secondStartedBeforeFirstResolved = false
    let firstResolved = false
    let resolveFirst: (v: string) => void = () => {}

    const rt = new FakeRuntime({
      onAgent: ({ prompt }) => {
        if (prompt === 'p0') {
          return new Promise<string>((resolve) => {
            resolveFirst = (v) => { firstResolved = true; resolve(v) }
          })
        }
        if (!firstResolved) secondStartedBeforeFirstResolved = true
        return 'ok'
      },
    })

    const thunks = [0, 1, 2].map((i) => async () => rt.agent<string>(`p${i}`))
    const promise = parallelWithCacheWarm(rt, thunks, true)

    await Promise.resolve()
    await Promise.resolve()
    // thunk[0] is still pending — thunks[1]/[2] must NOT have started yet.
    expect(secondStartedBeforeFirstResolved).toBe(false)
    expect(rt.calls.map((c) => c.prompt)).toEqual(['p0'])

    resolveFirst('p0-result')
    const results = await promise

    expect(results).toEqual(['p0-result', 'ok', 'ok'])
    expect(rt.calls.map((c) => c.prompt)).toEqual(['p0', 'p1', 'p2'])
  })

  it('preserves rt.parallel\'s never-rejects contract: a throwing thunks[0] resolves to null', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'rest-ok' })
    const thunks = [
      async () => { throw new Error('boom') },
      async () => rt.agent<string>('p1'),
      async () => rt.agent<string>('p2'),
    ]

    const results = await parallelWithCacheWarm(rt, thunks, true)

    expect(results).toEqual([null, 'rest-ok', 'rest-ok'])
  })

  it('returns results in original index order, not completion order', async () => {
    const rt = new FakeRuntime({ onAgent: ({ index }) => `r${index}` })
    const thunks = [0, 1, 2, 3].map((i) => async () => rt.agent<string>(`p${i}`))

    const results = await parallelWithCacheWarm(rt, thunks, true)

    expect(results).toEqual(['r1', 'r2', 'r3', 'r4'])
  })
})

// ---------------------------------------------------------------------------
// pipelineWithCacheWarm — mechanism (a) over rt.pipeline
// ---------------------------------------------------------------------------

describe('pipelineWithCacheWarm — enabled=false (inert)', () => {
  it('is byte-identical to rt.pipeline(items, ...stages)', async () => {
    const rt = new FakeRuntime()
    const stage = (prev: unknown, _orig: unknown, index: number) => `${prev}-stage:${index}`

    const results = await pipelineWithCacheWarm(rt, ['a', 'b', 'c'], [stage], false)

    expect(results).toEqual(['a-stage:0', 'b-stage:1', 'c-stage:2'])
  })
})

describe('pipelineWithCacheWarm — enabled=true, <2 items (no-op)', () => {
  it('falls back unchanged for 0 items', async () => {
    const rt = new FakeRuntime()
    const stage = (prev: unknown) => prev
    const results = await pipelineWithCacheWarm(rt, [], [stage], true)
    expect(results).toEqual([])
  })

  it('falls back unchanged for exactly 1 item', async () => {
    const rt = new FakeRuntime()
    const stage = (prev: unknown, _orig: unknown, index: number) => `${prev}:${index}`
    const results = await pipelineWithCacheWarm(rt, ['solo'], [stage], true)
    expect(results).toEqual(['solo:0'])
  })
})

describe('pipelineWithCacheWarm — enabled=true, 2+ items (staggered, index-preserving)', () => {
  it('runs item[0] alone first, preserving each item\'s ORIGINAL index across the split', async () => {
    const seenIndices: number[] = []
    const stage = (prev: unknown, _orig: unknown, index: number): unknown => {
      seenIndices.push(index)
      return `${prev}:idx${index}`
    }

    const rt = new FakeRuntime()
    const results = await pipelineWithCacheWarm(rt, ['a', 'b', 'c'], [stage], true)

    // Critical regression guard: without the offset fix, item 'b' (position 1
    // in the REST batch, position 0 within its own rt.pipeline call) would be
    // mislabeled index 0 instead of 1.
    expect(seenIndices).toEqual([0, 1, 2])
    expect(results).toEqual(['a:idx0', 'b:idx1', 'c:idx2'])
  })

  it('awaits item[0] through the FULL stage chain before the rest launch', async () => {
    let secondStartedBeforeFirstResolved = false
    let firstResolved = false
    let resolveFirst: (v: string) => void = () => {}

    const stage = (prev: unknown, orig: unknown): unknown => {
      if (orig === 'a') {
        return new Promise<string>((resolve) => {
          resolveFirst = (v) => { firstResolved = true; resolve(v) }
        })
      }
      if (!firstResolved) secondStartedBeforeFirstResolved = true
      return `${prev}-done`
    }

    const rt = new FakeRuntime()
    const promise = pipelineWithCacheWarm(rt, ['a', 'b', 'c'], [stage], true)

    await Promise.resolve()
    await Promise.resolve()
    expect(secondStartedBeforeFirstResolved).toBe(false)

    resolveFirst('a-result')
    const results = await promise

    expect(results).toEqual(['a-result', 'b-done', 'c-done'])
  })

  it('applies ALL stages with the correct offset (multi-stage chain)', async () => {
    const stage1 = (prev: unknown, _orig: unknown, index: number): unknown => `${prev}/s1:${index}`
    const stage2 = (prev: unknown, _orig: unknown, index: number): unknown => `${prev}/s2:${index}`

    const rt = new FakeRuntime()
    const results = await pipelineWithCacheWarm(rt, ['a', 'b', 'c'], [stage1, stage2], true)

    expect(results).toEqual(['a/s1:0/s2:0', 'b/s1:1/s2:1', 'c/s1:2/s2:2'])
  })
})

// ---------------------------------------------------------------------------
// runCacheWarmup — mechanism (b)
// ---------------------------------------------------------------------------

describe('runCacheWarmup', () => {
  it('fires exactly one agent call with the given label/model/effort/agentType', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ready' })
    const warnings: string[] = []

    const record = await runCacheWarmup(rt, warnings, 'myStage:warm', 'myStage', {
      model: 'opus',
      effort: 'low',
      agentType: 'magic-claude:ts-reviewer',
      phase: 'my-phase',
    })

    expect(rt.calls).toHaveLength(1)
    const call = rt.calls[0]!
    expect(call.prompt).toBe('Reply with a single word: ready.')
    expect(call.opts?.label).toBe('myStage:warm')
    expect(call.opts?.model).toBe('opus')
    expect(call.opts?.effort).toBe('low')
    expect(call.opts?.agentType).toBe('magic-claude:ts-reviewer')
    expect(call.phase).toBe('my-phase')

    expect(record).toEqual({ stage: 'myStage:warm', outcome: 'ok', model: 'opus', effort: 'low' })
    expect(warnings).toHaveLength(0)
  })

  it('omits phase/model/effort/agentType from AgentOptions when not provided', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ready' })
    const warnings: string[] = []

    await runCacheWarmup(rt, warnings, 'myStage:warm', 'myStage', {})

    const opts: AgentOptions | undefined = rt.calls[0]!.opts
    expect(opts).not.toHaveProperty('model')
    expect(opts).not.toHaveProperty('effort')
    expect(opts).not.toHaveProperty('agentType')
    expect(opts).not.toHaveProperty('phase')
  })

  it('keeps plain warmups unchanged without an agentType', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ready' })
    const warnings: string[] = []

    const record = await runCacheWarmup(rt, warnings, 'myStage:warm', 'myStage', {})

    expect(rt.calls).toHaveLength(1)
    expect(rt.calls[0]!.prompt).toBe('Reply with a single word: ready.')
    expect(record.outcome).toBe('ok')
  })

  it('skips an external opencode lane that self-answers', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ready.' })
    const warnings: string[] = []

    const record = await runCacheWarmup(rt, warnings, 'myStage:warm', 'myStage', {
      agentType: 'workflow-toolbox:opencode-verifier',
    })

    expect(rt.calls).toHaveLength(2)
    expect(record.outcome).toBe('null')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('SKIPPED')
    expect(warnings[0]).toContain('opencode')
  })

  it('accepts an external opencode lane proven on the first try', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'opencode 1.18.4' })
    const warnings: string[] = []

    const record = await runCacheWarmup(rt, warnings, 'myStage:warm', 'myStage', {
      agentType: 'workflow-toolbox:opencode-verifier',
    })

    expect(rt.calls).toHaveLength(1)
    expect(record.outcome).toBe('ok')
    expect(warnings).toHaveLength(0)
    expect(rt.calls[0]!.prompt).toContain('opencode --version')
  })

  it('retries an external opencode lane once before accepting proof', async () => {
    let calls = 0
    const rt = new FakeRuntime({
      onAgent: () => {
        calls++
        return calls === 1 ? 'ready.' : 'opencode 1.18.4'
      },
    })
    const warnings: string[] = []

    const record = await runCacheWarmup(rt, warnings, 'myStage:warm', 'myStage', {
      agentType: 'workflow-toolbox:opencode-verifier',
    })

    expect(rt.calls).toHaveLength(2)
    expect(record.outcome).toBe('ok')
    expect(warnings).toHaveLength(0)
  })

  it('derives codex --version for an external codex lane', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ready.' })
    const warnings: string[] = []

    const record = await runCacheWarmup(rt, warnings, 'myStage:warm', 'myStage', {
      agentType: 'codex:codex-rescue',
    })

    expect(rt.calls[0]!.prompt).toContain('codex --version')
    expect(record.outcome).toBe('null')
  })

  it('degrades gracefully on a null (failed) warmup: warns, still returns an outcome=null record', async () => {
    const rt = new FakeRuntime({ onAgent: () => null })
    const warnings: string[] = []

    const record = await runCacheWarmup(rt, warnings, 'myStage:warm', 'myStage', { model: 'sonnet' })

    expect(record.outcome).toBe('null')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('myStage')
    expect(warnings[0]).toContain('myStage:warm')
    expect(rt.logs).toEqual(warnings)
  })

  it('charges the warmup call against the budget like any other agent() call', async () => {
    const rt = new FakeRuntime({ onAgent: () => 'ready', budgetTotal: 100, agentTokenCost: 30 })
    const warnings: string[] = []

    expect(rt.budget.spent()).toBe(0)
    await runCacheWarmup(rt, warnings, 'myStage:warm', 'myStage', {})
    expect(rt.budget.spent()).toBe(30)
  })
})
