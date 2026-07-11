// no-default-export.pipeline.ts — negative fixture: no default export.
//
// bundlePipeline should reject this with an actionable error telling the author the entry file
// must `export default definePipeline({...})`.
import { definePipeline } from '../../src/define-pipeline.js'

// Named export only — intentionally missing `export default`
export const myPipeline = definePipeline({
  goal: 'negative fixture — named export only',
  projectDir: '/repo',
  stages: [{ name: 'a', workflow: 'a.js' }],
})
