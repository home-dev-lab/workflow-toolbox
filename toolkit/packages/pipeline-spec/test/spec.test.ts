import { describe, it, expect } from 'vitest'
import {
  INPUT_REF_SOURCES,
  MAX_STAGES,
  MAX_PIPELINE_DEPTH,
  EXTRACTOR_KEYS,
  validateStageList,
  parsePipelineSpec,
  type StageSpecV2,
  type PipelineSpec,
} from '../src/index.js'

// Single source of truth for pipeline-spec authoring/validation, shared verbatim between
// apps/observe-ui/server/pipeline.ts (the runtime orchestrator) and definePipeline()
// (@workflow-toolbox/build). This suite covers the pure logic standalone — the app's own
// pipeline.test.ts/pipeline-manifest.test.ts additionally exercise it through the runner's
// integration surface (start(), POST /api/pipeline), which stays there since it also drives
// launch/gate/manifest behavior this package knows nothing about.

const baseStage = (name: string): StageSpecV2 => ({ name, workflow: `${name}.js` })

describe('constants', () => {
  it('INPUT_REF_SOURCES lists the three recognized sources', () => {
    expect(INPUT_REF_SOURCES).toEqual(['artifactPath', 'goal', 'projectDir'])
  })

  it('EXTRACTOR_KEYS lists the two recognized extractor keys', () => {
    expect(EXTRACTOR_KEYS).toEqual(['plan-artifact', 'raw'])
  })

  it('MAX_STAGES and MAX_PIPELINE_DEPTH are the documented caps', () => {
    expect(MAX_STAGES).toBe(12)
    expect(MAX_PIPELINE_DEPTH).toBe(8)
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

  it('rejects a stage with neither "workflow" nor "pipeline"', () => {
    expect(validateStageList([{ name: 'a' } as StageSpecV2])).toMatch(/exactly one of "workflow" or "pipeline"/)
  })

  it('rejects a stage with BOTH "workflow" and "pipeline"', () => {
    const spec: PipelineSpec = { goal: 'g', projectDir: '/repo', stages: [baseStage('x')] }
    expect(validateStageList([{ name: 'a', workflow: 'a.js', pipeline: spec }])).toMatch(/exactly one of "workflow" or "pipeline"/)
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
