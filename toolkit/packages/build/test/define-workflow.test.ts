// define-workflow.test.ts — unit tests for defineWorkflow (RED → GREEN)
//
// defineWorkflow is the entry-point function that workflow authors call to
// declare a workflow. It validates meta at call time and wires the run pipeline:
//   normalizeArgs(rawArgs) → parseInput (default: identity) → def.run(rt, input)

import { describe, it, expect } from 'vitest'
import { FakeRuntime, parsePromptTag, type WorkflowRuntime } from '@workflow-toolbox/runtime'
import { defineWorkflow } from '../src/define-workflow.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidMeta(overrides?: Partial<{ name: string; description: string }>) {
  return {
    name: 'my-workflow',
    description: 'Does something useful',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Meta validation — throws synchronously at defineWorkflow() call time
// ---------------------------------------------------------------------------

describe('defineWorkflow — meta validation', () => {
  it('throws for an empty name', () => {
    expect(() =>
      defineWorkflow({
        meta: makeValidMeta({ name: '' }),
        run: async () => 'ok',
      }),
    ).toThrow()
  })

  it('throws for a name with uppercase letters (not kebab-case)', () => {
    expect(() =>
      defineWorkflow({
        meta: makeValidMeta({ name: 'My Workflow' }),
        run: async () => 'ok',
      }),
    ).toThrow(/kebab/i)
  })

  it('throws for a name with underscores', () => {
    expect(() =>
      defineWorkflow({
        meta: makeValidMeta({ name: 'my_workflow' }),
        run: async () => 'ok',
      }),
    ).toThrow()
  })

  it('throws for a name with spaces (not kebab-case)', () => {
    expect(() =>
      defineWorkflow({
        meta: makeValidMeta({ name: 'bad name here' }),
        run: async () => 'ok',
      }),
    ).toThrow()
  })

  it('throws with an actionable message describing valid kebab-case', () => {
    let caught: Error | undefined
    try {
      defineWorkflow({
        meta: makeValidMeta({ name: 'Bad Name!' }),
        run: async () => 'ok',
      })
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    // Message must tell the author what is acceptable
    expect(caught?.message).toMatch(/[a-z]/)
  })

  it('throws for an empty description', () => {
    expect(() =>
      defineWorkflow({
        meta: makeValidMeta({ description: '' }),
        run: async () => 'ok',
      }),
    ).toThrow(/description/i)
  })

  it('accepts a valid single-segment name', () => {
    expect(() =>
      defineWorkflow({
        meta: makeValidMeta({ name: 'workflow' }),
        run: async () => 'ok',
      }),
    ).not.toThrow()
  })

  it('accepts a valid multi-segment kebab-case name', () => {
    expect(() =>
      defineWorkflow({
        meta: makeValidMeta({ name: 'my-great-workflow' }),
        run: async () => 'ok',
      }),
    ).not.toThrow()
  })

  it('accepts names with digits in segments', () => {
    expect(() =>
      defineWorkflow({
        meta: makeValidMeta({ name: 'workflow-v2' }),
        run: async () => 'ok',
      }),
    ).not.toThrow()
  })

  it('throws when a phase has an empty title', () => {
    expect(() =>
      defineWorkflow({
        meta: {
          name: 'ok-workflow',
          description: 'Fine',
          phases: [{ title: '' }],
        },
        run: async () => 'ok',
      }),
    ).toThrow(/title/i)
  })

  it('accepts phases where every phase has a non-empty title', () => {
    expect(() =>
      defineWorkflow({
        meta: {
          name: 'ok-workflow',
          description: 'Fine',
          phases: [{ title: 'Phase 1' }, { title: 'Phase 2', detail: 'details' }],
        },
        run: async () => 'ok',
      }),
    ).not.toThrow()
  })

  it('accepts phases with optional model field', () => {
    expect(() =>
      defineWorkflow({
        meta: {
          name: 'ok-workflow',
          description: 'Fine',
          phases: [{ title: 'Step', model: 'haiku' }],
        },
        run: async () => 'ok',
      }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Return value shape
// ---------------------------------------------------------------------------

describe('defineWorkflow — return value', () => {
  it('returns an object with meta and run', () => {
    const meta = makeValidMeta()
    const def = defineWorkflow({ meta, run: async () => 'ok' })
    expect(def).toHaveProperty('meta')
    expect(def).toHaveProperty('run')
    expect(typeof def.run).toBe('function')
  })

  it('passes meta through unchanged', () => {
    const meta = makeValidMeta()
    const def = defineWorkflow({ meta, run: async () => 'ok' })
    expect(def.meta).toBe(meta)
  })

  it('includes optional whenToUse in meta when provided', () => {
    const meta = { ...makeValidMeta(), whenToUse: 'When you need X' }
    const def = defineWorkflow({ meta, run: async () => 'ok' })
    expect(def.meta.whenToUse).toBe('When you need X')
  })
})

// ---------------------------------------------------------------------------
// run() — argument normalization, parseInput, and def.run wiring
// ---------------------------------------------------------------------------

describe('defineWorkflow — run() pipeline', () => {
  it('passes a prompt-tagging wrapper of rt to def.run (shared members by reference)', async () => {
    const rt = new FakeRuntime()
    let receivedRt: WorkflowRuntime | undefined
    const def = defineWorkflow({
      meta: makeValidMeta(),
      run: async (r) => { receivedRt = r; return 'done' },
    })
    await def.run(rt, undefined)
    // rt is wrapped (withPromptTags), not passed by identity — but the
    // pass-through members are the source rt's own.
    expect(receivedRt).not.toBe(rt)
    expect(receivedRt!.parallel).toBe(rt.parallel)
    expect(receivedRt!.pipeline).toBe(rt.pipeline)
    expect(receivedRt!.budget).toBe(rt.budget)
  })

  it('normalizes JSON-encoded string rawArgs before calling def.run', async () => {
    const rt = new FakeRuntime()
    let receivedInput: unknown
    const def = defineWorkflow({
      meta: makeValidMeta(),
      run: async (_r, input) => { receivedInput = input; return 'done' },
    })
    await def.run(rt, '"hello"')
    expect(receivedInput).toBe('hello')
  })

  it('passes normalized value through parseInput', async () => {
    const rt = new FakeRuntime()
    let receivedInput: unknown
    const def = defineWorkflow({
      meta: makeValidMeta(),
      parseInput: (raw) => ({ value: raw }),
      run: async (_r, input) => { receivedInput = input; return 'done' },
    })
    await def.run(rt, '42')
    expect(receivedInput).toEqual({ value: 42 })
  })

  it('default parseInput is identity (no parseInput provided)', async () => {
    const rt = new FakeRuntime()
    let receivedInput: unknown
    const def = defineWorkflow({
      meta: makeValidMeta(),
      run: async (_r, input) => { receivedInput = input; return 'done' },
    })
    await def.run(rt, '{"key":"value"}')
    expect(receivedInput).toEqual({ key: 'value' })
  })

  it('propagates parseInput throw without wrapping', async () => {
    const rt = new FakeRuntime()
    const parseError = new Error('invalid input schema')
    const def = defineWorkflow({
      meta: makeValidMeta(),
      parseInput: () => { throw parseError },
      run: async () => 'never',
    })
    await expect(def.run(rt, 'anything')).rejects.toBe(parseError)
  })

  it('returns the value produced by def.run', async () => {
    const rt = new FakeRuntime()
    const def = defineWorkflow({
      meta: makeValidMeta(),
      run: async () => ({ result: 42 }),
    })
    const out = await def.run(rt, undefined)
    expect(out).toEqual({ result: 42 })
  })

  it('passes undefined rawArgs through normalizeArgs (stays undefined)', async () => {
    const rt = new FakeRuntime()
    let receivedInput: unknown = 'initial'
    const def = defineWorkflow({
      meta: makeValidMeta(),
      run: async (_r, input) => { receivedInput = input; return null },
    })
    await def.run(rt, undefined)
    expect(receivedInput).toBeUndefined()
  })

  it('def.run receives a plain object rawArgs passed through by reference when no parseInput', async () => {
    const rt = new FakeRuntime()
    const obj = { foo: 'bar' }
    let receivedInput: unknown
    const def = defineWorkflow({
      meta: makeValidMeta(),
      run: async (_r, input) => { receivedInput = input; return null },
    })
    await def.run(rt, obj)
    // Object is not a string so normalizeArgs returns it by reference
    expect(receivedInput).toBe(obj)
  })
})

// ---------------------------------------------------------------------------
// Type-level: TOut flows through (compile-time check via typed assertion)
// ---------------------------------------------------------------------------

describe('defineWorkflow — typed return', () => {
  it('resolves to the declared TOut type', async () => {
    const rt = new FakeRuntime()
    const def = defineWorkflow<unknown, number>({
      meta: makeValidMeta(),
      run: async () => 99,
    })
    const result: number = await def.run(rt, undefined)
    expect(result).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// FakeRuntime onAgent wiring (confirms rt is fully functional in the pipeline)
// ---------------------------------------------------------------------------

describe('defineWorkflow — integration with FakeRuntime', () => {
  it('def.run can call rt.agent and the call is recorded (labeled → prompt is tagged)', async () => {
    const rt = new FakeRuntime({
      onAgent: ({ index }) => `response-${index}`,
    })
    const def = defineWorkflow({
      meta: makeValidMeta(),
      run: async (r) => r.agent('my prompt', { label: 'test-agent' }),
    })
    const result = await def.run(rt, undefined)
    expect(result).toBe('response-1')
    expect(rt.calls).toHaveLength(1)
    expect(rt.calls[0]?.prompt.endsWith('my prompt')).toBe(true)
    expect(rt.calls[0]?.index).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Prompt tagging — defineWorkflow wraps rt with withPromptTags, so every
// labeled/phased agent call carries the observe-facing wt-meta marker line.
// ---------------------------------------------------------------------------

describe('defineWorkflow — prompt tagging', () => {
  it('tags agent prompts with label + phase from opts', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    const def = defineWorkflow({
      meta: makeValidMeta(),
      run: async (r) => r.agent('do it', { label: 'gen:0', phase: 'Generate' }),
    })
    await def.run(rt, undefined)
    expect(parsePromptTag(rt.calls[0]!.prompt)).toEqual({ label: 'gen:0', phase: 'Generate' })
    expect(rt.calls[0]!.prompt.endsWith('do it')).toBe(true)
  })

  it('tags with the current rt.phase() title when opts.phase is absent', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    const def = defineWorkflow({
      meta: makeValidMeta(),
      run: async (r) => {
        r.phase('Refine')
        return r.agent('iterate', { label: 'iter:0' })
      },
    })
    await def.run(rt, undefined)
    expect(parsePromptTag(rt.calls[0]!.prompt)).toEqual({ label: 'iter:0', phase: 'Refine' })
    expect(rt.phases).toContain('Refine')
  })

  it('leaves unlabeled, phaseless prompts untouched', async () => {
    const rt = new FakeRuntime({ responses: ['ok'] })
    const def = defineWorkflow({
      meta: makeValidMeta(),
      run: async (r) => r.agent('bare'),
    })
    await def.run(rt, undefined)
    expect(rt.calls[0]!.prompt).toBe('bare')
  })
})
