// scripted-mixed.pipeline.ts — the MIXED proof pipeline (card #1837209261): one Claude
// `workflow` stage, then one `scripted` (external-lane) stage that CONSUMES the workflow
// stage's handoff artifact through an InputRef. This is what a review that keeps cheap Claude
// work and sends the judging to an external model looks like.
//
//   e2e-fixture (workflow, haiku)  →  external-review (scripted, opencode)
//
// The scripted stage ALSO exercises the distinct-prompt fan (card #1837144459): its `prompt`
// is authored as an ARRAY of two InputRefs, so this one stage produces two independent,
// positionally-attributed external calls rather than one — [0] a trivial fixed question via
// `{ from: 'goal' }` (same literal-via-goal idiom as scripted-fully.pipeline.ts), [1] the
// upstream stage's actual handoff artifact via `{ from: 'artifactContent' }`, the capability
// this pipeline exists to prove. Two calls here + one in scripted-fully.pipeline.ts = three
// external calls total for the whole card, at the ceiling set for this proof.
//
// Stage 1 is `wt-shape-e2e` — the project's own standing cheap e2e vehicle (haiku + low
// effort pinned IN ITS SOURCE, ~3 trivial agents, no real work, see its own file header and
// the project rule `how-to-launch-workflows.md` § "E2E/DEMO runs"). It reads no `input`
// (omitted = empty args, valid for a workflow with no required fields — same convention
// demo-showcase-v2.pipeline.ts already uses) and needs none for this proof: only its handoff
// artifact reaching the next stage is being exercised.
//
// Build: pnpm wt:pipeline examples/scripted-mixed.pipeline.ts  (→ pipelines/scripted-mixed.json)
// Launch: POST /api/pipeline { spec: <the built JSON> } against the observe-ui server.

import { definePipeline } from '@workflow-toolbox/build/define-pipeline'

export default definePipeline({
  goal: 'Reply with exactly: OK. Nothing else.',
  projectDir: '.',
  name: 'scripted-mixed',
  stages: [
    {
      name: 'e2e-fixture',
      workflow: 'wt-shape-e2e',
    },
    {
      name: 'external-review',
      scripted: {
        model: 'openai/gpt-5.4',
        prompt: [{ from: 'goal' }, { from: 'artifactContent' }],
      },
    },
  ],
})
