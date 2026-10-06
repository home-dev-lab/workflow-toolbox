This reference belongs to the workflow-composer skill. Its text moved here verbatim from that skill's SKILL.md, so every path and link in it means what it meant there: a link to another reference file resolves from the skill directory (the parent of this references/ folder), and a project or repository path keeps its own base.

## The toolkit path (repeatable workflows)

If the workflow will be **kept, re-run, and maintained** — not a one-off — do not
hand-write the orchestration. The **`@workflow-toolbox` toolkit** is a compile-time
TypeScript pattern library, published to npm as `@workflow-toolbox/{runtime,patterns,build}`
(its source lives at `toolkit/` in this plugin's repo / marketplace clone). It packages
the nine orchestration patterns as
typed, tested functions and compiles each workflow into a self-contained `.js`
artifact:

`classifyAndAct` · `fanOutAndSynthesize` · `adversarialVerification` ·
`generateAndFilter` · `tournament` · `loopUntilDone` · `planAndExecute`

**Read `toolkit/README.md`** for the use/don't-use table, the composition rules, and
the result envelope — every pattern returns a deterministic `trail` audit field
alongside its `value`/`stats`/`warnings`.

### Authoring contract

A workflow definition is one TypeScript file that default-exports `defineWorkflow`:

```ts
// my-workflow.workflow.ts  (filename = meta.name, by convention)
import { defineWorkflow } from '@workflow-toolbox/build/define'   // ⚠ NOT '@workflow-toolbox/build' — see below
import type { WorkflowRuntime, JsonSchema } from '@workflow-toolbox/runtime'
import { classifyAndAct, adversarialVerification } from '@workflow-toolbox/patterns'

export default defineWorkflow({
  meta: {
    name: 'my-workflow',                  // kebab-case, validated at call time
    description: 'One line, shown in the permission dialog',
    phases: [{ title: 'Route' }, { title: 'Verify' }], // per phase: title + optional detail, model
  },
  // Optional: validate/normalize the (JSON-decoded) args into typed input.
  // Throw with an actionable message on bad input — fail fast, before any agent.
  parseInput: (raw) => { /* … */ },
  run: async (rt: WorkflowRuntime, input) => {
    return { /* the workflow's result */ }
  },
})
```

`defineWorkflow` does exactly three things: build-time `meta` serialization, `args`
normalization (string args arrive JSON-encoded) plus fail-fast input validation, and
binding the ambient sandbox globals into the typed `rt` parameter. No lifecycle
hooks, no middleware.

> **⚠ Import `defineWorkflow` from `@workflow-toolbox/build/define`, never `@workflow-toolbox/build`.** The
> package root re-exports the bundler (node:vm, esbuild) and drags Node-only code into
> the sandbox bundle. `workflow-toolbox build` pre-flights this mistake with an actionable error.
> Patterns come from `@workflow-toolbox/patterns`; types from `@workflow-toolbox/runtime`.

### Composition rules

These are the rules the library follows; follow them in your own `run` body:

1. **`pipeline` by default between stages; `parallel` only for genuine cross-item
   needs** (dedup, merge, count-based early-exit). A barrier wastes the fast items'
   idle time.
2. **Schema at every consumed boundary** — any agent result a later line reads a
   field off must carry a `schema`. Free text only when passed whole into another
   prompt.
3. Data crosses agent boundaries as **prompt text** (`JSON.stringify` into the next
   prompt) — the orchestrator shares no memory with subagents.
4. Every loop has a **typed stop condition** — `maxIterations`, `dryRounds`, or
   `budgetFloor`; omission is a compile error.
5. Parallel **mutating** agents require `isolation: 'worktree'` (expensive; never for
   read-only analysis); mutating compositions sit behind a human checkpoint.
6. Write every agent prompt as **structured markdown** — `##` sections (Role /
   Context / Instructions / Output), bullet lists for enumerations (never
   `join(', ')` of whole sentences), fenced ` ```json ` blocks for embedded data.
   Transcript viewers render prompts as markdown, where a single `\n` does NOT
   start a new paragraph: a `\n`-joined prompt reads back as one unscannable wall
   of text (user finding on pr-review, 2026-07-08). Structure also helps the
   receiving agent parse the brief.
7. **Consider the `cacheWarm` trade-off on any fan-out pattern call** (the eight
   patterns that launch >1 agent concurrently — see "Cache-warm" in
   [references/patterns-execution.md](references/patterns-execution.md)). It defaults to `true` (staggers the burst to save
   redundant prompt-cache writes, at the cost of a bit more latency per burst).
   When it's not obvious which way a workflow should go, ASK: does latency or
   token/cache cost matter more here? Set `cacheWarm: false` on that call if the
   answer is latency.
8. **Fence caller-supplied text as data, not instructions.** Wrap any caller text
   embedded in a prompt with `untrusted(label, text)` (`@workflow-toolbox/patterns`)
   rather than splicing it in raw — it mangles any `<<<UNTRUSTED`/`<<<END`/`>>>`
   token already in the text so it cannot forge its own closing fence. Render a
   caller's source-file list with `renderSourceRefs(refs, opts)` from the same
   package; `opts.emptyNote`/`opts.leadIn` are your prompt's own wording, not the
   helper's. Import it — every shipped composition that embeds caller text
   (`independent-analysis`, `cross-model-verify`) does this at every embedding
   site instead of hand-rolling a copy.

### Launch-time configuration — tune model/effort/agentType without editing source

A workflow's `args` is the launch-time config channel: the author reads it in
`parseInput` and threads it into agent/pattern options, so a single committed
artifact runs at different model/effort/cost per launch (no source edit per run).
Two complementary mechanisms, both sandbox-pure:

- **Class A — blanket per-agent defaults (one wiring point).** `withAgentDefaults(rt, defaults)`
  (`@workflow-toolbox/runtime`) returns a runtime whose `agent()` merges `defaults`
  (`model`/`effort`/`agentType`/`isolation`/`stallMs`) UNDER each call's own opts.
  Wrap `rt` once at the top of `run()` and **every** agent in **every** pattern
  downstream inherits them — `parallel`/`pipeline` propagate automatically. Explicit
  per-call/per-pattern opts always **win** (these are defaults, not overrides).

- **Class B/C — per-role models/effort + sizing.** Patterns already expose per-role
  `<role>Model` / `<role>Effort` knobs (e.g. `judgeModel`, `judgeEffort`) and sizing
  knobs (`votes`, `judgeCount`, …). `parseConfig(raw)` (`@workflow-toolbox/build/define`)
  validates the conventional envelope `{ perAgent, models, effort, agentTypes, sizing,
  messaging }` into a typed `WorkflowConfig`; spread its role maps into the pattern
  options (`judgeModel: cfg.models?.judge`). It ignores unrecognized top-level keys, so
  it composes next to a workflow's bespoke args. `messaging: true` is the blanket
  opt-OUT of the toolkit's default leaf-agent fence (toolkit-spawned leaf/worker agents
  deny `SendMessage` by default) — set it only when leaves genuinely need to coordinate;
  the per-role escape hatch (`agentTypes.<role>`) covers a single role.

Layering, outer-to-inner precedence: explicit pattern knob (e.g. `verifierModel`) >
`withAgentDefaults` blanket default > session default. **`pr-review.workflow.ts` is
the worked example** — it parses `perAgent`/`effort`/`agentTypes` via `parseConfig`,
wraps once with `withAgentDefaults`, and keeps its targeted `verifierModel` knob and
its probe-resolved `agentTypes.review` / `agentTypes.verify` routing (independently
resolved, one per stage), which still win over the blanket default. Type per-role
knobs as scalars today; they can widen to a per-instance
selector (array/function) non-breaking when same-role model mixing lands (needs
cross-model dispatch).

A workflow can also declare an **observer** — and the composer should **proactively propose
one when the workflow's shape calls for it**: long-running roles, doc/spec surfaces to keep
aligned, drift across a fan-out, or a human gate each benefit from an out-of-band watcher, so
after deriving roles + needs + shape, run the suggestion check and surface it, don't wait to
be asked. It is a workflow-owned artifact (`<name>.observer.json`) emitted with `scaffold
observer` and carried at launch in `args.observers` (a sibling of `args.capabilities`). **Read
[references/observer-definitions.md](references/observer-definitions.md)** for the trigger
checklist and the authoring schema; `docs-butler` is the worked example.

A role that needs **more than the bare default** (a reviewer that reads code symbolically,
a researcher that looks up docs) declares an ABSTRACT need in a workflow-owned
`<name>.capabilities.json` sidecar the composer emits with `scaffold capabilities`, carried
at launch in `args.capabilities`. The sidecar names no concrete provider or machine tool —
its agent tool lists carry only `$cap:<need>` placeholders (plus plain built-in tools like
`Read`) that the user's machine resolves at launch, degrading to a named fallback when it
can't. **Read [references/capability-needs.md](references/capability-needs.md)** before
adding one — it covers the per-role needs derivation, the machine-agnostic emission lint,
and the adoption levers (remove the alternative + instruct at the task level).

### Orchestrator pipelines — human-gated, multi-workflow jobs

A multi-stage job with a human sign-off in the middle (plan → approve → execute)
is an orchestrator pipeline. **Read
[references/orchestrator-pipelines.md](references/orchestrator-pipelines.md)
BEFORE composing any multi-workflow job with human gates** — it carries the L3
contract (artifact handoff, re-validation, worktree isolation) and the
dev-workflow family's worked shape.

### Build → check → launch

Run from your project root, with the toolkit trio installed
(`pnpm add -D @workflow-toolbox/runtime @workflow-toolbox/patterns @workflow-toolbox/build`);
the default out-dir is `workflows/`:

```bash
npx workflow-toolbox build my-workflow.workflow.ts --typecheck   # typecheck, then TS entry → self-contained .js
npx workflow-toolbox check workflows/my-workflow.js              # sandbox lint of the artifact
```

(`pnpm exec workflow-toolbox …` is the equivalent of `npx workflow-toolbox …` in pnpm-managed projects.)

Always pass **`--typecheck`**: esbuild strips types without checking them, so a
plausible-but-wrong option name would otherwise ship silently and only fail at runtime,
inside the sandbox. `--typecheck` runs your project's **own** `typescript` first (it
warns and continues if typescript isn't installed).

> **Maintainer note (this repo):** from `toolkit/`, the same loop is
> `pnpm wt:build examples/my-workflow.workflow.ts` +
> `pnpm wt:check workflows/my-workflow.js`.

The artifact is named **`<meta.name>.js`** — after the workflow's `meta.name`, not
the entry filename. Keep the two identical to avoid surprises. The build emits
readable (unminified) output by default — the artifact is what users review in the
permission dialog and edit for re-invocation. `workflow-toolbox build` warns from 400 KB (cap is
512 KB); an oversized workflow is usually two workflows with a checkpoint between
them.

### The shipped compositions to read as models

Twenty-six shipped compositions cover every pattern in production shape. **Read
[references/shipped-compositions.md](references/shipped-compositions.md) when
picking a starting model to imitate** — each entry names the patterns it wires
and why, and the file ends with the operational lessons from production runs of
the dev-workflow family.

