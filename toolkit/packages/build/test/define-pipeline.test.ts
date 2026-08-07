// define-pipeline.test.ts — unit tests for definePipeline (RED → GREEN), modeled on
// define-workflow.test.ts's structure.
//
// definePipeline is the entry-point function a PIPELINE author calls to declare an
// orchestrator pipeline (an N-stage, human-gateable PipelineSpec — see docs/public/adr/0008
// for the "orchestrator pipeline" vs "in-run pipeline pattern" vocabulary). It validates the
// spec at call time via validateStageList (stage-list SHAPE) PLUS a parsePipelineSpec
// round-trip (batch 5, item 5 — every FIELD's type, not just the stage list) — the SAME two
// checks the observe-ui runner and bundlePipeline apply, so a malformed spec fails at author
// time, not at launch time.

import { describe, it, expect } from 'vitest'
import { definePipeline } from '../src/define-pipeline.js'
import type { PipelineSpec } from '@workflow-toolbox/pipeline-spec'

function validSpec(overrides?: Partial<PipelineSpec>): PipelineSpec {
  return {
    goal: 'do something useful',
    projectDir: '/repo',
    stages: [{ name: 'a', workflow: 'a.js' }],
    ...overrides,
  }
}

describe('definePipeline — spec validation (throws synchronously at call time)', () => {
  it('throws for an empty stage list', () => {
    expect(() => definePipeline(validSpec({ stages: [] }))).toThrow(/at least one stage/)
  })

  it('throws for a stage with none of "workflow", "pipeline", "scripted"', () => {
    expect(() => definePipeline(validSpec({ stages: [{ name: 'a' } as PipelineSpec['stages'][number]] }))).toThrow(
      /exactly one of "workflow", "pipeline", or "scripted"/,
    )
  })

  it('throws for a duplicate stage name', () => {
    expect(() =>
      definePipeline(validSpec({ stages: [{ name: 'a', workflow: 'a.js' }, { name: 'a', workflow: 'b.js' }] })),
    ).toThrow(/duplicate stage name/)
  })

  it('throws for gateAfter:true on the LAST stage', () => {
    expect(() => definePipeline(validSpec({ stages: [{ name: 'a', workflow: 'a.js', gateAfter: true }] }))).toThrow(
      /LAST stage/,
    )
  })

  it('throws for gateAfter:true on a pipeline-stage', () => {
    const nested: PipelineSpec = { goal: 'child', projectDir: '/repo', stages: [{ name: 'x', workflow: 'x.js' }] }
    expect(() =>
      definePipeline(validSpec({ stages: [{ name: 'a', pipeline: nested, gateAfter: true }, { name: 'b', workflow: 'b.js' }] })),
    ).toThrow(/disallowed in v1/)
  })

  it('throws with an actionable "definePipeline:" prefix so the author knows which call failed', () => {
    let caught: Error | undefined
    try {
      definePipeline(validSpec({ stages: [] }))
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    expect(caught?.message).toMatch(/^definePipeline:/)
  })

  it('accepts a valid single-stage spec', () => {
    expect(() => definePipeline(validSpec())).not.toThrow()
  })

  it('accepts a valid multi-stage spec with a gate', () => {
    expect(() =>
      definePipeline(validSpec({ stages: [{ name: 'a', workflow: 'a.js', gateAfter: true }, { name: 'b', workflow: 'b.js' }] })),
    ).not.toThrow()
  })

  it('accepts a valid nested pipeline-stage', () => {
    const nested: PipelineSpec = { goal: 'child', projectDir: '/repo', stages: [{ name: 'x', workflow: 'x.js' }] }
    expect(() => definePipeline(validSpec({ stages: [{ name: 'a', pipeline: nested }] }))).not.toThrow()
  })
})

describe('definePipeline — return value', () => {
  // batch 5 item 5: definePipeline now ALSO round-trips the spec through parsePipelineSpec
  // (the SAME check bundlePipeline's own Step 3 applies) — but that round-trip is VALIDATION
  // only, same posture as bundlePipeline's own: the returned spec stays the ORIGINAL argument
  // by reference (preserves the author's own key order in the emitted JSON; bundlePipeline
  // builds its `json` from the raw value it reads too, never from its own round-tripped copy).
  it('returns an object wrapping the spec, unchanged (same reference — the round-trip is validation-only)', () => {
    const spec = validSpec()
    const def = definePipeline(spec)
    expect(def).toHaveProperty('spec')
    expect(def.spec).toBe(spec)
  })
})

// card #1817782716268020812: definePipeline now funnels through validatePipelineSpec (the
// additive full-spec entry point: validateStageList + the loop rules) instead of a bare
// validateStageList — so a bad `loop` fails with the READABLE loop rule at the author's own
// call site, not as a generic parsePipelineSpec round-trip mismatch further down.
describe('definePipeline — loop validation (validatePipelineSpec switch)', () => {
  it('accepts a valid looped spec (gate flavor) and returns the same reference', () => {
    const spec = validSpec({ loop: { until: { gate: true }, maxIterations: 3 } })
    expect(definePipeline(spec).spec).toBe(spec)
  })

  it('accepts a valid criterion loop within the expanded budget', () => {
    const spec = validSpec({ loop: { until: { criterion: 'artifact-empty' }, maxIterations: 2 } })
    expect(() => definePipeline(spec)).not.toThrow()
  })

  it('throws the READABLE maxIterations rule for a bad ceiling — not the generic round-trip message', () => {
    const bad = validSpec({ loop: { until: { gate: true }, maxIterations: 0 } })
    let message = ''
    try {
      definePipeline(bad)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/maxIterations/)
    expect(message).not.toMatch(/round-trip/)
  })

  it('throws the READABLE budget rule for an ungated criterion loop over MAX_STAGES', () => {
    const stages = [
      { name: 'a', workflow: 'a.js' },
      { name: 'b', workflow: 'b.js' },
      { name: 'c', workflow: 'c.js' },
    ]
    const bad = validSpec({ stages, loop: { until: { criterion: 'artifact-empty' }, maxIterations: 5 } })
    expect(() => definePipeline(bad)).toThrow(/MAX_STAGES/)
  })
})

// batch 5 item 5: the doc's promise ("an authored spec and a live-launched spec are validated
// by the exact same rules") used to be FALSE — validateStageList alone never checks goal/
// projectDir's types, so a spec that bypassed TypeScript via a cast passed definePipeline()
// silently and was only caught later, inside bundlePipeline's own round-trip. Fixed by making
// definePipeline() run that SAME round-trip itself, so the doc's claim is now literally true.
describe('definePipeline — parsePipelineSpec round-trip (batch 5, item 5 — the doc-vs-code gap)', () => {
  it('throws when a field bypasses TypeScript via a cast with a value parsePipelineSpec rejects', () => {
    const bad = { goal: 42, projectDir: '/repo', stages: [{ name: 'a', workflow: 'a.js' }] } as unknown as PipelineSpec
    expect(() => definePipeline(bad)).toThrow(/round-trip/)
  })

  it('the round-trip failure is distinct from a validateStageList failure — validateStageList alone would have PASSED this spec', () => {
    // Confirms this is a NEW check, not validateStageList catching it under a different name:
    // the stage list itself is perfectly well-formed; only `goal`'s type is wrong.
    const bad = { goal: 42, projectDir: '/repo', stages: [{ name: 'a', workflow: 'a.js' }] } as unknown as PipelineSpec
    let message = ''
    try {
      definePipeline(bad)
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).not.toMatch(/at least one stage|exactly one of|duplicate stage name|LAST stage|disallowed in v1/)
    expect(message).toMatch(/round-trip/)
  })

  // pr-review I5, batch 6 test: the "not JSON-serializable" catch (a DIFFERENT failure mode
  // than a round-trip mismatch — JSON.stringify itself throws, e.g. on a circular reference)
  // was untested. A cast is needed since PipelineSpec's own type can never hold a circular
  // value — this is exactly the "bypassed TypeScript" class every other test here targets too.
  it('throws an actionable "not JSON-serializable" error when the spec itself cannot be stringified (a circular reference)', () => {
    const circular: Record<string, unknown> = { name: 'a', workflow: 'a.js' }
    circular['self'] = circular // a stage object referencing itself
    const bad = validSpec({ stages: [circular as unknown as PipelineSpec['stages'][number]] })
    expect(() => definePipeline(bad)).toThrow(/not JSON-serializable/)
  })
})
