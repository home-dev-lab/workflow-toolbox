# @workflow-toolbox/patterns

Nine tested orchestration patterns for Claude Code's Workflow tool — classify-and-act,
fan-out, adversarial verification, generate-and-filter, tournament, loop-until-done,
plan-and-execute, score-and-rank, chunked-analysis — plus the shared result envelope they
all return. Ordinary async TypeScript functions, not a DSL: you call them with `await`
inside a workflow's `run(rt, input)`.

Every pattern returns an audit envelope — `value`, `warnings`, `stats`, a deterministic
`trail` — so truncation and dropped work are always visible, never silent.

## Install

```bash
pnpm add @workflow-toolbox/patterns @workflow-toolbox/runtime
```

## The nine patterns

`classifyAndAct`, `fanOutAndSynthesize`, `adversarialVerification`, `generateAndFilter`,
`tournament`, `loopUntilDone`, `planAndExecute`, `scoreAndRank`, `chunkedAnalysis`. Each
documents its own **when to use / when not to** — see the pattern table linked below
rather than duplicating it here.

Also included: `withLeafFence` / `withLeanRouting` (agent-default wrappers that route
fresh-context worker/reasoning-only roles to a minimal-ambient-context agent type),
`probeAgentType` (check whether a named agent type is actually callable before routing to
it), `isExternalBridgeType` (the SAME registry `adversarialVerification` uses to decide
whether a routed `verifierType` is an external CLI relay — opencode/codex — vs a Claude
specialist, exposed as a narrow boolean so a composition author can reuse it for their own
wrapper-model gating instead of re-deriving the answer), and small envelope helpers
(`collectTrail`, `applyCap`, `warn`, `emitDigest`).

## Example

```ts
import type { WorkflowRuntime } from '@workflow-toolbox/runtime'
import { fanOutAndSynthesize } from '@workflow-toolbox/patterns'

async function review(rt: WorkflowRuntime, target: string) {
  const result = await fanOutAndSynthesize<string>(rt, {
    tasks: ['correctness', 'security', 'readability'],
    taskPrompt: (lens) => `Review ${target} for ${lens}. List concrete issues.`,
    synthesisPrompt: (parts) => `Merge these into one verdict:\n${parts.join('\n\n')}`,
    phase: 'Review',
  })
  return { verdict: result.value, warnings: result.warnings, stats: result.stats }
}
```

A fuller composition — classify, fan out reviewers, adversarially verify the findings,
synthesize — is `worked-example-pr-review.md`, linked below.

## Docs

- [toolkit/README.md](../../README.md) — the full pattern table (when to use / when not
  to) and the result envelope contract.
- [Pattern reference](../../../plugin/skills/workflow-composer/references/patterns.md) and
  [worked PR-review example](../../../plugin/skills/workflow-composer/references/worked-example-pr-review.md).
- [Architecture](../../../docs/public/architecture.md) — the design principles these
  patterns are built against.

## License

FSL-1.1-ALv2 — see [LICENSE](../../../LICENSE).
