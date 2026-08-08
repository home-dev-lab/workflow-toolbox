import { describe, it, expect } from 'vitest'
import {
  INPUT_REF_SOURCES,
  MAX_STAGES,
  MAX_STAGES_CEILING,
  MAX_PIPELINE_DEPTH,
  MAX_PIPELINE_DEPTH_CEILING,
  MAX_LOOP_ITERATIONS,
  MAX_LOOP_ITERATIONS_CEILING,
  MAX_SCRIPTED_STAGE_CALLS,
  SCRIPTED_RESULT_FIELD_TYPES,
  EXTRACTOR_KEYS,
  validateStageList,
  validatePipelineSpec,
  parsePipelineSpec,
  describeScriptedResultShape,
  checkScriptedResult,
  type StageSpecV2,
  type PipelineSpec,
  type PipelineLoopSpec,
  type ScriptedResultShape,
} from '../src/index.js'

// Single source of truth for pipeline-spec authoring/validation, shared verbatim between
// apps/observe-ui/server/pipeline.ts (the runtime orchestrator) and definePipeline()
// (@workflow-toolbox/build). This suite covers the pure logic standalone — the app's own
// pipeline.test.ts/pipeline-manifest.test.ts additionally exercise it through the runner's
// integration surface (start(), POST /api/pipeline), which stays there since it also drives
// launch/gate/manifest behavior this package knows nothing about.

const baseStage = (name: string): StageSpecV2 => ({ name, workflow: `${name}.js` })

describe('constants', () => {
  it('INPUT_REF_SOURCES lists the four recognized sources', () => {
    expect(INPUT_REF_SOURCES).toEqual(['artifactPath', 'goal', 'projectDir', 'artifactContent'])
  })

  it('EXTRACTOR_KEYS lists the two recognized extractor keys', () => {
    expect(EXTRACTOR_KEYS).toEqual(['plan-artifact', 'raw'])
  })

  it('MAX_STAGES and MAX_PIPELINE_DEPTH are the documented caps', () => {
    expect(MAX_STAGES).toBe(12)
    expect(MAX_PIPELINE_DEPTH).toBe(8)
  })

  it('MAX_LOOP_ITERATIONS is the documented loop ceiling', () => {
    expect(MAX_LOOP_ITERATIONS).toBe(10)
  })
})

