// feature-review.pipeline.ts — canonical ORCHESTRATOR-PIPELINE authoring example (I5). This
// is the LIVING DOCUMENTATION for definePipeline(): apps/observe-ui/README.md's authoring
// section and the workflow-composer skill both point here as the model to read/copy, the same
// way dev-plan/dev-implement are the model for a single gated stage pair.
//
// Do not confuse this with the sandbox `pipeline()` primitive a defineWorkflow-bundled script
// calls INSIDE a run (see docs/public/adr/0008 for the "in-run pipeline pattern" vs
// "orchestrator pipeline" vocabulary convention) — this file declares the OTHER kind: an
// N-stage, human-gated PipelineSpec the observe-ui pipeline runner launches via
// POST /api/pipeline {spec}.
//
// The nominal pattern this demonstrates (D3): a NESTED sub-pipeline (gate-ready plan→implement,
// itself internally gated) as stage 1, then a plain gated review stage, then a final wrap-up —
// exercising BOTH nesting and gating in one realistic shape:
//
//   [feature: plan --gate--> implement]  →  review --gate-->  wrap-up
//
// Build: pnpm wt:pipeline examples/feature-review.pipeline.ts (writes pipelines/feature-review.json)
//
// Every workflow named below is REAL (ships under toolkit/workflows/, so isKnownWorkflow's
// allowlist accepts it at launch time) — batch 4 replaced the original wrap-up.js placeholder
// (which did not exist and would have failed "not in the allowlist" the moment this pipeline
// actually ran).
//
// EVERY stage below wires its `input` EXPLICITLY. This matters: resolveInput only fills in what
// the template maps — an OMITTED `input` means the stage launches with EMPTY args, not "whatever
// the pipeline happens to be carrying". Batch 4 found this the hard way: the first version of
// this file omitted `plan`'s input entirely, so dev-plan received `{}` and threw `"goal" must be
// a non-empty string` — exactly the class of bug an unwired first stage produces (see
// toolkit/apps/observe-ui/README.md's "Pipeline spec" section and workflow-composer/SKILL.md's
// authoring section for the same warning). legacyToSpec (apps/observe-ui/server/pipeline.ts)
// is the reference for how a first stage wires goal/projectDir explicitly.
//
// ACCEPTED GAP: InputRef (@workflow-toolbox/pipeline-spec) has exactly three sources —
// artifactPath/goal/projectDir — no literal-constant authoring support yet. `review` and
// `wrap-up` below map the upstream artifactPath (a FILE PATH string) onto pr-review's `target`
// and independent-analysis's `subject` fields respectively — both accept it as "a non-empty
// string" and launch cleanly, but the CONTENT is thin (a path, not a git ref or a real
// description) for a real review/analysis. A production adaptation would want either a stage
// that materializes a proper description into the artifact, or a future InputRef literal
// source; noting this honestly rather than hiding it behind a workflow that silently ignores
// its own input contract.
//
// Import from '@workflow-toolbox/build/define-pipeline' (NOT the package root): the root
// re-exports the Node-side bundler (bundlePipeline, bundleWorkflow), and `workflow-toolbox
// pipeline --typecheck` type-checks this entry's WHOLE reachable module graph — pulling that
// in would need Node types available just to author a pipeline spec. Mirrors defineWorkflow's
// own '@workflow-toolbox/build/define' convention exactly.
import { definePipeline } from '@workflow-toolbox/build/define-pipeline'

export default definePipeline({
  goal: 'Implement a feature, then have it human-reviewed before wrap-up',
  projectDir: '.',
  stages: [
    {
      name: 'feature',
      // A NESTED orchestrator pipeline (own goal/projectDir/stages, own manifest once
      // launched) — the gate-ready plan→implement pair workflow-composer's SKILL.md teaches as
      // the canonical single-gate model, reused here as ONE stage of the outer pipeline.
      // `gateAfter`/`artifact` are disallowed on the OUTER pipeline-stage itself (validateStageList
      // enforces this) — gating happens INSIDE the child, unchanged.
      pipeline: {
        goal: 'Plan then implement the feature',
        projectDir: '.',
        stages: [
          {
            name: 'plan',
            workflow: 'dev-plan.js',
            gateAfter: true,
            artifact: { extract: 'plan-artifact' },
            // The FIRST stage of any spec must wire its own goal/projectDir explicitly — there
            // is no upstream stage to inherit them from (mirrors legacyToSpec's own wiring).
            input: { goal: { from: 'goal' }, projectDir: { from: 'projectDir' } },
          },
          { name: 'implement', workflow: 'dev-implement.js', input: { artifactPath: { from: 'artifactPath' } } },
        ],
      },
    },
    // A plain workflow stage, gated: a pipeline-stage's handoff is always the child's own raw
    // final output (dev-implement's result here) — `review` reads it via `target` (pr-review's
    // OWN input field name — NOT `artifactPath`; see the ACCEPTED GAP note above), and its OWN
    // result is gated for human approval before `wrap-up` ever launches.
    { name: 'review', workflow: 'pr-review.js', input: { target: { from: 'artifactPath' } }, gateAfter: true },
    // wrap-up: one more independent, bias-free sanity pass over the reviewed implementation
    // before considering the feature done. independent-analysis.js's ONLY required field is
    // `subject` (a non-empty string) — everything else defaults — making it the one real,
    // shipped workflow whose contract the v1 InputRef system (3 sources, no literal constants)
    // can actually satisfy end-to-end for a generic final stage.
    { name: 'wrap-up', workflow: 'independent-analysis.js', input: { subject: { from: 'artifactPath' } } },
  ],
})
