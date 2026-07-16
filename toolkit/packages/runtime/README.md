# @workflow-toolbox/runtime

Type definitions for Claude Code's Workflow tool sandbox, plus `FakeRuntime`, a
deterministic in-memory implementation for unit-testing workflow compositions offline —
no live agents, no network, no Claude Code process.

This is the toolkit's **only** coupling point to the Workflow tool: `WorkflowRuntime` and
its companion types (`AgentOptions`, `ModelAlias`, `EffortAlias`, `Budget`,
`PipelineStage`) describe the `rt` parameter every workflow's `run(rt, input)` receives —
`agent()`, `pipeline()`, `parallel()`, `phase()`, budgets, and model/effort aliases. You
depend on this package to type-check a workflow composition or a pattern function against
that contract; `@workflow-toolbox/build`'s `defineWorkflow` binds the real sandbox globals
into it at build time.

## Install

```bash
pnpm add @workflow-toolbox/runtime
```

## What's in it

- **Sandbox types** — `WorkflowRuntime`, `AgentOptions`, `AgentFn`, `PipelineStage`,
  `PipelineFn`, `ParallelFn`, `Budget`, `WorkflowFn`, `ModelAlias`, `EffortAlias`,
  `JsonSchema`.
- `BEST_MODEL`, `MODEL_ALIASES` — the strongest reliably-callable model alias and the full
  alias table. Alias availability is environment/time-dependent; an uncallable alias
  errors at runtime, so pattern defaults resolve through `BEST_MODEL` rather than a
  hardcoded name.
- `FakeRuntime` — a scriptable `WorkflowRuntime` for tests: feed it a response queue or an
  `onAgent` handler, then assert against the calls it recorded. Zero dependencies, no
  timers, no randomness.
- `withAgentDefaults` — wraps a runtime so every `agent()` call merges in a set of
  defaults (model/effort/agentType) unless the call site overrides them.
- `formatDigest` / `parseDigest` and `withPromptTags` / `parsePromptTag` — the wire
  helpers patterns use to emit structured phase digests and traceable prompt tags.

## Example — testing a workflow composition offline

```ts
import { FakeRuntime } from '@workflow-toolbox/runtime'
import { fanOutAndSynthesize } from '@workflow-toolbox/patterns'

const rt = new FakeRuntime({ responses: ['finding A', 'finding B', 'merged verdict'] })

const result = await fanOutAndSynthesize<string>(rt, {
  tasks: ['correctness', 'security'],
  taskPrompt: (lens) => `Review for ${lens}.`,
  synthesisPrompt: (parts) => `Merge:\n${parts.join('\n')}`,
})

console.log(result.value) // "merged verdict"
console.log(rt.calls.length) // 3
```

## Docs

- [toolkit/README.md](../../README.md) — the authoring contract, the pattern table, the
  result envelope.
- [Architecture](../../../docs/public/architecture.md) — the evidence-tiered runtime
  facts and the runtime/toolkit responsibility split.

## License

FSL-1.1-ALv2 — see [LICENSE](../../../LICENSE).
