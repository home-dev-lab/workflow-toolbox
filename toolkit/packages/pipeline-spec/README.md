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
- `StageSpecV2` — one stage: which workflow to run (or a nested sub-pipeline), how to
  build its args from prior state (`input`), how to extract its handoff artifact for the
  next stage, and whether a human gate follows it (`gateAfter`).
- `InputRef` — a declarative reference to a runtime value pulled in at launch, restricted
  to `INPUT_REF_SOURCES` (`'artifactPath' | 'goal' | 'projectDir'`).
- `ExtractorKey` — the named handoff-artifact extractor a stage selects, restricted to
  `EXTRACTOR_KEYS`.
- `MAX_STAGES` (12) — hard cap on stages per spec, and `MAX_PIPELINE_DEPTH` (8) — hard cap
  on nested-pipeline depth.
- `validateStageList` / `parsePipelineSpec` — structural validation of a stage list, and
  parsing/validating an untrusted `PipelineSpec` from JSON.

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