describe('validateStageList', () => {
  it('accepts a single well-formed stage', () => {
    expect(validateStageList([baseStage('a')])).toBeNull()
  })

  it('rejects an empty stage list', () => {
    expect(validateStageList([])).toMatch(/at least one stage/)
  })

  it(`rejects more than ${MAX_STAGES} stages`, () => {
    const stages = Array.from({ length: MAX_STAGES + 1 }, (_, i) => baseStage(`s${i}`))
    expect(validateStageList(stages)).toMatch(new RegExp(`at most ${MAX_STAGES} stages`))
    expect(validateStageList(stages.slice(0, MAX_STAGES))).toBeNull()
  })

  it('rejects a duplicate stage name', () => {
    expect(validateStageList([baseStage('a'), baseStage('a')])).toMatch(/duplicate stage name/)
  })

  it('rejects a stage with none of "workflow", "pipeline", "scripted"', () => {
    expect(validateStageList([{ name: 'a' } as StageSpecV2])).toMatch(/exactly one of "workflow", "pipeline", or "scripted"/)
    expect(validateStageList([{ name: 'a' } as StageSpecV2])).toMatch(/got none/)
  })

  it('rejects a stage with BOTH "workflow" and "pipeline"', () => {
    const spec: PipelineSpec = { goal: 'g', projectDir: '/repo', stages: [baseStage('x')] }
    expect(validateStageList([{ name: 'a', workflow: 'a.js', pipeline: spec }])).toMatch(/exactly one of "workflow", "pipeline", or "scripted"/)
  })

  it('rejects a stage with BOTH "workflow" and "scripted"', () => {
    expect(
      validateStageList([{ name: 'a', workflow: 'a.js', scripted: { model: 'openai/gpt-5.4', prompt: { from: 'goal' } } }]),
    ).toMatch(/exactly one of "workflow", "pipeline", or "scripted"/)
  })

  it('rejects a stage with ALL THREE of "workflow", "pipeline", "scripted"', () => {
    const spec: PipelineSpec = { goal: 'g', projectDir: '/repo', stages: [baseStage('x')] }
    expect(
      validateStageList([{ name: 'a', workflow: 'a.js', pipeline: spec, scripted: { model: 'm', prompt: { from: 'goal' } } }]),
    ).toMatch(/exactly one of "workflow", "pipeline", or "scripted"/)
  })

  it('accepts a stage with ONLY "scripted" set', () => {
    expect(validateStageList([{ name: 'a', scripted: { model: 'openai/gpt-5.4', prompt: { from: 'goal' } } }])).toBeNull()
  })

  it('rejects "input" set together with "scripted" — the prompt InputRef is the only input a scripted stage takes, an "input" record would be silently unconsulted', () => {
    expect(
      validateStageList([{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' } }, input: { x: { from: 'goal' } } }]),
    ).toMatch(/"input" is disallowed on a scripted stage/)
  })

  // Cross-family review finding (card #1837121171): a caller building a StageSpecV2
  // in-process (definePipeline()'s author-time path, or any direct runner.start() caller)
  // reaches validateStageList WITHOUT ever going through parseScriptedStageSpec's own
  // bound check — so the cap must be enforced HERE too, not only at the untrusted-JSON
  // parse boundary.
  it('rejects scripted.calls past MAX_SCRIPTED_STAGE_CALLS via validateStageList DIRECTLY — the bound is not enforced only by the untrusted-JSON parser', () => {
    expect(
      validateStageList([{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, calls: MAX_SCRIPTED_STAGE_CALLS + 1 } }]),
    ).toMatch(/scripted\.calls=9.*MAX_SCRIPTED_STAGE_CALLS/)
  })

  it('accepts scripted.calls at exactly MAX_SCRIPTED_STAGE_CALLS via validateStageList directly', () => {
    expect(
      validateStageList([{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, calls: MAX_SCRIPTED_STAGE_CALLS } }]),
    ).toBeNull()
  })

  it('rejects scripted.calls:0 and a non-integer via validateStageList directly', () => {
    expect(validateStageList([{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, calls: 0 } }])).not.toBeNull()
    expect(validateStageList([{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, calls: 2.5 } }])).not.toBeNull()
  })

  // Card #1837144459 — distinct-prompt fan: scripted.prompt may be authored as an ARRAY of
  // InputRefs instead of one, each element becoming its own concurrent call. The array's own
  // length IS the call count, so "calls" is disallowed alongside it — two fields that could
  // disagree is exactly what the card's own design-decision section warns against.
  describe('scripted.prompt as an array (distinct-prompt fan, card #1837144459)', () => {
    it('accepts a scripted stage whose "prompt" is an array of 2 InputRefs', () => {
      expect(
        validateStageList([{ name: 'a', scripted: { model: 'm', prompt: [{ from: 'goal' }, { from: 'projectDir' }] } }]),
      ).toBeNull()
    })

    it('accepts a prompt array at exactly MAX_SCRIPTED_STAGE_CALLS elements', () => {
      const prompt = Array.from({ length: MAX_SCRIPTED_STAGE_CALLS }, () => ({ from: 'goal' as const }))
      expect(validateStageList([{ name: 'a', scripted: { model: 'm', prompt } }])).toBeNull()
    })

    it('rejects a prompt array of 0 elements — a stage that issues zero calls is not a stage', () => {
      expect(validateStageList([{ name: 'a', scripted: { model: 'm', prompt: [] } }])).toMatch(
        /scripted\.prompt array length=0.*between 1 and 8/,
      )
    })

    it('rejects a prompt array ONE PAST MAX_SCRIPTED_STAGE_CALLS via validateStageList DIRECTLY', () => {
      const prompt = Array.from({ length: MAX_SCRIPTED_STAGE_CALLS + 1 }, () => ({ from: 'goal' as const }))
      expect(validateStageList([{ name: 'a', scripted: { model: 'm', prompt } }])).toMatch(
        new RegExp(`scripted\\.prompt array length=${MAX_SCRIPTED_STAGE_CALLS + 1}.*MAX_SCRIPTED_STAGE_CALLS`),
      )
    })

    it('rejects "calls" set ALONGSIDE an array "prompt" — the two must not be able to disagree', () => {
      expect(
        validateStageList([{ name: 'a', scripted: { model: 'm', prompt: [{ from: 'goal' }, { from: 'projectDir' }], calls: 2 } }]),
      ).toMatch(/both scripted\.prompt as an array and scripted\.calls set/)
    })
  })

  it('rejects gateAfter:true on the LAST stage (no downstream stage to gate into)', () => {
    expect(validateStageList([{ ...baseStage('a'), gateAfter: true }])).toMatch(/LAST stage.*gateAfter/)
  })

  it('accepts gateAfter:true on a non-last stage', () => {
    expect(validateStageList([{ ...baseStage('a'), gateAfter: true }, baseStage('b')])).toBeNull()
  })

  it('rejects gateAfter:true on a pipeline-stage even when it is NOT the last stage', () => {
    const nested: PipelineSpec = { goal: 'g', projectDir: '/repo', stages: [baseStage('x')] }
    expect(validateStageList([{ name: 'a', pipeline: nested, gateAfter: true }, baseStage('b')])).toMatch(/disallowed in v1/)
  })

  it('rejects ANY artifact config on a pipeline-stage, even {extract:"raw"}', () => {
    const nested: PipelineSpec = { goal: 'g', projectDir: '/repo', stages: [baseStage('x')] }
    expect(validateStageList([{ name: 'a', pipeline: nested, artifact: { extract: 'raw' } }])).toMatch(/"artifact" is disallowed/)
  })

  it('accepts a pipeline-stage with no artifact config at all', () => {
    const nested: PipelineSpec = { goal: 'g', projectDir: '/repo', stages: [baseStage('x')] }
    expect(validateStageList([{ name: 'a', pipeline: nested }])).toBeNull()
  })

  it('recurses into a nested pipeline\'s OWN stage list — rejects a nested empty stage list', () => {
    const nested: PipelineSpec = { goal: 'g', projectDir: '/repo', stages: [] }
    expect(validateStageList([{ name: 'a', pipeline: nested }])).toMatch(/nested pipeline is invalid.*at least one stage/)
  })

  it('recurses into a nested pipeline — rejects a trailing gateAfter on ITS OWN last stage', () => {
    const nested: PipelineSpec = { goal: 'g', projectDir: '/repo', stages: [{ ...baseStage('x'), gateAfter: true }] }
    expect(validateStageList([{ name: 'a', pipeline: nested }])).toMatch(/nested pipeline is invalid.*LAST stage/)
  })

  it('duplicate-name uniqueness is PER-LEVEL — a child stage may share a name with a parent stage', () => {
    const nested: PipelineSpec = { goal: 'g', projectDir: '/repo', stages: [baseStage('a')] }
    expect(validateStageList([{ name: 'a', pipeline: nested }])).toBeNull()
  })

  it(`rejects a spec whose own static nesting exceeds MAX_PIPELINE_DEPTH (${MAX_PIPELINE_DEPTH})`, () => {
    // Build a chain nested `depth` levels deep: nestSpec(0) = 1 flat stage; nestSpec(n) wraps
    // nestSpec(n-1) one level deeper.
    function nestSpec(depth: number): PipelineSpec {
      if (depth === 0) return { goal: 'g', projectDir: '/repo', stages: [baseStage('leaf')] }
      return { goal: 'g', projectDir: '/repo', stages: [{ name: `l${depth}`, pipeline: nestSpec(depth - 1) }] }
    }
    expect(validateStageList(nestSpec(MAX_PIPELINE_DEPTH).stages)).toBeNull()
    expect(validateStageList(nestSpec(MAX_PIPELINE_DEPTH + 1).stages)).toMatch(
      new RegExp(`nests ${MAX_PIPELINE_DEPTH + 1} levels deep.*MAX_PIPELINE_DEPTH \\(${MAX_PIPELINE_DEPTH}\\)`),
    )
  })
})

