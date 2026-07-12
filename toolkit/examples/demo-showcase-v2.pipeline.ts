// demo-showcase-v2.pipeline.ts — the ALL-NINE-PATTERNS orchestrator-pipeline
// showcase: a real pl_ → wf_ → pl_ composition the observe-ui pipeline runner
// launches (POST /api/pipeline {spec}), so the UX reviewer sees the features a
// single workflow CANNOT render — the fold/unfold nested stage tree, real HITL
// gates between stages, and the cross-stage report.
//
// Do NOT confuse this with the sandbox `pipeline()` primitive nor with the
// single-artifact all-in-one-run sibling `all-patterns-workflow.workflow.ts` (which
// exercises the same nine patterns inside ONE run, for a single-view render test).
// This file is the OTHER kind: N whole workflow artifacts, nested and gated.
//
// THREE NESTING LEVELS, distributing all nine patterns with DIFFERENT patterns per
// level, loopUntilDone drawn BOTH inner (L3) and outer (L1), and a real cross-stage
// human gate after the first root stage:
//
//   L1 root pipeline
//     ├─ route-triage   (workflow) — classifyAndAct + scoreAndRank   ──[HUMAN GATE]──▶
//     ├─ nested         (L2 pipeline)
//     │    ├─ fan-compete (workflow) — fanOutAndSynthesize + tournament
//     │    ├─ deep        (L3 pipeline)
//     │    │    └─ generate-verify (workflow) — generateAndFilter + chunkedAnalysis
//     │    │                                    + adversarialVerification + loopUntilDone INNER
//     │    └─ plan        (workflow) — planAndExecute
//     └─ refine-outer   (workflow) — loopUntilDone OUTER + final synthesis
//
// Every stage workflow is REAL (ships under toolkit/workflows/, so the runner's
// isKnownWorkflow allowlist accepts it). Each honors args.perAgent itself and
// defaults to haiku + low effort: the PipelineSpec cannot inject a per-stage model
// (InputRef sources are only artifactPath/goal/projectDir — no config channel), so
// the stages stay cheap-by-default and the whole capture run is trivial on haiku. A
// stage launched STANDALONE can still be retuned via its own args.perAgent.
//
// The stages need no upstream input (they are self-contained render fixtures), so
// `input` is omitted throughout — an omitted input means EMPTY args, which is valid
// for a workflow with no required fields. The gate after `route-triage` surfaces its
// raw output for approval; downstream stages do not consume it (a render fixture).
//
// Build: pnpm wt:pipeline examples/demo-showcase-v2.pipeline.ts  (→ pipelines/demo-showcase-v2.json)

import { definePipeline } from '@workflow-toolbox/build/define-pipeline'

export default definePipeline({
  goal: 'Render the all-nine-patterns showcase across three nested, gated pipeline levels',
  projectDir: '.',
  stages: [
    // L1 root stage 1 — a workflow, then a REAL human gate before the nested level.
    { name: 'route-triage', workflow: 'showcase-route-triage.js', gateAfter: true },
    // L1 root stage 2 — the NESTED L2 pipeline (own goal/projectDir, own manifest).
    {
      name: 'nested',
      pipeline: {
        goal: 'Render the L2 nested level: scatter-gather + tournament, then drill deeper, then plan',
        projectDir: '.',
        stages: [
          { name: 'fan-compete', workflow: 'showcase-fan-compete.js' },
          // L2 stage 2 — the DEEP L3 pipeline (single stage: the deepest, most varied level).
          {
            name: 'deep',
            pipeline: {
              goal: 'Render the L3 deep level: generate/filter, chunked map-reduce, refute-first verify, inner loop',
              projectDir: '.',
              stages: [
                { name: 'generate-verify', workflow: 'showcase-deep.js' },
              ],
            },
          },
          { name: 'plan', workflow: 'showcase-plan.js' },
        ],
      },
    },
    // L1 root stage 3 — the outer polish loop + final synthesis.
    { name: 'refine-outer', workflow: 'showcase-refine-outer.js' },
  ],
})
