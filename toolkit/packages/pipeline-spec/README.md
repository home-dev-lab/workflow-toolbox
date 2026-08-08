# @workflow-toolbox/pipeline-spec

The declarative `PipelineSpec` authoring and validation surface: pure data shapes plus
synchronous structural validation, with **zero dependencies**. A pipeline chains several
workflows together with a human-approval gate between stages — `PipelineSpec` is the JSON
shape that describes that chain, independent of any particular runner.

This same module is shared verbatim between `definePipeline()`
(`@workflow-toolbox/build`, the author-time TypeScript validation path) and the Workflow
Observatory pipeline runner (the runtime path), so an authored spec and a live-launched
spec are validated by the exact same rules.

## Install

```bash
pnpm add @workflow-toolbox/pipeline-spec
```

## What's in it

- `PipelineSpec` — `{ goal, projectDir, stages }`: the full declarative pipeline
  definition.
- `StageSpecV2` — one stage: which workflow to run, which nested sub-pipeline to recurse
  into, or which scripted external-lane call to run (exactly one of `workflow` /
  `pipeline` / `scripted`), how to build its args from prior state (`input`), how to
  extract its handoff artifact for the next stage, and whether a human gate follows it
  (`gateAfter`).
- `ScriptedStageSpec` — a stage that runs a scripted external-lane call (an opencode CLI
  invocation, in the companion runtime) instead of a Claude Code workflow: a `model`
  identifier plus a `prompt` InputRef. The runner adapts it to the same launch contract a
  workflow stage's launch produces, so gate/artifact-extraction/settlement never learn the
  difference. An optional `calls` (default 1, capped by `MAX_SCRIPTED_STAGE_CALLS`) fans
  the stage out into that many CONCURRENT calls of the same prompt, all collected before
  the stage settles — a single call's behavior is byte-for-byte unchanged. An optional
  `resultShape` (`ScriptedResultShape` — `{ fields: Record<string, ScriptedResultFieldType>
  }`, field types restricted to `SCRIPTED_RESULT_FIELD_TYPES`) declares an expected JSON
  result: the external lane is a CLI with no tool-call/schema protocol, so compliance is
  REQUESTED via a prompt-convention instruction (`describeScriptedResultShape`) and CHECKED
  after the fact against the raw response text (`checkScriptedResult`, which returns a
  `ScriptedResultCheck` — `{ok:true, data}` on conformance, `{ok:false, reason}` otherwise,
  never a fabricated value). Applies to every call the stage issues, whichever fan shape is
  in play — one shape, N attempts, never a per-call shape. Omitted: today's exact behaviour.
- `InputRef` — a declarative reference to a runtime value pulled in at launch, restricted
  to `INPUT_REF_SOURCES` (`'artifactPath' | 'goal' | 'projectDir' | 'artifactContent'` —
  the last resolves to the prior stage's handoff artifact read off disk as TEXT, as
  opposed to `'artifactPath'`, which resolves to the path itself).
- `ExtractorKey` — the named handoff-artifact extractor a stage selects, restricted to
  `EXTRACTOR_KEYS`.
- `PipelineLoopSpec` / `LoopUntil` — an optional spec-level `loop`: re-run the whole stage
  list until a stop condition (`{ gate: true }` — a human loop gate at each iteration
  boundary — or `{ criterion: '<key>' }`, a runner-evaluated predicate), hard-capped by
  `maxIterations`.
- `MAX_STAGES` (12) — hard cap on stages per spec, `MAX_PIPELINE_DEPTH` (8) — hard cap
  on nested-pipeline depth, `MAX_LOOP_ITERATIONS` (10) — hard cap on a loop's
  `maxIterations`, and `MAX_SCRIPTED_STAGE_CALLS` (8) — hard cap on a scripted stage's
  `calls` fan-out, chosen to stay under the bundled opencode CLI's measured concurrency
  wall (~8-16 simultaneous processes before requests start queueing behind 429/retry).
  Not overridable via `limits` — the constraint is external, not a property of any one
  pipeline's shape.
- `validateStageList` / `validatePipelineSpec` / `parsePipelineSpec` — structural
  validation of a stage list, the full-spec check (stage list + loop rules, all nesting
  levels), and parsing/validating an untrusted `PipelineSpec` from JSON.

## Example

```ts
import type { PipelineSpec } from '@workflow-toolbox/pipeline-spec'

const spec: PipelineSpec = {
  goal: 'ship the feature end to end',
  projectDir: '/abs/path/to/repo',
  stages: [
    { name: 'plan', workflow: 'dev-plan', gateAfter: true },
    {
      name: 'implement',
      workflow: 'dev-implement',
      input: { planArtifact: { from: 'artifactPath' } },
    },
  ],
}
```

## Docs

- [Pipeline authoring reference](../../../plugin/skills/workflow-composer/references/orchestrator-pipelines.md)
  — the full authoring guide, including `definePipeline()` and the build/check loop.
- [ADR 0008](../../../docs/public/adr/0008-pipeline-authoring-surface-vocabulary.md) — why
  pipeline vocabulary is kept distinct from the sandbox `pipeline()` primitive.
- [toolkit/README.md](../../README.md) — the workflow authoring contract this composes
  with.

## License

FSL-1.1-ALv2 — see [LICENSE](../../../LICENSE).
