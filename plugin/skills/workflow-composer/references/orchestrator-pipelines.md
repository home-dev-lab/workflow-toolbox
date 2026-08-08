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

The spec's validation contract is the standalone `@workflow-toolbox/pipeline-spec` package
(shared by `definePipeline()` — which returns a `DefinedPipeline`, the pipeline twin of
`DefinedWorkflow` — and the Observatory's pipeline runner):

- `parsePipelineSpec(value)` — parse + validate an untyped JSON value into a
  `PipelineSpec`; returns `null` when the shape is invalid.
- `validateStageList(stages)` — the structural rules as one reusable check; returns an
  error string, or `null` when the list is valid.
- `validatePipelineSpec(spec)` — the full-spec check: `validateStageList` over the stage
  list PLUS the `loop` rules (this level's and, recursively, every nested child's — see
  the loop section below). `definePipeline()` funnels through this; prefer it whenever you
  hold a whole spec rather than a bare stage list.
- `MAX_STAGES` (12) — DEFAULT cap on stages per spec; nested sub-specs are re-checked against the same
  default unless they set their own `limits.maxStages`. Absolute ceiling: `MAX_STAGES_CEILING` (100).
- `MAX_PIPELINE_DEPTH` (8) — DEFAULT cap on pipeline nesting depth. Absolute ceiling:
  `MAX_PIPELINE_DEPTH_CEILING` (20).
- `MAX_LOOP_ITERATIONS` (10) — DEFAULT cap on a loop's `maxIterations` (see below). Absolute ceiling:
  `MAX_LOOP_ITERATIONS_CEILING` (100).
- `PipelineSpec.limits` (type `PipelineLimits`, optional) — per-spec override of any of the three
  defaults above, each validated against its absolute ceiling at parse/validate time; a spec that needs
  more than 12 stages (or deeper nesting, or more loop iterations) sets e.g. `limits: { maxStages: 20 }`.
  Nested pipeline-stages are independent for `maxStages`/`maxLoopIterations`: a child spec inherits
  nothing from its parent's `limits` and must set its own override if it needs one. **`maxPipelineDepth`
  is the one exception** — depth is checked top-down, so an ANCESTOR's own (possibly stricter, default)
  limit is checked against the FULL subtree beneath it before a deeper child's own more permissive
  override is ever consulted. To allow deeper nesting anywhere in a tree, raise `maxPipelineDepth` on
  the ancestor whose own default would otherwise reject that depth (typically the root spec) — setting
  it only on the deeply-nested spec that needs the room does not rescue it.
- `EXTRACTOR_KEYS` (type `ExtractorKey`) — the legal `artifact.extract` values:
  `plan-artifact`, `raw`.
- `INPUT_REF_SOURCES` — the legal `{ from: … }` sources an `input` template may
  reference: `artifactPath`, `goal`, `projectDir`.

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
- **`name` is an OPTIONAL field on the spec (`PipelineSpec.name`)** — the pipeline's pattern
  name, symmetric to a workflow's own `meta.name`; `definePipeline()` lets an author set it
  explicitly, and that always wins. When omitted, `workflow-toolbox pipeline` injects a `name`
  derived from the entry filename (`foo.pipeline.ts` → `name: "foo"`) into the emitted JSON, so
  the runner can recognize the pipeline by its pattern TYPE, not only by its one-off `goal`
  string. The output FILENAME is derived separately from the same entry file; `--out` overrides
  only the filename, never the injected `name`. The server still mints its own pipeline id at
  launch, regardless of `name`.
- **A stage receives ONLY what its `input` template maps; an omitted `input` means EMPTY
  args** — there is no implicit inheritance from a prior stage or from the pipeline's own
  `goal`/`projectDir`. (This resolution step runs in the Workflow Observatory pipeline
  runner, the closed-source companion that launches the spec — this repo owns the shared
  spec shape and its structural validation, not the argument-construction runtime.) The legacy launch path wires `goal`/`projectDir` into its first stage
  explicitly; an authored spec's first stage must do the same (`input: { goal: { from: 'goal'
  }, projectDir: { from: 'projectDir' } }`) — there is no upstream stage to inherit them
  from. An unwired required field throws at the WORKFLOW's own `parseInput` boundary (a real
  run failure, not "produced nothing") — this is exactly what caught the first draft of
  `feature-review.pipeline.ts`'s `plan` stage. `definePipeline()` does NOT hard-validate
  input completeness (a workflow with no required args is entirely legitimate) — read the
  target workflow's own input contract before wiring a stage.
- The emitted JSON is exactly the wire body a runtime POSTs as
  `POST /api/pipeline { spec }` — the full `PipelineSpec`/`StageSpecV2`/`InputRef`
  shape reference and validation rules (stage caps, nesting depth, extractor keys) live in
  the Workflow Observatory docs (the closed-source companion that runs the pipeline);
  the spec types themselves ship here in `@workflow-toolbox/pipeline-spec`.
  Programmatically, `bundlePipeline` (from `@workflow-toolbox/build`) is the API twin of
  the `workflow-toolbox pipeline` CLI — same entry in, same emitted JSON out. It resolves
  to a `BundlePipelineResult`: `spec` (the validated, round-tripped `PipelineSpec` —
  guaranteed to be exactly what `parsePipelineSpec` would accept back from disk, not just
  what typechecked at the call site), `json` (the pretty-printed JSON, what gets written
  to disk), and `bytes` (`Buffer.byteLength(json)`).

#### Scripted stages — reaching an external model with zero Claude

Every `agent()` call, in every workflow, is a Claude Code subagent — there is no
workflow-level primitive that runs a process or reaches another model directly
(`toolkit/packages/runtime/globals.d.ts` declares exactly eight globals; none of them
spawns anything but a Claude agent). So "route this role to an external model" is not
a workflow-composition question at all when the requirement is a run with **no Claude
model in that role's turn** — it is a pipeline question, answered by a `scripted`
stage (`StageSpecV2.scripted`, `ScriptedStageSpec` in `@workflow-toolbox/pipeline-spec`).

A scripted stage is authored the same way as any other stage in `definePipeline()`,
mutually exclusive with `workflow`/`pipeline` on that stage:

```ts
{
  scripted: {
    model: 'openai/gpt-5.4',                       // the external lane's own model flag
    prompt: { from: 'artifactContent' },            // the prior stage's handoff, as text
  },
}
```

- **`model`** is passed straight through to the external lane's model flag — never
  checked against a Claude Code allowlist, because it names a different model family
  entirely.
- **`prompt`** is the same `InputRef` vocabulary a workflow stage's `input` uses. A
  single `InputRef` (e.g. `{ from: 'artifactContent' }` to hand the prior stage's
  handoff artifact straight to the external model) makes one call, optionally repeated
  `calls` times for N-of-M redundant voting on the SAME question. An ARRAY of
  `InputRef`s (and/or `ComposedPrompt`s, see below) makes N *distinct* concurrent
  calls — N different questions rather than N redundant verdicts — and `calls` is
  rejected alongside an array (only one field ever says "how many"). Both shapes are
  capped at `MAX_SCRIPTED_STAGE_CALLS` (8), the measured concurrency wall of the
  bundled opencode CLI before requests start queueing behind 429/retry.
- **Composed prompts** (`ComposedPrompt`, `{ compose: [...] }`) assemble ONE prompt
  from several of the four fixed `InputRef` sources plus author-written literal text —
  the shape that's missing when a prompt needs, say, the prior stage's handoff artifact
  AND a fixed judging instruction:
  ```ts
  prompt: {
    compose: [
      { text: 'Diff:\n\n' },
      { from: 'artifactContent' },
      { text: '\n\nJudge each finding as valid or not, and say why.' },
    ],
  }
  ```
  Each element of `compose` is a `PromptPart` — either an `InputRef` or a literal
  `{ text: string }`. Parts concatenate in the array's own order with **no implicit
  separator**: every byte of whitespace between two parts is a `{ text: ... }` part the
  author wrote themselves. A composition cannot nest — a part cannot itself be a
  `{ compose: [...] }`, one level only. `ComposedPrompt` is structurally distinct from
  the distinct-prompt fan above: the fan is a bare array (its length IS the call
  count), a composition is an object carrying a `compose` key, so the two readings
  never collide — `prompt: [a, b]` is always two calls, `prompt: { compose: [a, b] }`
  is always one call built from two parts. The two features compose freely: one
  element of a distinct-prompt array may itself be a `ComposedPrompt`
  (`prompt: [{ from: 'goal' }, { compose: [...] }]`), giving N independent calls each
  potentially built from several sources.
- **`resultShape`** requests a structured, comparable verdict from every call the stage
  issues, instead of leaving the caller to parse prose.
- The runner adapts a scripted stage to the SAME `LaunchedStage` contract a workflow
  stage's launch produces — gate, artifact extraction, and settlement never learn the
  difference, so a pipeline can freely mix `workflow` and `scripted` stages (a Claude
  planning stage feeding a `scripted` external-model judge via its handoff artifact).

**Two buildable examples exist for this** — `toolkit/examples/scripted-fully.pipeline.ts`
(every stage `scripted`, zero Claude anywhere in the run) and
`toolkit/examples/scripted-mixed.pipeline.ts` (one Claude `workflow` stage, pinned cheap
in its own source, handing its result to one `scripted` stage). Both are listed with what
they prove in [shipped-compositions.md](shipped-compositions.md#four-orchestrator-pipeline-compositions-definepipeline-not-defineworkflow).
Build either with `npx workflow-toolbox pipeline examples/scripted-mixed.pipeline.ts` (→
`pipelines/scripted-mixed.json`) and launch with `POST /api/pipeline { spec: <the built JSON> }`
against the observe-ui server.

⚠ **When the server serves more than one config dir, that route 404s.** It replies
`unknown hub route /api/pipeline — multi-source mode requires a source prefix` and NAMES the
valid prefixes in the same response, so the fix is one read away: post to
`/s/<source-prefix>/api/pipeline` instead. The auth header is `x-observe-token`, never
`Authorization: Bearer`. Measured 2026-08-08 — a first attempt with the unprefixed route was
rejected exactly this way.

**Status, stated at the reach its evidence has (2026-08-08):** a single-call scripted
stage, and a mixed pipeline (one `workflow` stage → one `scripted` stage consuming its
handoff via `{ from: 'artifactContent' }`), are **verified** — both ran live through the
observe server, zero Claude model in the scripted stage's own turn, real external
`externalSessionId` and reasoning-token accounting in the record. The `prompt` array /
`calls` fan-out is **supported, not verified reliable**: an authored array-prompt spec
validates and dispatches real concurrent calls, but the first live run of it failed at
runtime (one call hit the external CLI's own `database is locked`, the other a 120 s
timeout) before a later run succeeded — the mechanism is open, not proven, and a stage
using it should not be described as dependable until that is resolved.

**When to reach for this instead of the workflow-level `agentTypes` bridge**
(`references/model-and-agent-routing.md`'s "Cross-family routing"): that bridge still
runs a Claude subagent that shells out — useful for a narrow, decorrelated verifier
role INSIDE an otherwise-Claude workflow, and it is slated for removal, not hardening.
A scripted stage is the answer when the requirement is genuinely "no Claude model at
all" for that role, or when the workflow-level bridge's unreliability (a self-answering
wrapper, a badge that shows the wrapper's model rather than the lane's) is the exact
failure you are trying to design out.

#### Looping a pipeline — `loop` (re-run the stage list until done)

A spec — the ROOT one, or any nested `pipeline`-stage's child spec — may carry a `loop`
(shape `PipelineLoopSpec`): the runner re-runs the spec's WHOLE stage list until the stop
condition says done.

```ts
export default definePipeline({
  goal: 'Fix, review, repeat until the review comes back clean',
  projectDir: '.',
  loop: { until: { criterion: 'artifact-empty' }, maxIterations: 4 },
  stages: [
    { name: 'fix', workflow: 'dev-implement.js', input: { artifactPath: { from: 'artifactPath' } } },
    { name: 'review', workflow: 'pr-review.js', input: { target: { from: 'artifactPath' } } },
  ],
})
```

- **`until` (required)** — type `LoopUntil`, exactly one flavor:
  - `{ gate: true }` — a human **loop gate** at every iteration boundary: approve = run
    another iteration, stop = settle the pipeline. Distinct from a stage's own `gateAfter`
    (which gates INSIDE the body); the loop gate owns the boundary decision, which is also
    why the last stage still cannot carry `gateAfter` on a looped spec.
  - `{ criterion: '<key>' }` — a named predicate the RUNNER evaluates against the last
    stage's settled handoff artifact. The key set is a runner-side registry; the seed
    predicate is `artifact-empty` (stop when the last stage's handoff artifact is empty —
    the canonical "no findings left" case). An unknown key is rejected at LAUNCH time,
    exactly like an unknown workflow name — the spec package validates shape only.
- **`maxIterations` (required)** — integer safety ceiling, 1..`MAX_LOOP_ITERATIONS` (10).
  Hitting it settles the run (runner vocabulary: `stoppedBy` `'maxIterations'`, mirroring
  the in-run `loopUntilDone` pattern).

**Two granularities, one primitive.** Loop the whole pipeline by putting `loop` on the
root spec. Loop a **subsequence** of stages by composition: wrap the subsequence in a
nested `pipeline`-stage whose child spec carries the `loop` — there is no in-parent
stage-range selector:

```ts
stages: [
  { name: 'plan', workflow: 'dev-plan.js', gateAfter: true, artifact: { extract: 'plan-artifact' }, input: { goal: { from: 'goal' }, projectDir: { from: 'projectDir' } } },
  { name: 'iterate', pipeline: { goal: 'fix until clean', projectDir: '.', loop: { until: { criterion: 'artifact-empty' }, maxIterations: 3 }, stages: [ /* fix, review */ ] } },
  { name: 'wrap-up', workflow: 'independent-analysis.js', input: { subject: { from: 'artifactPath' } } },
]
```

**Two v1 expressiveness losses of the composition idiom, stated plainly.** A looped
subsequence inherits the `pipeline`-stage restrictions: (1) you cannot put `gateAfter`
immediately after the looped block (partial compensation: a `{ gate: true }` loop's final
"stop" IS a human touchpoint at that same boundary); (2) the looped block's outbound
handoff is raw-only — no extractor runs at a `pipeline`-stage boundary. If either bites,
that is the signal for an in-parent stage-range selector in a later version.

**Safety cap.** An `until.criterion` loop with NO gate anywhere in its expanded subtree
(no `gateAfter` at any nesting level, no nested `{ gate: true }` loop) must satisfy
*expanded launches × maxIterations ≤ `MAX_STAGES` (12)* — where the expanded launch count
multiplies nested children by their own loop ceilings (`expandedLaunches` in the spec
package). This preserves the same property `MAX_STAGES` protects: one POST must not
auto-chain an unbounded number of unattended launches. Loops with a human reachable
anywhere in the subtree are exempt from the product cap but keep the `maxIterations`
ceiling.

**Runner semantics (the contract the Observatory runner implements):**

- An iteration is a **same-manifest re-entry** of the owning spec's stage list — NOT a
  fresh pipeline per iteration. Every iteration's runs are new runs; history is kept
  (stage attempts append).
- The manifest's `lastArtifactPath` threads CONTINUOUSLY across the iteration boundary:
  iteration N's last-stage settled handoff resolves iteration N+1's first-stage
  `{ from: 'artifactPath' }` refs. Iteration 1 keeps today's rules (a root spec's first
  stage cannot reference `artifactPath` — there is nothing upstream yet).
- Stage `gateAfter` **re-arms every iteration** (each launch is a new attempt with its own
  gate); `until.gate` is the boundary gate on top of those.
- "Fresh instance per iteration" applies ONLY to a `pipeline`-stage inside the body: each
  iteration launches a fresh child run with its own manifest — the existing per-launch
  semantics, unchanged. The child's own `loop`, if any, runs to ITS stop condition inside
  each parent iteration.
- Ceiling hit → the run settles with `stoppedBy` `'maxIterations'`; unknown `criterion`
  keys are rejected at launch, before anything is minted.

**Deploy skew — honesty notes.** A runner whose bundled copy of
`@workflow-toolbox/pipeline-spec` predates `loop` silently drops the field (the pipeline
runs ONCE, no error): until the Observatory runner ships loop support, `loop` is
authorable but inert, and `criterion` keys additionally need the runner's predicate
registry. The observe server loads the shared package at process start — picking up a new
version requires a server restart — and the desktop app bundles its own copy, which
requires a re-release.