describe('parsePipelineSpec', () => {
  const base = { goal: 'g', projectDir: '/repo' }

  it('parses a valid minimal spec', () => {
    const parsed = parsePipelineSpec({ ...base, stages: [{ name: 'a', workflow: 'a.js' }] })
    expect(parsed).toEqual({ goal: 'g', projectDir: '/repo', stages: [{ name: 'a', workflow: 'a.js' }] })
  })

  it('returns null for a non-object', () => {
    expect(parsePipelineSpec('nope')).toBeNull()
    expect(parsePipelineSpec(null)).toBeNull()
    expect(parsePipelineSpec(42)).toBeNull()
  })

  it('returns null when "goal" or "projectDir" is missing/wrong-typed', () => {
    expect(parsePipelineSpec({ projectDir: '/repo', stages: [] })).toBeNull()
    expect(parsePipelineSpec({ goal: 1, projectDir: '/repo', stages: [] })).toBeNull()
  })

  it('returns null when "stages" is not an array', () => {
    expect(parsePipelineSpec({ ...base, stages: 'nope' })).toBeNull()
  })

  it('returns null when a stage fails validateStageList (e.g. empty stage list)', () => {
    expect(parsePipelineSpec({ ...base, stages: [] })).toBeNull()
  })

  it(`returns null for more than ${MAX_STAGES} stages`, () => {
    const stages = Array.from({ length: MAX_STAGES + 1 }, (_, i) => ({ name: `s${i}`, workflow: `s${i}.js` }))
    expect(parsePipelineSpec({ ...base, stages })).toBeNull()
    expect(parsePipelineSpec({ ...base, stages: stages.slice(0, MAX_STAGES) })).not.toBeNull()
  })

  it('parses input refs, keeping only recognized "from" sources', () => {
    const parsed = parsePipelineSpec({
      ...base,
      stages: [{ name: 'a', workflow: 'a.js', input: { p: { from: 'artifactPath' } } }],
    })
    expect(parsed?.stages[0]?.input).toEqual({ p: { from: 'artifactPath' } })
  })

  it('rejects an input ref with an unrecognized "from" source', () => {
    expect(
      parsePipelineSpec({ ...base, stages: [{ name: 'a', workflow: 'a.js', input: { p: { from: 'bogus' } } }] }),
    ).toBeNull()
  })

  it('parses an artifact.extract key, rejecting an unrecognized one', () => {
    const ok = parsePipelineSpec({ ...base, stages: [{ name: 'a', workflow: 'a.js', artifact: { extract: 'raw' } }, { name: 'b', workflow: 'b.js' }] })
    expect(ok?.stages[0]?.artifact).toEqual({ extract: 'raw' })
    expect(
      parsePipelineSpec({ ...base, stages: [{ name: 'a', workflow: 'a.js', artifact: { extract: 'bogus' } }, { name: 'b', workflow: 'b.js' }] }),
    ).toBeNull()
  })

  it('parses a valid scripted stage (model + prompt InputRef)', () => {
    const parsed = parsePipelineSpec({
      ...base,
      stages: [{ name: 'a', scripted: { model: 'openai/gpt-5.4', prompt: { from: 'artifactContent' } } }],
    })
    expect(parsed?.stages[0]).toEqual({ name: 'a', scripted: { model: 'openai/gpt-5.4', prompt: { from: 'artifactContent' } } })
  })

  it('a "scripted" stage round-trips alongside "workflow" and "pipeline" stages in the same list', () => {
    const parsed = parsePipelineSpec({
      ...base,
      stages: [
        { name: 'a', workflow: 'a.js', gateAfter: true },
        { name: 'b', scripted: { model: 'openai/gpt-5.4', prompt: { from: 'artifactPath' } } },
        { name: 'c', pipeline: { goal: 'child', projectDir: '/repo', stages: [{ name: 'x', workflow: 'x.js' }] } },
      ],
    })
    expect(parsed?.stages.map((s) => s.name)).toEqual(['a', 'b', 'c'])
    expect(parsed?.stages[1]).toEqual({ name: 'b', scripted: { model: 'openai/gpt-5.4', prompt: { from: 'artifactPath' } } })
  })

  it('rejects a scripted stage missing "model"', () => {
    expect(parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { prompt: { from: 'goal' } } }] })).toBeNull()
  })

  it('rejects a scripted stage with a non-string "model"', () => {
    expect(parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 42, prompt: { from: 'goal' } } }] })).toBeNull()
  })

  it('rejects a scripted stage missing "prompt"', () => {
    expect(parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm' } }] })).toBeNull()
  })

  it('rejects a scripted stage whose "prompt" has an unrecognized "from" source', () => {
    expect(
      parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm', prompt: { from: 'bogus' } } }] }),
    ).toBeNull()
  })

  it('rejects "scripted" that is not an object', () => {
    expect(parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: 'nope' }] })).toBeNull()
  })

  it('a scripted stage with no "calls" round-trips WITHOUT the key at all (byte-identical to a pre-fan-out spec)', () => {
    const parsed = parsePipelineSpec({
      ...base,
      stages: [{ name: 'a', scripted: { model: 'openai/gpt-5.4', prompt: { from: 'goal' } } }],
    })
    expect(parsed?.stages[0]).toEqual({ name: 'a', scripted: { model: 'openai/gpt-5.4', prompt: { from: 'goal' } } })
    expect(Object.keys((parsed?.stages[0] as { scripted: object }).scripted)).toEqual(['model', 'prompt'])
  })

  it('accepts "calls" at the MAX_SCRIPTED_STAGE_CALLS ceiling (8) and round-trips it', () => {
    const parsed = parsePipelineSpec({
      ...base,
      stages: [{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, calls: MAX_SCRIPTED_STAGE_CALLS } }],
    })
    expect(parsed?.stages[0]).toEqual({ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, calls: MAX_SCRIPTED_STAGE_CALLS } })
  })

  it('rejects "calls" ONE PAST the ceiling — never silently clamped', () => {
    expect(
      parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, calls: MAX_SCRIPTED_STAGE_CALLS + 1 } }] }),
    ).toBeNull()
  })

  it('rejects "calls: 0" — a stage that issues zero calls is not a stage', () => {
    expect(parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, calls: 0 } }] })).toBeNull()
  })

  it('rejects a non-integer "calls"', () => {
    expect(parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, calls: 2.5 } }] })).toBeNull()
  })

  it('rejects a non-numeric "calls"', () => {
    expect(parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, calls: '3' } }] })).toBeNull()
  })

  // Card #1837144459 — distinct-prompt fan, parse boundary.
  describe('scripted.prompt as an array (distinct-prompt fan, card #1837144459)', () => {
    it('parses and round-trips a 2-element prompt array, ORDER preserved', () => {
      const parsed = parsePipelineSpec({
        ...base,
        stages: [{ name: 'a', scripted: { model: 'openai/gpt-5.4', prompt: [{ from: 'goal' }, { from: 'artifactContent' }] } }],
      })
      expect(parsed?.stages[0]).toEqual({
        name: 'a',
        scripted: { model: 'openai/gpt-5.4', prompt: [{ from: 'goal' }, { from: 'artifactContent' }] },
      })
    })

    it('accepts a prompt array at exactly MAX_SCRIPTED_STAGE_CALLS elements', () => {
      const prompt = Array.from({ length: MAX_SCRIPTED_STAGE_CALLS }, () => ({ from: 'goal' }))
      expect(parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm', prompt } }] })).not.toBeNull()
    })

    it('rejects a prompt array ONE PAST MAX_SCRIPTED_STAGE_CALLS — never silently truncated', () => {
      const prompt = Array.from({ length: MAX_SCRIPTED_STAGE_CALLS + 1 }, () => ({ from: 'goal' }))
      expect(parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm', prompt } }] })).toBeNull()
    })

    it('rejects an empty prompt array', () => {
      expect(parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm', prompt: [] } }] })).toBeNull()
    })

    it('rejects a prompt array containing one malformed InputRef — all-or-nothing like every other field here', () => {
      expect(
        parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm', prompt: [{ from: 'goal' }, { from: 'bogus' }] } }] }),
      ).toBeNull()
    })

    it('rejects "calls" set ALONGSIDE an array "prompt" at the untrusted-JSON boundary too', () => {
      expect(
        parsePipelineSpec({
          ...base,
          stages: [{ name: 'a', scripted: { model: 'm', prompt: [{ from: 'goal' }, { from: 'projectDir' }], calls: 2 } }],
        }),
      ).toBeNull()
    })
  })

  it('accepts an "artifactContent"-sourced input ref on an ordinary workflow stage too (the source is shared, not scripted-only)', () => {
    const parsed = parsePipelineSpec({
      ...base,
      stages: [{ name: 'a', workflow: 'a.js', input: { text: { from: 'artifactContent' } } }],
    })
    expect(parsed?.stages[0]?.input).toEqual({ text: { from: 'artifactContent' } })
  })

  it('parses a valid nested pipeline-stage', () => {
    const parsed = parsePipelineSpec({
      ...base,
      stages: [{ name: 'a', pipeline: { goal: 'child', projectDir: '/repo', stages: [{ name: 'x', workflow: 'x.js' }] } }],
    })
    expect(parsed?.stages[0]).toMatchObject({ name: 'a', pipeline: { goal: 'child' } })
  })

  it('rejects a stage with a malformed nested pipeline (fails parsePipelineSpec recursively)', () => {
    expect(
      parsePipelineSpec({ ...base, stages: [{ name: 'a', pipeline: { goal: 'child', projectDir: '/repo', stages: [] } }] }),
    ).toBeNull()
  })

  it('rejects gateAfter:true on a pipeline-stage at the parse boundary too (validateStageList runs inside)', () => {
    expect(
      parsePipelineSpec({
        ...base,
        stages: [
          { name: 'a', pipeline: { goal: 'child', projectDir: '/repo', stages: [{ name: 'x', workflow: 'x.js' }] }, gateAfter: true },
          { name: 'b', workflow: 'b.js' },
        ],
      }),
    ).toBeNull()
  })

  it('parses an optional workspaceId, rejecting a wrong-typed one', () => {
    const parsed = parsePipelineSpec({ ...base, stages: [baseStage('a')], workspaceId: 'ws1' })
    expect(parsed?.workspaceId).toBe('ws1')
    expect(parsePipelineSpec({ ...base, stages: [baseStage('a')], workspaceId: 42 })).toBeNull()
  })

  describe('name (card #1813065099577918566 — pattern name, symmetric to a workflow meta.name)', () => {
    it('parses an optional non-empty name', () => {
      const parsed = parsePipelineSpec({ ...base, stages: [baseStage('a')], name: 'feature-review' })
      expect(parsed?.name).toBe('feature-review')
    })

    it('is absent when the spec has no name at all', () => {
      const parsed = parsePipelineSpec({ ...base, stages: [baseStage('a')] })
      expect(parsed?.name).toBeUndefined()
    })

    it('rejects a wrong-typed name', () => {
      expect(parsePipelineSpec({ ...base, stages: [baseStage('a')], name: 42 })).toBeNull()
    })

    it('rejects an empty-string name (would defeat the parent-type fallback chain)', () => {
      expect(parsePipelineSpec({ ...base, stages: [baseStage('a')], name: '' })).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// loop — PipelineLoopSpec (card #1817782716268020812): re-run the owning spec's
// WHOLE stage list until `until` says stop, hard-capped by maxIterations.
// validatePipelineSpec is the ADDITIVE full-spec check (validateStageList's
// signature is shared with the Observatory runner and deliberately unchanged).
// ---------------------------------------------------------------------------

const gateLoop = (maxIterations = 2): PipelineLoopSpec => ({ until: { gate: true }, maxIterations })
const criterionLoop = (maxIterations = 2): PipelineLoopSpec => ({ until: { criterion: 'artifact-empty' }, maxIterations })
const makeSpec = (stages: StageSpecV2[], loop?: PipelineLoopSpec): PipelineSpec => {
  const s: PipelineSpec = { goal: 'g', projectDir: '/repo', stages }
  if (loop !== undefined) s.loop = loop
  return s
}

describe('validatePipelineSpec — stage-list rules (additive wrapper, back-compat lock)', () => {
  it('returns null for a legacy no-loop spec (same acceptance as validateStageList)', () => {
    expect(validatePipelineSpec(makeSpec([baseStage('a')]))).toBeNull()
  })

  it('surfaces validateStageList failures unchanged (empty stage list)', () => {
    expect(validatePipelineSpec(makeSpec([]))).toMatch(/at least one stage/)
  })

  it('still rejects a trailing gateAfter on a LOOPED spec (the loop\'s own until owns the boundary)', () => {
    expect(validatePipelineSpec(makeSpec([{ ...baseStage('a'), gateAfter: true }], gateLoop()))).toMatch(/LAST stage/)
  })
})

describe('validatePipelineSpec — loop.until shape (a loop always names its stop condition)', () => {
  it('accepts { gate: true }', () => {
    expect(validatePipelineSpec(makeSpec([baseStage('a')], gateLoop()))).toBeNull()
  })

  it('accepts { criterion: "<key>" }', () => {
    expect(validatePipelineSpec(makeSpec([baseStage('a')], criterionLoop()))).toBeNull()
  })

  it('rejects a loop with NO until', () => {
    const loop = { maxIterations: 2 } as unknown as PipelineLoopSpec
    expect(validatePipelineSpec(makeSpec([baseStage('a')], loop))).toMatch(/until/)
  })

  it('rejects until:{gate:false} (the union\'s literal is true — false has no meaning)', () => {
    const loop = { until: { gate: false }, maxIterations: 2 } as unknown as PipelineLoopSpec
    expect(validatePipelineSpec(makeSpec([baseStage('a')], loop))).toMatch(/until/)
  })

  it('rejects until with BOTH gate and criterion (exactly one flavor)', () => {
    const loop = { until: { gate: true, criterion: 'artifact-empty' }, maxIterations: 2 } as unknown as PipelineLoopSpec
    expect(validatePipelineSpec(makeSpec([baseStage('a')], loop))).toMatch(/until/)
  })

  it('rejects until with NEITHER gate nor criterion', () => {
    const loop = { until: {}, maxIterations: 2 } as unknown as PipelineLoopSpec
    expect(validatePipelineSpec(makeSpec([baseStage('a')], loop))).toMatch(/until/)
  })

  it('rejects an empty-string criterion', () => {
    const loop = { until: { criterion: '' }, maxIterations: 2 } as unknown as PipelineLoopSpec
    expect(validatePipelineSpec(makeSpec([baseStage('a')], loop))).toMatch(/until/)
  })
})

describe('validatePipelineSpec — maxIterations bounds', () => {
  const withMax = (maxIterations: number) => makeSpec([baseStage('a')], { until: { gate: true }, maxIterations })

  it(`accepts 1 and MAX_LOOP_ITERATIONS (${MAX_LOOP_ITERATIONS})`, () => {
    expect(validatePipelineSpec(withMax(1))).toBeNull()
    expect(validatePipelineSpec(withMax(MAX_LOOP_ITERATIONS))).toBeNull()
  })

  it('rejects 0, negative, NaN, non-integer, and over-cap values', () => {
    for (const bad of [0, -1, Number.NaN, 1.5, MAX_LOOP_ITERATIONS + 1]) {
      expect(validatePipelineSpec(withMax(bad)), `maxIterations=${bad}`).toMatch(/maxIterations/)
    }
  })
})

describe('validatePipelineSpec — ungated-criterion expanded budget (the MAX_STAGES product cap)', () => {
  it('accepts an ungated criterion loop at exactly the budget (3 stages × 4 = 12)', () => {
    expect(validatePipelineSpec(makeSpec(['a', 'b', 'c'].map(baseStage), criterionLoop(4)))).toBeNull()
  })

  it('rejects an ungated criterion loop over the budget (3 stages × 5 = 15 > 12)', () => {
    expect(validatePipelineSpec(makeSpec(['a', 'b', 'c'].map(baseStage), criterionLoop(5)))).toMatch(
      new RegExp(`MAX_STAGES \\(${MAX_STAGES}\\)`),
    )
  })

  it('a gateAfter ANYWHERE in the body exempts the loop from the product cap (ceiling still applies)', () => {
    const stages = [{ ...baseStage('a'), gateAfter: true }, baseStage('b'), baseStage('c')]
    expect(validatePipelineSpec(makeSpec(stages, criterionLoop(MAX_LOOP_ITERATIONS)))).toBeNull()
  })

  it('a nested child loop\'s until:{gate:true} also exempts the parent (a human is reachable)', () => {
    const child = makeSpec([baseStage('x')], gateLoop(2))
    const stages: StageSpecV2[] = [{ name: 'iterate', pipeline: child }, baseStage('b')]
    // The ungated reading would be (1×2 + 1) × 10 = 30 > 12 — only the child's human gate admits it.
    expect(validatePipelineSpec(makeSpec(stages, criterionLoop(MAX_LOOP_ITERATIONS)))).toBeNull()
  })

  it('expandedLaunches multiplies a nested child\'s own loop ceiling (2×3 per pass, × 3 = 18 > 12)', () => {
    const child = makeSpec([baseStage('x'), baseStage('y')], criterionLoop(3)) // child's own budget: 2×3 = 6 ≤ 12
    const stages: StageSpecV2[] = [{ name: 'iterate', pipeline: child }]
    expect(validatePipelineSpec(makeSpec(stages, criterionLoop(3)))).toMatch(new RegExp(`MAX_STAGES \\(${MAX_STAGES}\\)`))
    expect(validatePipelineSpec(makeSpec(stages, criterionLoop(2)))).toBeNull() // 6 × 2 = 12, at the cap
  })

  it('a gate-flavored loop is never product-capped (a human sits at every iteration boundary)', () => {
    const stages = ['a', 'b', 'c', 'd'].map(baseStage)
    expect(validatePipelineSpec(makeSpec(stages, gateLoop(MAX_LOOP_ITERATIONS)))).toBeNull() // 40 launches, all gated
  })
})

describe('validatePipelineSpec — recursion into nested child specs\' loops', () => {
  it('rejects a nested child whose OWN loop is invalid (maxIterations 0), naming the stage', () => {
    const child = makeSpec([baseStage('x')], { until: { gate: true }, maxIterations: 0 })
    const err = validatePipelineSpec(makeSpec([{ name: 'iterate', pipeline: child }]))
    expect(err).toMatch(/stage "iterate"'s nested pipeline is invalid/)
    expect(err).toMatch(/maxIterations/)
  })

  it('accepts a valid loop on a nested child while the ROOT has none (the subsequence idiom)', () => {
    const child = makeSpec([baseStage('x')], gateLoop(3))
    expect(validatePipelineSpec(makeSpec([{ name: 'iterate', pipeline: child }, baseStage('wrap')]))).toBeNull()
  })
})

describe('parsePipelineSpec — loop (parse LOCKSTEP + round-trip)', () => {
  const base = { goal: 'g', projectDir: '/repo' }
  const stagesJson = [{ name: 'a', workflow: 'a.js' }]

  it('round-trips a gate-flavored loop DEEP-EQUAL (the assignment is load-bearing)', () => {
    const loop = { until: { gate: true }, maxIterations: 3 }
    const parsed = parsePipelineSpec({ ...base, stages: stagesJson, loop })
    expect(parsed?.loop).toEqual(loop)
  })

  it('round-trips a criterion-flavored loop DEEP-EQUAL', () => {
    const loop = { until: { criterion: 'artifact-empty' }, maxIterations: 2 }
    const parsed = parsePipelineSpec({ ...base, stages: stagesJson, loop })
    expect(parsed?.loop).toEqual(loop)
  })

  it('omits the loop KEY entirely when absent (exactOptionalPropertyTypes idiom)', () => {
    const parsed = parsePipelineSpec({ ...base, stages: stagesJson })
    expect(parsed).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(parsed!, 'loop')).toBe(false)
  })

  it('rebuilds the loop from whitelisted keys only (extra keys dropped, same posture as parseStageSpecV2)', () => {
    const parsed = parsePipelineSpec({
      ...base,
      stages: stagesJson,
      loop: { until: { gate: true, note: 'extra' }, maxIterations: 2, bogus: 1 },
    })
    expect(parsed?.loop).toEqual({ until: { gate: true }, maxIterations: 2 })
  })

  it('returns null for a malformed loop shape', () => {
    const cases: unknown[] = [
      'nope', // non-object
      { maxIterations: 2 }, // until missing
      { until: 'gate', maxIterations: 2 }, // until non-object
      { until: {}, maxIterations: 2 }, // neither flavor
      { until: { gate: false }, maxIterations: 2 }, // gate:false — the union's literal is true
      { until: { gate: true, criterion: 'artifact-empty' }, maxIterations: 2 }, // both flavors
      { until: { criterion: 42 }, maxIterations: 2 }, // criterion wrong-typed
      { until: { criterion: '' }, maxIterations: 2 }, // criterion empty
      { until: { gate: true } }, // maxIterations missing
      { until: { gate: true }, maxIterations: '3' }, // maxIterations wrong-typed
    ]
    for (const loop of cases) {
      expect(parsePipelineSpec({ ...base, stages: stagesJson, loop }), JSON.stringify(loop)).toBeNull()
    }
  })

  it('returns null for out-of-bounds maxIterations (0 / negative / NaN / non-integer / over-cap)', () => {
    for (const bad of [0, -1, Number.NaN, 1.5, MAX_LOOP_ITERATIONS + 1]) {
      expect(
        parsePipelineSpec({ ...base, stages: stagesJson, loop: { until: { gate: true }, maxIterations: bad } }),
        `maxIterations=${bad}`,
      ).toBeNull()
    }
  })

  it('enforces the ungated-criterion expanded budget at the parse boundary (2 × 7 = 14 > 12)', () => {
    const stages = [{ name: 'a', workflow: 'a.js' }, { name: 'b', workflow: 'b.js' }]
    expect(
      parsePipelineSpec({ ...base, stages, loop: { until: { criterion: 'artifact-empty' }, maxIterations: 7 } }),
    ).toBeNull()
    expect(
      parsePipelineSpec({ ...base, stages, loop: { until: { criterion: 'artifact-empty' }, maxIterations: 6 } }),
    ).not.toBeNull()
  })

  it('a gate-flavored loop over the product is accepted at parse too (the exemption)', () => {
    const stages = [{ name: 'a', workflow: 'a.js' }, { name: 'b', workflow: 'b.js' }]
    expect(
      parsePipelineSpec({ ...base, stages, loop: { until: { gate: true }, maxIterations: MAX_LOOP_ITERATIONS } }),
    ).not.toBeNull()
  })

  it('round-trips a NESTED child spec\'s loop DEEP-EQUAL (the subsequence idiom)', () => {
    const childLoop = { until: { criterion: 'artifact-empty' }, maxIterations: 2 }
    const parsed = parsePipelineSpec({
      ...base,
      stages: [
        {
          name: 'iterate',
          pipeline: { goal: 'child', projectDir: '/repo', stages: [{ name: 'x', workflow: 'x.js' }], loop: childLoop },
        },
        { name: 'wrap', workflow: 'wrap.js' },
      ],
    })
    expect(parsed?.stages[0]?.pipeline?.loop).toEqual(childLoop)
  })

  it('returns null when a NESTED child spec\'s loop is malformed', () => {
    expect(
      parsePipelineSpec({
        ...base,
        stages: [
          {
            name: 'iterate',
            pipeline: {
              goal: 'child',
              projectDir: '/repo',
              stages: [{ name: 'x', workflow: 'x.js' }],
              loop: { until: {}, maxIterations: 2 },
            },
          },
        ],
      }),
    ).toBeNull()
  })

  it('still rejects a trailing gateAfter on a looped spec at the parse boundary', () => {
    expect(
      parsePipelineSpec({
        ...base,
        stages: [{ name: 'a', workflow: 'a.js', gateAfter: true }],
        loop: { until: { gate: true }, maxIterations: 2 },
      }),
    ).toBeNull()
  })
})

describe('PipelineLimits — user-configurable caps', () => {
  it('exports the documented absolute ceilings', () => {
    expect(MAX_STAGES_CEILING).toBe(100)
    expect(MAX_PIPELINE_DEPTH_CEILING).toBe(20)
    expect(MAX_LOOP_ITERATIONS_CEILING).toBe(100)
  })

  it('validateStageList accepts a raised maxStages and rejects the next stage, naming the knob', () => {
    const maxStages = 20
    const stages = Array.from({ length: maxStages + 1 }, (_, i) => baseStage(`s${i}`))
    expect(validateStageList(stages.slice(0, maxStages), { maxStages })).toBeNull()
    expect(validateStageList(stages, { maxStages })).toMatch(/limits\.maxStages/)
  })

  it('rejects maxStages above its absolute ceiling even for a short stage list', () => {
    expect(validateStageList([baseStage('a')], { maxStages: MAX_STAGES_CEILING + 1 })).toMatch(/limits\.maxStages/)
  })

  it('rejects zero, non-integer, and NaN maxStages overrides, naming the knob', () => {
    for (const maxStages of [0, 1.5, Number.NaN]) {
      expect(validateStageList([baseStage('a')], { maxStages }), `maxStages=${maxStages}`).toMatch(/limits\.maxStages/)
    }
  })

  it('keeps the default MAX_STAGES behavior when limits is omitted', () => {
    const stages = Array.from({ length: MAX_STAGES + 1 }, (_, i) => baseStage(`s${i}`))
    expect(validateStageList(stages)).toMatch(new RegExp(`at most ${MAX_STAGES} stages`))
  })

  it('uses each nested pipeline spec\'s own maxStages without inheriting the parent override', () => {
    const raisedChild: PipelineSpec = {
      goal: 'child',
      projectDir: '/repo',
      stages: Array.from({ length: 20 }, (_, i) => baseStage(`child-${i}`)),
      limits: { maxStages: 20 },
    }
    expect(validateStageList([{ name: 'nested', pipeline: raisedChild }])).toBeNull()

    const defaultChild: PipelineSpec = {
      goal: 'child',
      projectDir: '/repo',
      stages: Array.from({ length: MAX_STAGES + 1 }, (_, i) => baseStage(`child-${i}`)),
    }
    expect(validateStageList([{ name: 'nested', pipeline: defaultChild }], { maxStages: 20 })).toMatch(
      /nested pipeline is invalid.*limits\.maxStages/,
    )
  })

  it('validatePipelineSpec honors limits.maxLoopIterations', () => {
    const accepted = makeSpec([baseStage('a')], gateLoop(MAX_LOOP_ITERATIONS + 1))
    accepted.limits = { maxLoopIterations: MAX_LOOP_ITERATIONS + 1 }
    expect(validatePipelineSpec(accepted)).toBeNull()

    const rejected = makeSpec([baseStage('a')], gateLoop(MAX_LOOP_ITERATIONS + 2))
    rejected.limits = { maxLoopIterations: MAX_LOOP_ITERATIONS + 1 }
    expect(validatePipelineSpec(rejected)).toMatch(/limits\.maxLoopIterations/)
  })

  it('validatePipelineSpec uses limits.maxStages for the ungated-criterion product cap', () => {
    const accepted = makeSpec(['a', 'b', 'c'].map(baseStage), criterionLoop(6))
    accepted.limits = { maxStages: 20 }
    expect(validatePipelineSpec(accepted)).toBeNull()

    const rejected = makeSpec(['a', 'b', 'c'].map(baseStage), criterionLoop(7))
    rejected.limits = { maxStages: 20 }
    expect(validatePipelineSpec(rejected)).toMatch(/limits\.maxStages/)
  })

  it('parsePipelineSpec round-trips valid limits and applies them to loop validation', () => {
    const limits = { maxStages: 20, maxPipelineDepth: 10, maxLoopIterations: 20 }
    const parsed = parsePipelineSpec({
      goal: 'g',
      projectDir: '/repo',
      stages: [{ name: 'a', workflow: 'a.js' }],
      loop: { until: { gate: true }, maxIterations: 20 },
      limits,
    })
    expect(parsed?.limits).toEqual(limits)
  })

  it('parsePipelineSpec rejects malformed and over-ceiling limits', () => {
    const base = { goal: 'g', projectDir: '/repo', stages: [{ name: 'a', workflow: 'a.js' }] }
    expect(parsePipelineSpec({ ...base, limits: { maxStages: '20' } })).toBeNull()
    expect(parsePipelineSpec({ ...base, limits: { maxStages: MAX_STAGES_CEILING + 1 } })).toBeNull()
  })

  it('parsePipelineSpec omits the limits key entirely when absent', () => {
    const parsed = parsePipelineSpec({ goal: 'g', projectDir: '/repo', stages: [{ name: 'a', workflow: 'a.js' }] })
    expect(parsed).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(parsed!, 'limits')).toBe(false)
  })

  it('parsePipelineSpec applies a raised maxStages at the untrusted-JSON boundary', () => {
    const maxStages = 20
    const stages = Array.from({ length: maxStages + 1 }, (_, i) => ({ name: `s${i}`, workflow: `s${i}.js` }))
    expect(parsePipelineSpec({ goal: 'g', projectDir: '/repo', stages: stages.slice(0, maxStages), limits: { maxStages } })).not.toBeNull()
    expect(parsePipelineSpec({ goal: 'g', projectDir: '/repo', stages, limits: { maxStages } })).toBeNull()
  })

  // Documented (not fixed — review finding, MED, accepted as a follow-up card rather than a
  // risky same-night algorithm change): maxPipelineDepth is checked TOP-DOWN, so an ANCESTOR's
  // own resolved limit governs the FULL descendant subtree beneath it, checked BEFORE recursion
  // ever reaches a deeper child's own more permissive `limits`. This test locks the ACTUAL
  // behavior (a child's raised limit does NOT rescue depth an ancestor's own default already
  // rejects) so a future change either fixes this deliberately (updating the test) or trips it
  // as a regression, never silently.
  it('a nested child\'s raised maxPipelineDepth does NOT rescue depth the ROOT\'s own default already rejects (known limitation, carded)', () => {
    function nestSpec(depth: number): PipelineSpec {
      if (depth === 0) return { goal: 'g', projectDir: '/repo', stages: [baseStage('leaf')] }
      return { goal: 'g', projectDir: '/repo', stages: [{ name: `l${depth}`, pipeline: nestSpec(depth - 1) }] }
    }
    // Build a 9-deep tree, then give the DEEPEST non-leaf spec (depth 1 — the level whose OWN
    // `stage.pipeline!.limits` the recursive validateStageList call would actually read) a
    // permissive override, well above both the root's default (8) and the actual depth (9).
    const rejected = nestSpec(9)
    let cursor = rejected
    for (let i = 0; i < 8; i++) cursor = (cursor.stages[0] as StageSpecV2).pipeline!
    cursor.limits = { maxPipelineDepth: MAX_PIPELINE_DEPTH_CEILING }
    // If independence held, this would be ACCEPTED (the deepest level explicitly allows up to
    // 20 levels beneath it). It is REJECTED instead: the ROOT's own default (8) is checked
    // against the FULL 9-level subtree, before recursion ever reaches depth 1's own override.
    expect(validateStageList(rejected.stages)).toMatch(/nests 9 levels deep/)
    // Setting the SAME override on the ROOT's own call instead (the documented workaround) DOES
    // work — proving the gap is specifically about WHERE the override is set, not that
    // overriding maxPipelineDepth is broken outright.
    const accepted = nestSpec(9)
    expect(validateStageList(accepted.stages, { maxPipelineDepth: 9 })).toBeNull()
  })
})

// card #1837198164 — structured output from a scripted call.
describe('ScriptedStageSpec.resultShape — parsing', () => {
  const base: PipelineSpec = { goal: 'g', projectDir: '/repo', stages: [] }

  it('SCRIPTED_RESULT_FIELD_TYPES lists the four recognized field types', () => {
    expect(SCRIPTED_RESULT_FIELD_TYPES).toEqual(['string', 'number', 'boolean', 'string[]'])
  })

  it('round-trips a resultShape on a single-InputRef prompt', () => {
    const parsed = parsePipelineSpec({
      ...base,
      stages: [{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, resultShape: { fields: { verdict: 'string', severity: 'number' } } } }],
    })
    expect(parsed?.stages[0]).toEqual({
      name: 'a',
      scripted: { model: 'm', prompt: { from: 'goal' }, resultShape: { fields: { verdict: 'string', severity: 'number' } } },
    })
  })

  it('a scripted stage with no resultShape round-trips WITHOUT the key at all (backward compat)', () => {
    const parsed = parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' } } }] })
    expect(Object.keys((parsed?.stages[0] as { scripted: object }).scripted)).toEqual(['model', 'prompt'])
  })

  it('round-trips a resultShape ALONGSIDE calls', () => {
    const parsed = parsePipelineSpec({
      ...base,
      stages: [{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, calls: 3, resultShape: { fields: { verdict: 'string' } } } }],
    })
    expect(parsed?.stages[0]).toEqual({
      name: 'a',
      scripted: { model: 'm', prompt: { from: 'goal' }, calls: 3, resultShape: { fields: { verdict: 'string' } } },
    })
  })

  it('round-trips a resultShape on an ARRAY prompt (composition with the distinct-prompt fan)', () => {
    const parsed = parsePipelineSpec({
      ...base,
      stages: [
        {
          name: 'a',
          scripted: { model: 'm', prompt: [{ from: 'goal' }, { from: 'projectDir' }], resultShape: { fields: { verdict: 'string' } } },
        },
      ],
    })
    expect(parsed?.stages[0]).toEqual({
      name: 'a',
      scripted: { model: 'm', prompt: [{ from: 'goal' }, { from: 'projectDir' }], resultShape: { fields: { verdict: 'string' } } },
    })
  })

  it('accepts every recognized field type, including string[]', () => {
    const parsed = parsePipelineSpec({
      ...base,
      stages: [
        {
          name: 'a',
          scripted: {
            model: 'm',
            prompt: { from: 'goal' },
            resultShape: { fields: { verdict: 'string', severity: 'number', ok: 'boolean', findings: 'string[]' } },
          },
        },
      ],
    })
    expect(parsed).not.toBeNull()
  })

  it('rejects a resultShape with an unrecognized field type', () => {
    expect(
      parsePipelineSpec({
        ...base,
        stages: [{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, resultShape: { fields: { verdict: 'symbol' } } } }],
      }),
    ).toBeNull()
  })

  it('rejects a resultShape with zero fields — nothing checkable is not a shape', () => {
    expect(
      parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, resultShape: { fields: {} } } }] }),
    ).toBeNull()
  })

  it('rejects a resultShape that is not an object, and one missing "fields"', () => {
    expect(
      parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, resultShape: 'nope' } }] }),
    ).toBeNull()
    expect(
      parsePipelineSpec({ ...base, stages: [{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, resultShape: {} } }] }),
    ).toBeNull()
  })

  it('validateStageList accepts a well-formed resultShape directly (defense-in-depth path, not just the JSON parser)', () => {
    expect(
      validateStageList([{ name: 'a', scripted: { model: 'm', prompt: { from: 'goal' }, resultShape: { fields: { verdict: 'string' } } } }]),
    ).toBeNull()
  })
})

