import { describe, it, expect, vi } from 'vitest'
import { FakeRuntime } from '../src/fake.js'

// ---------------------------------------------------------------------------
// 1. Response queue — FIFO order, string and object responses
// ---------------------------------------------------------------------------
describe('FakeRuntime response queue', () => {
  it('returns responses in FIFO order', async () => {
    const rt = new FakeRuntime({ responses: ['first', 'second', 'third'] })
    expect(await rt.agent('prompt A')).toBe('first')
    expect(await rt.agent('prompt B')).toBe('second')
    expect(await rt.agent('prompt C')).toBe('third')
  })

  it('returns a string response as-is', async () => {
    const rt = new FakeRuntime({ responses: ['hello world'] })
    const result = await rt.agent('any prompt')
    expect(result).toBe('hello world')
  })

  it('returns an object response when a schema opt is provided', async () => {
    const payload = { score: 42, label: 'good' }
    const rt = new FakeRuntime({ responses: [payload] })
    const schema = { type: 'object' as const, properties: { score: { type: 'number' as const } } }
    const result = await rt.agent('rate it', { schema })
    expect(result).toEqual(payload)
  })
})

// ---------------------------------------------------------------------------
// 2. Queue exhaustion — clear actionable error
// ---------------------------------------------------------------------------
describe('FakeRuntime queue exhaustion', () => {
  it('throws a clear actionable error including call index and prompt', async () => {
    const rt = new FakeRuntime({ responses: ['only one'] })
    await rt.agent('first call')
    await expect(rt.agent('second call — should explode')).rejects.toThrow(
      /FakeRuntime: agent call #2 but only 1 responses? scripted — prompt was: second call/,
    )
  })

  it('error message includes the exact call index', async () => {
    const rt = new FakeRuntime({ responses: [] })
    await expect(rt.agent('call with empty queue')).rejects.toThrow(
      /FakeRuntime: agent call #1 but only 0 responses? scripted/,
    )
  })
})

// ---------------------------------------------------------------------------
// 3. null response — simulates skip; agentsSpawned still increments
// ---------------------------------------------------------------------------
describe('FakeRuntime null response (skipped agent)', () => {
  it('resolves to null for a queued null', async () => {
    const rt = new FakeRuntime({ responses: [null] })
    const result = await rt.agent('this one is skipped')
    expect(result).toBeNull()
  })

  it('increments agentsSpawned even for a null response', async () => {
    const rt = new FakeRuntime({ responses: [null, 'ok'] })
    await rt.agent('skipped')
    await rt.agent('real')
    expect(rt.agentsSpawned).toBe(2)
  })

  it('records the call even for a null response', async () => {
    const rt = new FakeRuntime({ responses: [null] })
    await rt.agent('skipped prompt')
    expect(rt.calls).toHaveLength(1)
    expect(rt.calls[0]!.prompt).toBe('skipped prompt')
  })

  it('records per-agent opts including model and effort', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    await rt.agent('tuned prompt', { model: 'sonnet', effort: 'high' })
    expect(rt.calls[0]!.opts).toEqual({ model: 'sonnet', effort: 'high' })
  })
})

// ---------------------------------------------------------------------------
// 4. Handler mode — receives prompt/opts/index; handler throw rejects
// ---------------------------------------------------------------------------
describe('FakeRuntime handler mode', () => {
  it('calls the handler with prompt, opts, and index', async () => {
    const handler = vi.fn().mockResolvedValue('from handler')
    const rt = new FakeRuntime({ onAgent: handler })
    const opts = { label: 'my-agent' }
    await rt.agent('test prompt', opts)
    expect(handler).toHaveBeenCalledWith({
      prompt: 'test prompt',
      opts,
      index: 1,
    })
  })

  it('returns the handler return value', async () => {
    const rt = new FakeRuntime({ onAgent: () => Promise.resolve({ data: 123 }) })
    const result = await rt.agent('anything')
    expect(result).toEqual({ data: 123 })
  })

  it('rejects when the handler throws', async () => {
    const rt = new FakeRuntime({ onAgent: () => { throw new Error('handler boom') } })
    await expect(rt.agent('bad prompt')).rejects.toThrow('handler boom')
  })

  it('increments index on successive calls', async () => {
    const indices: number[] = []
    const rt = new FakeRuntime({
      onAgent: ({ index }) => { indices.push(index); return Promise.resolve('ok') },
    })
    await rt.agent('a')
    await rt.agent('b')
    expect(indices).toEqual([1, 2])
  })
})

