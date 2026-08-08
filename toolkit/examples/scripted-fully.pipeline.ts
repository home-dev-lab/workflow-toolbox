// scripted-fully.pipeline.ts — the FULLY-SCRIPTED proof pipeline (card #1837209261): every
// stage is a `scripted` stage, so a run of this spec puts ZERO Claude models in the loop —
// the whole run happens on the opencode/GPT lane. This is the shape that makes "a run
// entirely on the external lane" a measured fact rather than a design claim.
//
// Single stage, single call, one-sentence prompt — deliberately trivial: this card proves the
// PLUMBING (a scripted stage executes, the observatory renders it, the CLI was really
// invoked), not the model's reasoning. See ScriptedStageSpec's own doc
// (@workflow-toolbox/pipeline-spec) for the field shapes.
//
// The prompt has no literal-constant InputRef source (INPUT_REF_SOURCES is
// artifactPath/goal/projectDir/artifactContent — no bare-string source), so the established
// idiom (see feature-review.pipeline.ts's "ACCEPTED GAP" comment) is reused here: the
// pipeline's own `goal` field IS the prompt text, referenced via `{ from: 'goal' }`.
//
// Build: pnpm wt:pipeline examples/scripted-fully.pipeline.ts  (→ pipelines/scripted-fully.json)
// Launch: POST /api/pipeline { spec: <the built JSON> } against the observe-ui server.

import { definePipeline } from '@workflow-toolbox/build/define-pipeline'

export default definePipeline({
  goal: 'Reply with exactly: OK. Nothing else.',
  projectDir: '.',
  name: 'scripted-fully',
  stages: [
    {
      name: 'external-only',
      scripted: {
        model: 'openai/gpt-5.4',
        prompt: { from: 'goal' },
      },
    },
  ],
})
