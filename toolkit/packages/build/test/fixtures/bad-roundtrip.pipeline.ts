// bad-roundtrip.pipeline.ts — negative fixture: a spec that bypasses TypeScript's own checks
// (via a cast) with a `goal` of the wrong type. Batch 5 (item 5): definePipeline() now runs
// its OWN parsePipelineSpec round-trip (not just validateStageList), so the failure surfaces
// HERE, synchronously, at module-evaluation time — never even reaching bundlePipeline's Step 2
// (evaluating the bundled IIFE just re-throws whatever definePipeline() itself threw).
// bundlePipeline's own round-trip (Step 3) still exists as defense-in-depth for an author who
// bypasses definePipeline() entirely — see bypass-define-bad-roundtrip.pipeline.ts.
import { definePipeline } from '../../src/define-pipeline.js'
import type { PipelineSpec } from '@workflow-toolbox/pipeline-spec'

export default definePipeline({
  goal: 42,
  projectDir: '/repo',
  stages: [{ name: 'a', workflow: 'a.js' }],
} as unknown as PipelineSpec)
