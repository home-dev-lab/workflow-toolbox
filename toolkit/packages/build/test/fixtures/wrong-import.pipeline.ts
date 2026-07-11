// wrong-import.pipeline.ts — negative fixture: imports definePipeline from the package ROOT
// instead of the '/define-pipeline' subpath. bundlePipeline's pre-flight check must reject
// this with an actionable error BEFORE ever invoking esbuild, mirroring bundleWorkflow's own
// '@workflow-toolbox/build' foot-gun guard.
import { definePipeline } from '@workflow-toolbox/build'

export default definePipeline({
  goal: 'negative fixture — wrong import path',
  projectDir: '/repo',
  stages: [{ name: 'a', workflow: 'a.js' }],
})
