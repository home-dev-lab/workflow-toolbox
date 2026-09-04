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
      if ((p.includes('plan') || p.includes('break')) && (p.includes('split') || p.includes('independent'))) {
        return { subtasks: [{ description: 'step a' }, { description: 'step b' }] }
      }
      if (p.includes('keep this')) return { pass: true }
      if (p.includes('chunk 1/5')) return 'color theme'
      if (p.includes('chunk 2/5')) return 'font theme'
      if (p.includes('chunk 3/5')) return 'mascot theme'
      if (p.includes('chunk 4/5')) return 'font repeat theme'
      if (p.includes('chunk 5/5')) return 'scary mascot theme'
      if (p.includes("mascot's colors")) return 'colors note'
      if (p.includes("mascot's personality")) return 'personality note'
      if (p.includes("mascot's catchphrase")) return 'catchphrase note'
      if (p.includes('write a bold mascot tagline')) return 'bold tagline'
      if (p.includes('write a whimsical mascot tagline')) return 'whimsical tagline'
      if (p.includes('step 0:')) return 'intro line'
      if (p.includes('step 1:')) return 'close line'
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

describe('showcase stages — synthesis prompts inline their source items', () => {
  it('showcase-deep includes every theme note in the Chunk synthesis prompt', async () => {
    const rt = makeRuntime()
    await deep.run(rt, JSON.stringify({}))

    const prompt = rt.calls.find((c) => c.phase === 'Chunk' && c.opts?.label?.includes('synthesize'))?.prompt
    expect(prompt).toBeTruthy()
    expect(prompt).toContain('color theme')
    expect(prompt).toContain('font theme')
    expect(prompt).toContain('mascot theme')
    expect(prompt).toContain('font repeat theme')
    expect(prompt).toContain('scary mascot theme')
  })

  it('showcase-fan-compete includes every angle note and tagline in synthesis prompts', async () => {
    const rt = makeRuntime()
    await fanCompete.run(rt, JSON.stringify({}))

    const fanPrompt = rt.calls.find((c) => c.phase === 'Fan' && c.opts?.label?.includes('synthesize'))?.prompt
    expect(fanPrompt).toBeTruthy()
    expect(fanPrompt).toContain('colors note')
    expect(fanPrompt).toContain('personality note')
    expect(fanPrompt).toContain('catchphrase note')

    const competePrompt = rt.calls.find((c) => c.phase === 'Compete' && c.opts?.label?.includes('synthesize'))?.prompt
    expect(competePrompt).toBeTruthy()
    expect(competePrompt).toContain('bold tagline')
    expect(competePrompt).toContain('whimsical tagline')
  })

  it('showcase-plan includes every worker line in the Plan synthesis prompt', async () => {
    const rt = makeRuntime()
    await plan.run(rt, JSON.stringify({}))

    const prompt = rt.calls.find((c) => c.phase === 'Plan' && c.opts?.label?.includes('synthesize'))?.prompt
    expect(prompt).toBeTruthy()
    expect(prompt).toContain('intro line')
    expect(prompt).toContain('close line')
  })
})
