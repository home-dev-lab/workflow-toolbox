# @workflow-toolbox/build

`defineWorkflow` + `definePipeline` (the authoring API), and the `workflow-toolbox` CLI
that bundles a TypeScript entry file into the single self-contained `.js` artifact the
Workflow tool runs directly.

## Install

```bash
pnpm add -D @workflow-toolbox/build @workflow-toolbox/runtime @workflow-toolbox/patterns
```

## The CLI

```bash
workflow-toolbox build <entry.workflow.ts> [--out-dir <dir>] [--minify] [--typecheck]
workflow-toolbox check <artifact.js>
workflow-toolbox pipeline <entry.pipeline.ts> [--out-dir <dir>] [--out <name>] [--minify]
workflow-toolbox scaffold <spec.json>
workflow-toolbox debug <runId>
workflow-toolbox report <runId>
```

- `build` bundles a workflow entry (esbuild) into a byte-deterministic `.js` artifact —
  the emitted `meta` is serialized as a pure literal first statement, imports/Node APIs
  are stripped, and the sandbox linter runs on the output before it's written.
- `check` runs the standalone sandbox linter against any artifact (meta-first, banned
  APIs, the 512 KB size cap) — useful for a hand-edited or externally-produced `.js`.
- `pipeline` bundles a declarative pipeline entry (see `@workflow-toolbox/pipeline-spec`)
  the same way `build` bundles a workflow.
- `scaffold` generates a workflow or agent skeleton from a JSON spec.
- `debug` / `report` read a run's journal and print a diagnosis / audit report.

## The library API

`defineWorkflow` validates a workflow's `meta` at call time (before the workflow ever
runs) and binds the ambient sandbox globals into a typed `rt: WorkflowRuntime` parameter.

```ts
// my-workflow.workflow.ts (filename = meta.name, by convention)
import { defineWorkflow } from '@workflow-toolbox/build/define' // NOT '@workflow-toolbox/build' — see below
import type { WorkflowRuntime } from '@workflow-toolbox/runtime'
import { fanOutAndSynthesize } from '@workflow-toolbox/patterns'

export default defineWorkflow({
  meta: {
    name: 'my-workflow',
    description: 'One line, shown in the permission dialog',
    phases: [{ title: 'Review' }],
  },
  parseInput: (raw): { target: string } => {
    if (typeof raw?.target !== 'string') {
      throw new Error('Pass { "target": "<git ref range or change description>" }')
    }
    return { target: raw.target }
  },
  run: async (rt: WorkflowRuntime, input) => {
    const review = await fanOutAndSynthesize<string>(rt, {
      tasks: ['correctness', 'security', 'readability'],
      taskPrompt: (lens) => `Review ${input.target} for ${lens}.`,
      synthesisPrompt: (parts) => `Merge:\n${parts.join('\n\n')}`,
    })
    return { verdict: review.value, warnings: review.warnings }
  },
})
```

> **Import `defineWorkflow` from `@workflow-toolbox/build/define`, never from the package
> root.** The root export also re-exports the Node-side bundler (`node:vm`, esbuild); a
> workflow ENTRY file that imports from the root drags those into the sandbox-bound bundle
> and the build fails with an actionable error.

`lintWorkflowSource` (the linter `check` runs) and `bundleWorkflow` (the bundler `build`
runs) are also exported directly, for tooling that wants to lint or bundle without
shelling out to the CLI.

## Docs

- [toolkit/README.md](../../README.md) — the authoring contract, the build → check →
  launch loop, and the pattern library.
- [API reference](../../../plugin/skills/workflow-composer/references/api-reference.md) —
  the full sandbox contract and caps.
- [Pipeline authoring reference](../../../plugin/skills/workflow-composer/references/orchestrator-pipelines.md)
  — `definePipeline` and the pipeline build loop.

## License

FSL-1.1-ALv2 — see [LICENSE](../../../LICENSE).
