# 8. Pipeline authoring surface & orchestrator vocabulary

Date: 2026-07-04

## Status

Accepted

## Context

Before this increment, an N-stage, human-gated job (ADR 0007's `observe-ui` pipeline
runner) could only be launched by POSTing a hand-written JSON body
(`POST /api/pipeline { goal, projectDir? }`) — there was no way to *author* a multi-stage,
possibly-nested pipeline as typed TypeScript the way `defineWorkflow` already lets an
author express a single workflow. The runner had in fact already grown a richer,
undocumented v2 wire form (`{ spec: PipelineSpec }`, validated by `parsePipelineSpec`) that
supported nesting (`stage.pipeline`) and per-stage artifact handoff — but nothing surfaced
it to an author, and nothing documented it.

Closing that gap surfaced a genuine vocabulary collision: **"pipeline"** already names one
of the eight compile-time orchestration patterns — `pipeline(items, ...stages)`, an
in-run, item-by-item staged fan-out *inside a single workflow script*
(`plugin/skills/workflow-composer/SKILL.md`'s Composition Rules and raw-authoring-path
sections). The new construct is a *different* thing at a *different* level — N whole
**workflow files**, optionally nested, optionally gated by a human between stages — and
reusing the bare word "pipeline" for both, in the same document, was already producing
mixed-sense prose (a vocabulary sweep of `workflow-composer/SKILL.md` counted ~15
occurrences of "pipeline" split across the two senses, most already unambiguous by code
context but several — notably the "Human-gated pipelines" section header itself —
genuinely reading either way).

Three questions needed arbitration before implementation: (1) whether to build a
delegated, UI-driven pipeline builder or keep authoring text-based; (2) whether to rename
a symbol to resolve the vocabulary collision; (3) whether the runtime's existing
exit-gate prohibition and nested-stage handoff semantics should be revisited alongside the
new authoring surface, or treated as settled.

## Decision

**D1 — The authoring surface is documentation + a typed `definePipeline()`, not a
delegated builder UI.** Symmetric with ADR 0001's "compile-time library, not a runtime
framework" posture: an author writes a `*.pipeline.ts` file that
`export default definePipeline({...})`s a `PipelineSpec`
(`@workflow-toolbox/pipeline-spec`), builds it with a new `workflow-toolbox pipeline`
CLI subcommand (mirroring `workflow-toolbox build`), and gets back a committed,
reviewable, diffable JSON artifact — the same "text in, text out" contract
`defineWorkflow` already has, not a stateful builder UI that would need its own state
model, auth surface, and edit history. `plugin/skills/workflow-composer/SKILL.md` teaches
the authoring contract; `toolkit/apps/observe-ui/README.md` documents the wire contract
the built artifact is POSTed against (`{ spec: PipelineSpec }`) — the two documents
cross-reference each other rather than duplicating either contract.

**D2 — No renaming; a vocabulary CONVENTION disambiguates instead.** The in-run
`pipeline()` orchestration pattern keeps its name unqualified — it is a runtime global,
changing it would be a breaking API rename for zero benefit. Going forward, prose refers
to the new N-workflow, human-gated construct as an **"orchestrator pipeline"** (two
words) at every point of possible confusion with the in-run pattern; the bare word
"pipeline" stays reserved for contexts where code (a `pipeline(items, ...)` call, a
`pipeline.template.js` filename) already disambiguates unambiguously. No code symbol was
renamed to satisfy this — it is a documentation-only convention, applied in this
increment's edits to `workflow-composer/SKILL.md`'s "Human-gated pipelines" section (now
introducing "orchestrator pipeline" at first mention) and to the new
`definePipeline()`-authoring content.

**D3 — The exit-gate prohibition stays; parent-side handoff semantics ratified;
the review-stage-plus-gate pattern is approver-agnostic.** None of these pre-existing
runtime rules are revisited by adding an authoring surface for them — they are reaffirmed
as-is:

- `validateStageList` (`@workflow-toolbox/pipeline-spec`) rejects a spec whose *last*
  stage carries `gateAfter: true` ("a trailing gate has no downstream stage to launch —
  exit-gate/sign-off semantics are a deliberate later design decision"). An orchestrator
  pipeline always *ends by running* its last stage; it never ends by pausing on one.
- A nested pipeline-stage's (`stage.pipeline`) handoff to its parent is always the
  child's own raw final output, passed through verbatim — no extractor ever runs at that
  boundary (`stage.artifact` is disallowed on a pipeline-stage, and `gateAfter` is
  disallowed there too, in v1 — gates live *inside* the child's own stage list, unchanged).
- The "stage → human gate → next stage" pattern (as in the canonical
  `toolkit/examples/feature-review.pipeline.ts` example's `review` stage) is
  **approver-agnostic**: nothing in `PipelineSpec` or `definePipeline()` assumes a human
  sits at the gate. Who or what resolves `POST /api/gate/:id` is entirely the runtime's
  concern, outside the authored spec — an automated approver is not precluded by anything
  in the authoring contract.

## Consequences

- `@workflow-toolbox/pipeline-spec` ships as its own npm package at the next release —
  the spec-validation surface is the public authoring contract, and publishing it
  directly is the honest fix for a gap discovered while wiring `definePipeline()`:
  tsup's `.d.ts` bundling does not resolve a devDependency's re-exported types the way it
  inlines that devDependency's JS, leaving `@workflow-toolbox/build`'s
  `dist/index.d.ts` with a bare, unresolvable `import { PipelineSpec } from
  '@workflow-toolbox/pipeline-spec'`. Until that release, `@workflow-toolbox/build`
  inlines it as a **devDependency** (correct at the JS-bundle level; the harmless `.d.ts`
  gap does not affect any current gate, since nothing publishes off a branch — see ADR
  and the no-publish-from-branches rule).
- `toolkit/examples/feature-review.pipeline.ts` is the canonical, living-documentation
  example for `definePipeline()` — nesting (a `feature` stage that is itself a
  sub-pipeline) AND gating (`review` → human gate → `wrap-up`) in one realistic spec.
  Its emitted `toolkit/pipelines/feature-review.json` is committed and byte-identity
  gated (`pipeline-artifact-identity.test.ts`), extending ADR 0002's "commit built
  artifacts" contract to pipeline specs.
- D4/D5 from the increment's arbitration (process and product-preference items — not
  repo architecture) are intentionally **not** recorded here; they stay tracked on the
  increment's card.
