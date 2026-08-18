# @workflow-toolbox/pipeline-spec

The declarative `PipelineSpec` authoring and validation surface: pure data shapes plus
synchronous structural validation, with **zero dependencies**. A pipeline chains several
workflows together with a human-approval gate between stages, independent of any
particular runner.

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
- `StageSpecV2` — one stage: which workflow to run or which nested sub-pipeline to
  recurse into (exactly one of `workflow` / `pipeline`), how to build its args from
  prior state (`input`), how to extract its handoff artifact for the next stage, and
  whether a human gate follows it (`gateAfter`).
- `InputRef` — a declarative reference to a runtime value pulled in at launch,
  restricted to `INPUT_REF_SOURCES` (`'artifactPath' | 'goal' | 'projectDir' |
  'artifactContent'` — the last resolves to the prior stage's handoff artifact read
  off disk as text, as opposed to `'artifactPath'`, which resolves to the path
  itself).
- `ExtractorKey` — the named handoff-artifact extractor a stage selects, restricted to
  `EXTRACTOR_KEYS`.
- `PipelineLoopSpec` / `LoopUntil` — an optional spec-level `loop`: re-run the whole
  stage list until a stop condition (`{ gate: true }` — a human loop gate at each
  iteration boundary — or `{ criterion: '<key>' }`, a runner-evaluated predicate),
  hard-capped by `maxIterations`.
- `MAX_STAGES` (12) — default cap on stages per spec, `MAX_PIPELINE_DEPTH` (8) —
  default cap on nested-pipeline depth, and `MAX_LOOP_ITERATIONS` (10) — default cap
  on a loop's `maxIterations`.
- `validateStageList` / `validatePipelineSpec` / `parsePipelineSpec` — structural
  validation of a stage list, the full-spec check (stage list + loop rules, all
  nesting levels), and parsing/validating an untrusted `PipelineSpec` from JSON.

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
