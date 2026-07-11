# Orchestrator pipelines — human-gated, multi-workflow jobs

<!-- Extracted from SKILL.md (progressive disclosure) — loaded on demand via the stub that links here. -->


A multi-stage job with a human sign-off in the middle is an **orchestrator pipeline**:
N whole workflow **files**, optionally nested, optionally joined by a human gate. This is
a different, higher-level construct than the in-run `pipeline()` pattern used earlier in
this guide — that one fans a *single workflow's* items through stages inside one script;
an orchestrator pipeline chains *entire workflow artifacts*, each its own compiled `.js`.
The gate is a **workflow boundary, never a mid-run pause** — Dynamic Workflows has no
in-flight HITL (a script cannot stop and wait for a person, and workflow agents have no
`AskUserQuestion`). So you don't *build a gate into* a workflow; you author **gate-ready
stages** and let an orchestrator (the runtime that drives the pipeline — not Claude, and
not the workflow script) gate between them. Your job as the composer is the stages + their
handoff contract:

1. **Stage 1 returns an artifact**, schema'd at its boundary — the plan / candidate set /
   review the human will inspect (e.g. `return { artifact: planArtifact }`).
2. An **orchestrator** (a durable-execution product with `waitForApproval`; or, in this
   repo, the dev-only `observe-ui` pipeline runner) surfaces that artifact for
   approve / edit / reject, then launches
3. **Stage 2 with the *approved* artifact** — pass it by an input the stage reads, the
   idiomatic one being **`{ artifactPath }`**: stage 2 reads the approved-artifact JSON from
   that path (its `parseInput` requires `artifactPath`). Passing the artifact inline via
   `args` also works for small payloads.

Read the shipped pairs as models: **`monorepo-refactor-plan` → `monorepo-refactor-execute`**
and **`dev-plan` → `dev-implement`** (the `spike-plan` / `spike-implement` stand-ins in
`apps/observe-ui/spike-workflows/` are the minimal version). This is the architecture L3
pathway ("HITL = workflow boundary", see `docs/public/architecture.md`). Do **not** try to
splice the two stages into one file to "keep it together" — the split *is* the gate.

#### Authoring an orchestrator pipeline with `definePipeline()`

You don't have to hand-write the JSON body above. `@workflow-toolbox/build` ships a
`definePipeline()` entry-point that mirrors `defineWorkflow`'s own contract exactly — a
typed TypeScript file, compiled to a self-contained artifact:

```ts
// feature-review.pipeline.ts  (filename convention: strip .pipeline.ts for the output name)
import { definePipeline } from '@workflow-toolbox/build/define-pipeline'   // ⚠ NOT '@workflow-toolbox/build'

export default definePipeline({
  goal: 'Implement a feature, then have it human-reviewed before wrap-up',
  projectDir: '.',
  stages: [
    {
      name: 'feature',
      // A stage can itself be a NESTED orchestrator pipeline — same runner, own manifest.
      pipeline: {
        goal: 'Plan then implement the feature',
        projectDir: '.',
        stages: [
          // The FIRST stage of any spec wires its own goal/projectDir explicitly — there is
          // no upstream stage to inherit them from (an omitted `input` means EMPTY args).
          { name: 'plan', workflow: 'dev-plan.js', gateAfter: true, artifact: { extract: 'plan-artifact' }, input: { goal: { from: 'goal' }, projectDir: { from: 'projectDir' } } },
          { name: 'implement', workflow: 'dev-implement.js', input: { artifactPath: { from: 'artifactPath' } } },
        ],
      },
    },
    // pr-review's OWN input field is `target`, not `artifactPath` — map to the workflow's
    // actual contract, never assume the key names match.
    { name: 'review', workflow: 'pr-review.js', input: { target: { from: 'artifactPath' } }, gateAfter: true },
    { name: 'wrap-up', workflow: 'independent-analysis.js', input: { subject: { from: 'artifactPath' } } },
  ],
})
```

Build it with the `pipeline` CLI subcommand (mirrors `build`'s `--typecheck`/`--minify`):

```bash
npx workflow-toolbox pipeline feature-review.pipeline.ts --typecheck   # → pipelines/feature-review.json
```

The full, buildable version of this example is the toolkit's own living documentation for
`definePipeline()` — read it at `toolkit/examples/feature-review.pipeline.ts` (its built
artifact, `toolkit/pipelines/feature-review.json`, is committed and gated byte-identical
to a rebuild). A few things worth knowing before you write one:

- **⚠ Import from `@workflow-toolbox/build/define-pipeline`, never the package root**, same
  reason as `defineWorkflow`'s own subpath rule (SKILL.md § Authoring contract): the root re-exports the
  bundlers and drags Node-only code into a whole-program `--typecheck` pass over your
  entry. `workflow-toolbox pipeline` pre-flights this mistake with an actionable error.
- **A stage sets exactly one of `workflow` or `pipeline`**, never both, never neither.
  `gateAfter` is disallowed on a `pipeline`-stage (gates live *inside* the child's own
  stage list) and on the **last** stage of any spec (an orchestrator pipeline always ends
  by *running* its last stage, never by pausing on one — see
  `docs/public/adr/0008-pipeline-authoring-surface-vocabulary.md`).
- **There is no `name` field on the spec itself** — the CLI derives the output filename
  from the entry file (`foo.pipeline.ts` → `pipelines/foo.json`; `--out` overrides it).
  The server mints its own pipeline id at launch time.
- **A stage receives ONLY what its `input` template maps; an omitted `input` means EMPTY
  args** — there is no implicit inheritance from a prior stage or from the pipeline's own
  `goal`/`projectDir`. The legacy launch path wires `goal`/`projectDir` into its first stage
  explicitly; an authored spec's first stage must do the same (`input: { goal: { from: 'goal'
  }, projectDir: { from: 'projectDir' } }`) — there is no upstream stage to inherit them
  from. An unwired required field throws at the WORKFLOW's own `parseInput` boundary (a real
  run failure, not "produced nothing") — this is exactly what caught the first draft of
  `feature-review.pipeline.ts`'s `plan` stage. `definePipeline()` does NOT hard-validate
  input completeness (a workflow with no required args is entirely legitimate) — read the
  target workflow's own input contract before wiring a stage.
- The emitted JSON is exactly the wire body a runtime POSTs as
  `POST /api/pipeline { spec }` — see `toolkit/apps/observe-ui/README.md`'s **"Pipeline
  spec (v2 authoring form)"** section for the full `PipelineSpec`/`StageSpecV2`/`InputRef`
  shape reference and validation rules (stage caps, nesting depth, extractor keys).

