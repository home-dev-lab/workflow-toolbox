// hello-key-order.pipeline.ts — regression fixture (card #1813065099577918566 follow-up): a
// stage combining `gateAfter` + `artifact` + `input` in the SAME order feature-review.pipeline.ts
// uses, reproducing the exact shape that exposed a real bug — the name-injection step in
// cli.ts's runPipeline once serialized `result.spec` (the ROUND-TRIPPED, re-parsed spec, whose
// parseStageSpecV2 reconstructs a stage as `{name, workflow, [input], [gateAfter], [artifact]}`
// — a FIXED order) instead of re-parsing `result.json` (built from the RAW, author-order
// `rawSpec`), silently reordering `input` ahead of `gateAfter`/`artifact` on every regenerated
// artifact. hello.pipeline.ts's own "plan" stage has no `input` at all, so it never exercised
// this — this fixture exists specifically to catch it.
import { definePipeline } from '../../src/define-pipeline.js'

export default definePipeline({
  goal: 'key-order regression fixture',
  projectDir: '/repo',
  stages: [
    {
      name: 'plan',
      workflow: 'plan.js',
      gateAfter: true,
      artifact: { extract: 'plan-artifact' },
      input: { goal: { from: 'goal' }, projectDir: { from: 'projectDir' } },
    },
    { name: 'implement', workflow: 'implement.js', input: { artifactPath: { from: 'artifactPath' } } },
  ],
})
