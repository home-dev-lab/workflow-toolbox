// demo-showcase-v2.test.ts — offline checks for the all-nine-patterns nested
// showcase fixture. The load-bearing assertion is the MANDATORY model knob:
// args.perAgent.model must be honored by EVERY agent() call (ground-truthed on
// the recorded calls), including adversarialVerification which pins BEST_MODEL by
// default. Also asserts metadata, the 11-phase spine, and no-throw completion.

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import wf from '../demo-showcase-v2.workflow.js'

// A permissive handler: returns a shape rich enough that no pattern THROWS (they
// degrade on a mismatch, never throw). Routed lightly on prompt content.
function makeRuntime(): FakeRuntime {
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt.toLowerCase()
      if (p.includes('classify')) return { category: 'playful' }
      if (p.includes('approve')) return { approve: true, reason: 'demo' }
      if (p.includes('score')) return { score: 3, reason: 'demo' }
      if (p.includes('plan') && p.includes('split')) return { subtasks: [{ description: 'step a' }, { description: 'step b' }] }
      if (p.includes('keep this')) return { pass: true }
      return 'one short demo line'
    },
  })
}

describe('demo-showcase-v2 metadata', () => {
  it('has the expected name and the 11-phase spine in execution order', () => {
    expect(wf.meta.name).toBe('demo-showcase-v2')
    expect(wf.meta.description).toBeTruthy()
    const titles = wf.meta.phases?.map((ph) => ph.title)
    expect(titles).toEqual([
      'Route', 'Gate', 'Fan', 'Compete', 'Generate', 'Chunk', 'Verify',
      'Refine-Inner', 'Plan', 'Refine-Outer', 'Triage',
    ])
  })
})

describe('demo-showcase-v2 parseInput', () => {
  it('parses args.perAgent and tolerates missing/empty args', async () => {
    const rt = makeRuntime()
    // No args → runs on the haiku default without throwing.
    const out = await wf.run(rt, JSON.stringify({}))
    expect(out.marker).toBe('DEMO_SHOWCASE_V2_OK')
  })

  it('rejects an unknown perAgent key (parseConfig strictness)', async () => {
    const rt = makeRuntime()
    await expect(wf.run(rt, JSON.stringify({ perAgent: { bogus: 1 } }))).rejects.toThrow(/perAgent/)
  })
})

describe('demo-showcase-v2 — MANDATORY model knob honored by every agent()', () => {
  it('defaults every agent to haiku when no perAgent is given', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify({}))
    expect(rt.calls.length).toBeGreaterThan(0)
    expect(rt.calls.every((c) => c.opts?.model === 'haiku')).toBe(true)
  })

  it('honors args.perAgent.model on EVERY agent call (adversarialVerification included)', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify({ perAgent: { model: 'opus' } }))
    expect(rt.calls.length).toBeGreaterThan(0)
    // The whole point of the fixture: not a single agent escapes the knob.
    expect(rt.calls.every((c) => c.opts?.model === 'opus')).toBe(true)
    // adversarialVerification runs in the Verify phase — prove at least one of its
    // verifier calls (which pin BEST_MODEL by default) got the knob's model.
    const verifyCalls = rt.calls.filter((c) => c.phase === 'Verify')
    expect(verifyCalls.length).toBeGreaterThan(0)
    expect(verifyCalls.every((c) => c.opts?.model === 'opus')).toBe(true)
  })

  it('keeps the whole run on low effort by default (cheap fixture)', async () => {
    const rt = makeRuntime()
    await wf.run(rt, JSON.stringify({}))
    expect(rt.calls.every((c) => c.opts?.effort === 'low')).toBe(true)
  })
})

describe('demo-showcase-v2 — three nesting levels all execute', () => {
  it('fires all 11 phases and returns the marker + a populated trail', async () => {
    const rt = makeRuntime()
    const out = await wf.run(rt, JSON.stringify({ perAgent: { model: 'haiku' } }))

    expect(out.marker).toBe('DEMO_SHOWCASE_V2_OK')
    for (const phase of ['Route', 'Gate', 'Fan', 'Compete', 'Generate', 'Chunk', 'Verify', 'Refine-Inner', 'Plan', 'Refine-Outer', 'Triage']) {
      expect(rt.phases).toContain(phase)
    }
    // The trail concatenates every level's pattern trails — non-trivial.
    expect(out.envelope.trail.length).toBeGreaterThan(10)
    expect(out.approved).toBe(true)
  })
})