// ---------------------------------------------------------------------------
// 5. Mutual exclusion — constructor throws when both responses and onAgent given
// ---------------------------------------------------------------------------
describe('FakeRuntime constructor mutual exclusion', () => {
  it('throws when both responses and onAgent are provided', () => {
    expect(() => new FakeRuntime({
      responses: ['x'],
      onAgent: () => Promise.resolve('y'),
    })).toThrow(/mutually exclusive/)
  })

  it('does not throw when only responses is provided', () => {
    expect(() => new FakeRuntime({ responses: ['x'] })).not.toThrow()
  })

  it('does not throw when only onAgent is provided', () => {
    expect(() => new FakeRuntime({ onAgent: () => Promise.resolve('x') })).not.toThrow()
  })

  it('does not throw with no options at all', () => {
    expect(() => new FakeRuntime()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 6. parallel — thunk throw → null; siblings preserved; never rejects
// ---------------------------------------------------------------------------
describe('FakeRuntime parallel()', () => {
  it('runs all thunks and returns results in order', async () => {
    const rt = new FakeRuntime()
    const results = await rt.parallel([
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ])
    expect(results).toEqual(['a', 'b', 'c'])
  })

  it('resolves a throwing thunk to null', async () => {
    const rt = new FakeRuntime()
    const results = await rt.parallel([
      () => Promise.resolve('ok'),
      () => { throw new Error('boom') },
      () => Promise.resolve('also ok'),
    ])
    expect(results).toEqual(['ok', null, 'also ok'])
  })

  it('resolves a rejecting thunk to null', async () => {
    const rt = new FakeRuntime()
    const results = await rt.parallel([
      () => Promise.reject(new Error('rejected')),
      () => Promise.resolve('fine'),
    ])
    expect(results).toEqual([null, 'fine'])
  })

  it('never rejects overall even when all thunks fail', async () => {
    const rt = new FakeRuntime()
    await expect(rt.parallel([
      () => { throw new Error('one') },
      () => Promise.reject(new Error('two')),
    ])).resolves.toEqual([null, null])
  })
})

// ---------------------------------------------------------------------------
// 7. pipeline — (prev, originalItem, index); stage throw → null, skip remaining
// ---------------------------------------------------------------------------
describe('FakeRuntime pipeline()', () => {
  it('passes (prev, originalItem, index) to each stage', async () => {
    // Collect calls keyed by item to avoid ordering assumptions across concurrent items.
    const callsByItem: Record<string, Array<[unknown, unknown, number]>> = {}
    const rt = new FakeRuntime()
    await rt.pipeline(
      ['a', 'b'],
      (prev, orig, idx) => {
        const key = String(orig)
        callsByItem[key] ??= []
        callsByItem[key]!.push([prev, orig, idx])
        return `${String(prev)}-1`
      },
      (prev, orig, idx) => {
        const key = String(orig)
        callsByItem[key] ??= []
        callsByItem[key]!.push([prev, orig, idx])
        return `${String(prev)}-2`
      },
    )
    // For item 'a' (index 0): stage1 receives (orig='a', prev='a'), stage2 receives prev='a-1'
    expect(callsByItem['a']).toEqual([['a', 'a', 0], ['a-1', 'a', 0]])
    // For item 'b' (index 1): stage1 receives (orig='b', prev='b'), stage2 receives prev='b-1'
    expect(callsByItem['b']).toEqual([['b', 'b', 1], ['b-1', 'b', 1]])
  })

  it('drops an item to null when a stage throws', async () => {
    const rt = new FakeRuntime()
    const results = await rt.pipeline(
      ['good', 'bad', 'also-good'],
      (item) => {
        if (item === 'bad') throw new Error('drop me')
        return item
      },
      (item) => `processed:${String(item)}`,
    )
    expect(results).toEqual(['processed:good', null, 'processed:also-good'])
  })

  it('does NOT call remaining stages for a dropped item', async () => {
    const stage2 = vi.fn().mockReturnValue('stage2-result')
    const rt = new FakeRuntime()
    await rt.pipeline(
      ['ok', 'fail'],
      (item) => {
        if (item === 'fail') throw new Error('nope')
        return item
      },
      stage2,
    )
    // stage2 called once (for 'ok'), not twice
    expect(stage2).toHaveBeenCalledTimes(1)
    expect(stage2).toHaveBeenCalledWith('ok', 'ok', 0)
  })

  it('processes other items even when one item fails', async () => {
    const rt = new FakeRuntime()
    const results = await rt.pipeline(
      [1, 2, 3],
      (n) => {
        if (n === 2) throw new Error('skip 2')
        return (n as number) * 10
      },
    )
    expect(results).toEqual([10, null, 30])
  })

  it('returns an empty array for empty input', async () => {
    const rt = new FakeRuntime()
    const results = await rt.pipeline([], (x) => x)
    expect(results).toEqual([])
  })

  it('returns items unchanged when no stages are given', async () => {
    const rt = new FakeRuntime()
    const results = await rt.pipeline([1, 'two', { three: 3 }])
    expect(results).toEqual([1, 'two', { three: 3 }])
  })
})

// ---------------------------------------------------------------------------
// 8. Phases — ordering, agent inherits phase, opts.phase overrides
// ---------------------------------------------------------------------------
describe('FakeRuntime phase recording', () => {
  it('records phase titles in order', async () => {
    const rt = new FakeRuntime({ responses: ['a', 'b'] })
    rt.phase('Setup')
    rt.phase('Process')
    expect(rt.phases).toEqual(['Setup', 'Process'])
  })

  it('agent call inherits the current phase', async () => {
    const rt = new FakeRuntime({ responses: ['result'] })
    rt.phase('Scan')
    await rt.agent('do something')
    expect(rt.calls[0]!.phase).toBe('Scan')
  })

  it('opts.phase overrides the current phase for a single call', async () => {
    const rt = new FakeRuntime({ responses: ['result'] })
    rt.phase('Outer')
    await rt.agent('do something', { phase: 'Inner' })
    expect(rt.calls[0]!.phase).toBe('Inner')
  })

  it('opts.phase does not permanently change the current phase', async () => {
    const rt = new FakeRuntime({ responses: ['r1', 'r2'] })
    rt.phase('Outer')
    await rt.agent('first', { phase: 'Inner' })
    await rt.agent('second')
    expect(rt.calls[0]!.phase).toBe('Inner')
    expect(rt.calls[1]!.phase).toBe('Outer')
  })

  it('calls record their phase', async () => {
    const rt = new FakeRuntime({ responses: ['x', 'y'] })
    rt.phase('Alpha')
    await rt.agent('a')
    rt.phase('Beta')
    await rt.agent('b')
    expect(rt.calls[0]!.phase).toBe('Alpha')
    expect(rt.calls[1]!.phase).toBe('Beta')
  })

  it('call phase is undefined before any phase() call', async () => {
    const rt = new FakeRuntime({ responses: ['x'] })
    await rt.agent('no phase yet')
    expect(rt.calls[0]!.phase).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 9. Budget
// ---------------------------------------------------------------------------
describe('FakeRuntime budget', () => {
  it('defaults to null total — remaining() is Infinity', () => {
    const rt = new FakeRuntime()
    expect(rt.budget.total).toBeNull()
    expect(rt.budget.remaining()).toBe(Infinity)
  })

  it('spent() starts at 0', () => {
    const rt = new FakeRuntime()
    expect(rt.budget.spent()).toBe(0)
  })

  it('agent() never throws on budget when total is null', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    await expect(rt.agent('fine')).resolves.toBe('ok')
  })

  it('spent() accumulates by agentTokenCost per call', async () => {
    const rt = new FakeRuntime({ responses: ['a', 'b'], budgetTotal: 1000, agentTokenCost: 100 })
    await rt.agent('first')
    expect(rt.budget.spent()).toBe(100)
    await rt.agent('second')
    expect(rt.budget.spent()).toBe(200)
  })

  it('remaining() decreases as spent() increases', async () => {
    const rt = new FakeRuntime({ responses: ['a'], budgetTotal: 500, agentTokenCost: 200 })
    await rt.agent('call')
    expect(rt.budget.remaining()).toBe(300)
  })

  it('agent() throws once spent >= total at call time', async () => {
    // budgetTotal = 100, cost = 100 → first call exhausts budget; second throws
    const rt = new FakeRuntime({ responses: ['ok', 'never'], budgetTotal: 100, agentTokenCost: 100 })
    await rt.agent('first')
    await expect(rt.agent('second')).rejects.toThrow(/budget/)
  })

  it('budget error message is actionable', async () => {
    const rt = new FakeRuntime({ responses: ['ok', 'never'], budgetTotal: 100, agentTokenCost: 100 })
    await rt.agent('first')
    await expect(rt.agent('second')).rejects.toThrow(/WorkflowBudgetExceededError/)
  })
})

// ---------------------------------------------------------------------------
// 10. workflow() — scripted child invoked; unknown name throws
// ---------------------------------------------------------------------------
describe('FakeRuntime workflow()', () => {
  it('invokes the scripted child workflow with args and returns result', async () => {
    const rt = new FakeRuntime({
      workflows: {
        'child-flow': (args) => ({ processed: args }),
      },
    })
    const result = await rt.workflow('child-flow', { input: 42 })
    expect(result).toEqual({ processed: { input: 42 } })
  })

  it('supports async child workflows', async () => {
    const rt = new FakeRuntime({
      workflows: {
        'async-flow': async (args) => {
          await Promise.resolve()
          return `done: ${JSON.stringify(args)}`
        },
      },
    })
    const result = await rt.workflow('async-flow', 'hello')
    expect(result).toBe('done: "hello"')
  })

  it('throws for an unknown workflow name', async () => {
    const rt = new FakeRuntime({ workflows: { 'known': () => 'ok' } })
    await expect(rt.workflow('unknown-flow')).rejects.toThrow(/unknown-flow/)
  })

  it('throws for an unknown name when no workflows are scripted', async () => {
    const rt = new FakeRuntime()
    await expect(rt.workflow('anything')).rejects.toThrow(/anything/)
  })
})

// ---------------------------------------------------------------------------
// 11. Logs recorded in order
// ---------------------------------------------------------------------------
describe('FakeRuntime log recording', () => {
  it('records log messages in order', () => {
    const rt = new FakeRuntime()
    rt.log('first')
    rt.log('second')
    rt.log('third')
    expect(rt.logs).toEqual(['first', 'second', 'third'])
  })

  it('starts with an empty logs array', () => {
    const rt = new FakeRuntime()
    expect(rt.logs).toEqual([])
  })
})
