// hello-named.pipeline.ts — same as hello.pipeline.ts but with an explicit `name` (card
// #1813065099577918566) — proves the CLI's filename-derived injection defers to an author's
// own declared name rather than overwriting it.
import { definePipeline } from '../../src/define-pipeline.js'

export default definePipeline({
  goal: 'minimal fixture pipeline with its own declared name',
  projectDir: '/repo',
  name: 'custom-pattern-name',
  stages: [{ name: 'plan', workflow: 'plan.js' }],
})
