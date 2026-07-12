// showcase-stages.test.ts — offline checks for the five demo-showcase-v2 pipeline
// STAGE workflows. The load-bearing assertion: because the PipelineSpec cannot
// inject a per-stage model (InputRef has no config channel), each stage workflow
// honors args.perAgent ITSELF and DEFAULTS to haiku + low effort — so the pipeline
// (which passes no perAgent) is trivially cheap and never inherits a session model,
// and a standalone launch can still retune it. Ground-truthed on the recorded calls.

import { describe, it, expect } from 'vitest'
import { FakeRuntime } from '@workflow-toolbox/runtime'
import routeTriage from '../showcase-route-triage.workflow.js'
import fanCompete from '../showcase-fan-compete.workflow.js'
import deep from '../showcase-deep.workflow.js'
import plan from '../showcase-plan.workflow.js'
import refineOuter from '../showcase-refine-outer.workflow.js'

// A permissive handler: returns a shape rich enough that no pattern THROWS.
function makeRuntime(): FakeRuntime {
  return new FakeRuntime({
    onAgent: ({ prompt }: { prompt: string; index: number }) => {
      const p = prompt.toLowerCase()
      if (p.includes('classify')) return { category: 'playful' }
      if (p.includes('score')) return { score: 3, reason: 'demo' }
      if (p.includes('plan') && p.includes('split')) return { subtasks: [{ description: 'step a' }, { description: 'step b' }] }
      if (p.includes('keep this')) return { pass: true }
      return 'one short demo line'
    },
  })
}

const STAGES = [
  { name: 'showcase-route-triage', wf: routeTriage, phases: ['Route', 'Triage'] },
  { name: 'showcase-fan-compete', wf: fanCompete, phases: ['Fan', 'Compete'] },
  { name: 'showcase-deep', wf: deep, phases: ['Generate', 'Chunk', 'Verify', 'Refine-Inner'] },
  { name: 'showcase-plan', wf: plan, phases: ['Plan'] },
  { name: 'showcase-refine-outer', wf: refineOuter, phases: ['Draft', 'Critique', 'Synthesize'] },
] as const

describe('showcase stages — metadata + phases', () => {
  for (const { name, wf, phases } of STAGES) {
    it(`${name} has the right name and phases`, () => {
      expect(wf.meta.name).toBe(name)
      expect(wf.meta.phases?.map((ph) => ph.title)).toEqual(phases)
    })
  }
})

describe('showcase stages — default to haiku + low with no perAgent (cheap pipeline capture)', () => {
  for (const { name, wf } of STAGES) {
    it(`${name} runs every agent on haiku + low by default`, async () => {
      const rt = makeRuntime()
      await wf.run(rt, JSON.stringify({}))
      expect(rt.calls.length).toBeGreaterThan(0)
      expect(rt.calls.every((c) => c.opts?.model === 'haiku')).toBe(true)
      expect(rt.calls.every((c) => c.opts?.effort === 'low')).toBe(true)
    })
  }
})

describe('showcase stages — honor args.perAgent.model when launched standalone', () => {
  for (const { name, wf } of STAGES) {
    it(`${name} propagates perAgent.model to EVERY agent`, async () => {
      const rt = makeRuntime()
      await wf.run(rt, JSON.stringify({ perAgent: { model: 'opus' } }))
      expect(rt.calls.length).toBeGreaterThan(0)
      // Not a single agent escapes the knob — adversarialVerification (showcase-deep)
      // included, since it pins BEST_MODEL internally unless passed a model.
      expect(rt.calls.every((c) => c.opts?.model === 'opus')).toBe(true)
    })
  }
})
