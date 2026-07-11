// bypass-define-bad-roundtrip.pipeline.ts — negative fixture for bundlePipeline's OWN
// parsePipelineSpec round-trip (batch 5, item 5's defense-in-depth test): this entry does NOT
// call definePipeline() at all — an author could construct the `{ spec }` default export by
// hand, skipping every check definePipeline() now performs (validateStageList AND its own
// round-trip). bundlePipeline's Step 3 round-trip is what catches this shape regardless — the
// SAME reason it stays in the code even now that definePipeline() runs the same check itself.
import type { PipelineSpec } from '@workflow-toolbox/pipeline-spec'

export default {
  spec: {
    goal: 42,
    projectDir: '/repo',
    stages: [{ name: 'a', workflow: 'a.js' }],
  } as unknown as PipelineSpec,
}
