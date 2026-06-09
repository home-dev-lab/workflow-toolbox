// replay.test.ts — proves the emitted artifact runs correctly.
//
// Strategy: use BundleResult.parts to build an AsyncFunction that mirrors
// what the Claude Code sandbox does — it executes the IIFE body plus glue
// with the rt globals bound as parameters, then returns the workflow result.
//
// The meta statement is stripped by construction (we use parts.iife + parts.glue
// only). top-level `return` is legal inside a function body.
//
// The real sandbox delivers args as a JSON-encoded string, e.g. '"world"' for
// the string "world". normalizeArgs inside defineWorkflow decodes it.

import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeRuntime } from '@dwt/runtime'
import { bundleWorkflow, SANDBOX_GLOBAL_NAMES } from '../src/bundle.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(__dirname, 'fixtures')

/** Build an AsyncFunction from the iife+glue parts, binding rt methods and args. */
function buildReplayFn(
  iife: string,
  glue: string,
): (...args: unknown[]) => Promise<unknown> {
  // AsyncFunction constructor: last arg is body, preceding args are parameter names.
  // SANDBOX_GLOBAL_NAMES names + 'args' are the free variables inside the glue.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...params: unknown[]) => Promise<unknown>
  return new AsyncFunction(...SANDBOX_GLOBAL_NAMES, 'args', iife + glue)
}

// ---------------------------------------------------------------------------
// hello fixture replay
// ---------------------------------------------------------------------------

describe('replay — hello fixture', () => {
  it('runs successfully and returns greeting with decoded arg', async () => {
    const rt = new FakeRuntime({ responses: ['Hello, world!'] })
    const result = await bundleWorkflow({
      entry: path.join(FIXTURES, 'hello.workflow.ts'),
    })
    const { iife, glue } = result.parts
    const fn = buildReplayFn(iife, glue)

    // Invoke with rt methods spread across SANDBOX_GLOBAL_NAMES params + JSON-encoded arg
    const output = await fn(
      rt.agent,
      rt.parallel,
      rt.pipeline,
      rt.phase.bind(rt),
      rt.log.bind(rt),
      rt.budget,
      rt.workflow,
      '"world"', // JSON-encoded string — mirrors the real runtime delivery
    )

    const typedOutput = output as { greeting: string | null }
    expect(typedOutput).toBeDefined()
    // The workflow calls rt.agent('say hello to world') — arg must have been decoded
    expect(rt.calls[0]?.prompt).toBe('say hello to world')
    expect(rt.calls[0]?.opts?.label).toBe('hello')
    // Result greeting is whatever the FakeRuntime returned
    expect(typedOutput.greeting).toBe('Hello, world!')
  })

  it('FakeRuntime recorded the agent call with label hello', async () => {
    const rt = new FakeRuntime({ responses: ['Hi!'] })
    const result = await bundleWorkflow({
      entry: path.join(FIXTURES, 'hello.workflow.ts'),
    })
    const fn = buildReplayFn(result.parts.iife, result.parts.glue)

    await fn(
      rt.agent,
      rt.parallel,
      rt.pipeline,
      rt.phase.bind(rt),
      rt.log.bind(rt),
      rt.budget,
      rt.workflow,
      '"test-input"',
    )

    expect(rt.calls).toHaveLength(1)
    expect(rt.calls[0]?.opts?.label).toBe('hello')
  })

  it('prompt contains the decoded (not JSON-encoded) arg', async () => {
    const rt = new FakeRuntime({ responses: ['response'] })
    const result = await bundleWorkflow({
      entry: path.join(FIXTURES, 'hello.workflow.ts'),
    })
    const fn = buildReplayFn(result.parts.iife, result.parts.glue)

    await fn(
      rt.agent,
      rt.parallel,
      rt.pipeline,
      rt.phase.bind(rt),
      rt.log.bind(rt),
      rt.budget,
      rt.workflow,
      '"alice"',
    )

    // prompt must contain 'alice' not '"alice"' — proves normalizeArgs ran
    expect(rt.calls[0]?.prompt).toContain('alice')
    expect(rt.calls[0]?.prompt).not.toContain('"alice"')
  })
})

// ---------------------------------------------------------------------------
// with-pattern fixture replay
// ---------------------------------------------------------------------------

describe('replay — with-pattern fixture', () => {
  it('runs successfully and returns a pattern envelope shape', async () => {
    // fanOutAndSynthesize with 2 tasks: 2 fan-out agent calls + 1 synthesis = 3 total
    const rt = new FakeRuntime({
      onAgent: async ({ prompt }) => `processed: ${prompt}`,
    })
    const result = await bundleWorkflow({
      entry: path.join(FIXTURES, 'with-pattern.workflow.ts'),
    })
    const fn = buildReplayFn(result.parts.iife, result.parts.glue)

    // Pass a JSON-encoded array of tasks
    const output = await fn(
      rt.agent,
      rt.parallel,
      rt.pipeline,
      rt.phase.bind(rt),
      rt.log.bind(rt),
      rt.budget,
      rt.workflow,
      JSON.stringify(['task-a', 'task-b']),
    )

    // fanOutAndSynthesize returns a PatternResult envelope { value, stats, warnings }
    const typedOutput = output as { value: unknown; stats: unknown; warnings: unknown[] }
    expect(typedOutput).toHaveProperty('value')
    expect(typedOutput).toHaveProperty('stats')
    expect(Array.isArray(typedOutput.warnings)).toBe(true)
  })

  it('FakeRuntime recorded at least one agent call (fan-out + synthesis)', async () => {
    // With 1 task: 1 fan-out call + 1 synthesis call = 2 total
    const rt = new FakeRuntime({
      onAgent: async () => 'done',
    })
    const result = await bundleWorkflow({
      entry: path.join(FIXTURES, 'with-pattern.workflow.ts'),
    })
    const fn = buildReplayFn(result.parts.iife, result.parts.glue)

    await fn(
      rt.agent,
      rt.parallel,
      rt.pipeline,
      rt.phase.bind(rt),
      rt.log.bind(rt),
      rt.budget,
      rt.workflow,
      JSON.stringify(['item-1']),
    )

    // 1 task → 1 fan-out + 1 synthesis = 2 agent calls
    expect(rt.calls.length).toBeGreaterThanOrEqual(1)
  })
})
