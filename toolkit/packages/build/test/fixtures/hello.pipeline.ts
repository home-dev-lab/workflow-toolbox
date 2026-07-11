// hello.pipeline.ts — minimal valid pipeline fixture for bundlePipeline tests.
//
// Imports definePipeline via relative path (the .js extension is required for ESM/bundler
// resolution — esbuild resolves .ts from the .js specifier), mirroring hello.workflow.ts.
import { definePipeline } from '../../src/define-pipeline.js'

export default definePipeline({
  goal: 'minimal fixture pipeline',
  projectDir: '/repo',
  stages: [
    { name: 'plan', workflow: 'plan.js', gateAfter: true, artifact: { extract: 'plan-artifact' } },
    { name: 'implement', workflow: 'implement.js', input: { artifactPath: { from: 'artifactPath' } } },
  ],
})