describe('describeScriptedResultShape', () => {
  it('renders one line per field, primitives named plainly and string[] spelled out', () => {
    const shape: ScriptedResultShape = { fields: { verdict: 'string', severity: 'number', urgent: 'boolean', findings: 'string[]' } }
    const text = describeScriptedResultShape(shape)
    expect(text).toContain('- verdict: string')
    expect(text).toContain('- severity: number')
    expect(text).toContain('- urgent: boolean')
    expect(text).toContain('- findings: an array of strings')
  })

  it('instructs against prose and markdown fences, and names the fields exactly', () => {
    const text = describeScriptedResultShape({ fields: { verdict: 'string' } })
    expect(text).toMatch(/no prose/i)
    expect(text).toMatch(/no markdown code fences/i)
  })

  it('is deterministic — same shape in, same string out', () => {
    const shape: ScriptedResultShape = { fields: { verdict: 'string' } }
    expect(describeScriptedResultShape(shape)).toBe(describeScriptedResultShape(shape))
  })

  // Cross-family review finding (card #1837198164): checkScriptedResult deliberately accepts
  // EXTRA undeclared fields (a subset match) — the instruction text must say so, or it asks
  // for something stricter than what is actually checked.
  it('does NOT claim "exactly these fields" — the checker accepts extras, so the instruction must not promise an exact match', () => {
    const text = describeScriptedResultShape({ fields: { verdict: 'string' } })
    expect(text).not.toMatch(/exactly these fields/i)
  })
})

describe('checkScriptedResult — the runtime conformance check', () => {
  const shape: ScriptedResultShape = { fields: { verdict: 'string', severity: 'number' } }

  it('accepts a conforming object and returns it as `data`', () => {
    const result = checkScriptedResult(shape, { verdict: 'approve', severity: 1 })
    expect(result).toEqual({ ok: true, data: { verdict: 'approve', severity: 1 } })
  })

  it('accepts a conforming object carrying EXTRA undeclared fields — subset match, not exact', () => {
    const result = checkScriptedResult(shape, { verdict: 'approve', severity: 1, extra: 'volunteered' })
    expect(result.ok).toBe(true)
  })

  it('rejects prose (a string) instead of an object — the COMMON non-compliance case', () => {
    const result = checkScriptedResult(shape, 'Looking at this diff, I would say it looks fine overall.')
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/expected a JSON object/) })
  })

  it('rejects a missing required field', () => {
    const result = checkScriptedResult(shape, { verdict: 'approve' })
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/missing required field "severity"/) })
  })

  it('rejects a field of the wrong type — never coerced', () => {
    const result = checkScriptedResult(shape, { verdict: 'approve', severity: 'high' })
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/field "severity" must be number, got string/) })
  })

  it('rejects null and an array at the top level', () => {
    expect(checkScriptedResult(shape, null).ok).toBe(false)
    expect(checkScriptedResult(shape, ['not', 'an', 'object']).ok).toBe(false)
  })

  it('checks string[] element-wise — a mixed array does not conform', () => {
    const listShape: ScriptedResultShape = { fields: { findings: 'string[]' } }
    expect(checkScriptedResult(listShape, { findings: ['a', 'b'] }).ok).toBe(true)
    expect(checkScriptedResult(listShape, { findings: ['a', 2] }).ok).toBe(false)
    expect(checkScriptedResult(listShape, { findings: 'not-an-array' }).ok).toBe(false)
  })

  it('rejects NaN/Infinity for a "number" field — Number.isFinite, not just typeof', () => {
    const numShape: ScriptedResultShape = { fields: { severity: 'number' } }
    expect(checkScriptedResult(numShape, { severity: NaN }).ok).toBe(false)
    expect(checkScriptedResult(numShape, { severity: Infinity }).ok).toBe(false)
  })

  // Cross-family review finding (card #1837198164): checkScriptedResult is a PUBLIC pure
  // function, callable directly — never routed only through the parser that already restricts
  // field types to SCRIPTED_RESULT_FIELD_TYPES. Without an explicit check, an UNRECOGNIZED type
  // string silently falls through the ternary chain's final branch (the string[] check),
  // producing a false {ok:true} for a shape that never should have been considered valid.
  it('rejects an UNRECOGNIZED field type — never silently treated as string[] via the ternary fallthrough', () => {
    // A cast bypasses TypeScript, the same way a directly-constructed spec bypasses the parser
    // everywhere else in this file's validateStageList-vs-parse posture.
    const bogusShape = { fields: { verdict: 'symbol' } } as unknown as ScriptedResultShape
    expect(checkScriptedResult(bogusShape, { verdict: 'approve' }).ok).toBe(false)
    // The false-positive shape the review flagged: an unrecognized type combined with a value
    // that IS a string array would otherwise slip through as {ok:true}.
    expect(checkScriptedResult(bogusShape, { verdict: ['x'] }).ok).toBe(false)
  })
})
