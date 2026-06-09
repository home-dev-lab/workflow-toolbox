---
name: workflow-composer
description: >-
  Write and debug workflow scripts for Claude Code's Workflow tool: single .js
  files in which deterministic JavaScript drives fleets of fresh-context
  subagents through agent(), parallel(), pipeline(), and phase(). Invoke for any
  request to build, generate, draft, repair, or restructure such a workflow
  ("I want a workflow that…", "turn this process into a workflow", "set up a
  multi-agent pipeline for X", editing files under .claude/workflows/), for
  questions about the script format — the meta literal, the orchestration
  primitives, structured-output schemas, the no-nondeterminism rules — and for
  diagnosing a workflow that launched with an error or produced wrong output.
  Fire it too when a request merely DESCRIBES a repeatable multi-stage or
  fan-out job that deserves packaging as a workflow, with or without the word.
  Teaches the bundled @workflow-toolbox TypeScript pattern toolkit as the standard library
  for workflows that will be kept and maintained. Out of scope: simply
  launching an already-written workflow, and one-shot jobs a single subagent
  handles.
---

# Authoring workflows for Claude Code's Workflow tool

A workflow moves a multi-step plan out of the conversation and into code. Normally
Claude is the orchestrator: it decides turn by turn what subagent to spawn, and
every intermediate result lands back in its context. A workflow inverts that — a
script holds the plan, the runtime executes it in isolation, and intermediate
results stay in script variables. Only the leaf `agent()` calls spend model
tokens; the loops, conditionals, and fan-out are plain deterministic JavaScript.

There are **two ways to author one**, and choosing correctly is the first decision:

- **Toolkit path (`@workflow-toolbox`)** — for workflows that will be **kept, re-run, and
  maintained**. You write a typed TypeScript file against a tested pattern library
  and compile it to a self-contained `.js` artifact. This is the default for
  anything repeatable. See [the toolkit path](#the-toolkit-path-repeatable-workflows).
- **Raw `.js` path** — for **one-offs**, for shapes that fit none of the patterns,
  or when the toolkit's build chain is not available. You hand-write the orchestrator
  directly against the runtime globals. See [the raw path](#the-raw-authoring-path-one-offs).

Two reference files carry the deep material — read them when a step points you there:

- `references/api-reference.md` — every global, option, cap, and constant, each
  tagged with its evidence tier (documented / observed / verified).
- `references/patterns.md` — the seven orchestration patterns as copy-paste recipes.

## Does a workflow even fit?

Reach for a workflow only when the orchestration is genuinely **deterministic** — a
predefined code path where the model's judgment is needed only at the leaves. Good
fits:

- **Multi-agent fan-out** — the same analysis applied across many items (files,
  repo areas, findings) where each unit runs in its own fresh context. ("Fresh" =
  fresh of the *conversation*: an agent can't see the chat or the script's variables,
  so pass task data in the prompt — but it DOES load `CLAUDE.md`/memory/skills, so it
  already follows project conventions. See [api-reference.md](references/api-reference.md) `agent()`.)
- **Deterministic control flow** — routing, staged pipelines, verify-then-synthesize
  shapes you can express in `if`/`for`/`await`.
- **Scale** — dozens to hundreds of subagents under one plan, where keeping
  intermediate output out of the conversation is the whole point.

If the task is a **single one-off** — one analysis, one refactor, one question — a
plain subagent (or just answering directly) is simpler and correct. Do not package a
single `agent()` call as a workflow. A workflow earns its overhead through fan-out,
determinism, or scale; absent all three, skip it.

## The toolkit path (repeatable workflows)

If the workflow will be **kept, re-run, and maintained** — not a one-off — do not
hand-write the orchestration. This repository ships a compile-time TypeScript pattern
library, the **`@workflow-toolbox` toolkit**, at `toolkit/` (a sibling of this plugin's directory
in the repo / marketplace clone). It packages the seven orchestration patterns as
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
    phases: [{ title: 'Route' }, { title: 'Verify' }],
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
> the sandbox bundle. `dwt build` pre-flights this mistake with an actionable error.
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

### Build → check → launch

Run from `toolkit/`; paths are toolkit-relative, default out-dir is `workflows/`:

```bash
pnpm dwt:build examples/my-workflow.workflow.ts   # TS entry → self-contained .js
pnpm dwt:check workflows/my-workflow.js           # sandbox lint of the artifact
```

The artifact is named **`<meta.name>.js`** — after the workflow's `meta.name`, not
the entry filename. Keep the two identical to avoid surprises. The build emits
readable (unminified) output by default — the artifact is what users review in the
permission dialog and edit for re-invocation. `dwt build` warns from 400 KB (cap is
512 KB); an oversized workflow is usually two workflows with a checkpoint between
them.

### Four shipped compositions to read as models

Built example compositions live under `toolkit/workflows/`, with their TypeScript
sources committed for study at `assets/examples/toolkit/`:

- `pr-review.workflow.ts` — route the diff → per-lens reviewers → adversarial verify
  → synthesis.
- `monorepo-refactor-plan.workflow.ts` — fan out per area, classify, synthesize a plan.
- `monorepo-refactor-execute.workflow.ts` — execute the plan with mutating agents
  behind isolation.
- `doc-rewrite.workflow.ts` — generate-and-filter doc rewrites.

These `.ts` sources are **reading material** — they are built with `pnpm dwt:build`,
not run directly as raw workflows. Their committed artifacts live under
`toolkit/workflows/` (e.g. `toolkit/workflows/pr-review.js`) and run via
`Workflow({ scriptPath: '…/pr-review.js' })`.

## The raw authoring path (one-offs)

Hand-write the `.js` when the job is a one-off, fits none of the seven patterns, or
the toolkit's build chain is unavailable.

### File anatomy

**1. `meta` first, pure literal.** The very first statement must declare `meta` as a
plain object literal — no variables, function calls, spreads, or template strings
inside it, and nothing before it:

```js
export const meta = {
  name: 'review-changes',                          // required, non-empty, kebab-case
  description: 'Review the change set and verify each finding',  // required; shown in dialog
  phases: [{ title: 'Collect' }, { title: 'Decide' }],          // optional, one per phase()
};
```

A `model` on a `phases[]` entry is a label for the permission dialog only — it does
**not** set the runtime model. The model is set solely by the `model` option on the
`agent()` call.

**2. The body — top-level async.** After `meta`, the body is plain top-level `async`
code that `await`s the runtime globals and **returns** the result value. The
orchestrator has no filesystem or shell — file/Bash work happens *inside* an
`agent()`, where the subagent has the normal tools.

The globals: `agent(prompt, opts?)`, `parallel(thunks)`, `pipeline(items, ...stages)`,
`phase(title)`, `log(message)`, `budget`, `workflow(nameOrRef, args?)`, `args`. Full
signatures and option tables are in `references/api-reference.md`.

### Choosing the topology

| Want | Shape | Primitive |
|---|---|---|
| Each item flows on its own through stages | **pipeline (default)** | `pipeline(items, stageA, stageB)` |
| A later stage needs *all* items together (dedup, ranking, total count, "stop once N") | **barrier** | `parallel(thunks)` then cross-item logic |
| Iterate an unknown number of rounds until the work runs dry | **loop** | `while` with a **typed** stop condition |

Default to **pipeline** — a fast item reaches the last stage while a slow one is still
in the first; nobody idles. Only insert a `parallel()` barrier for a genuine
cross-item need. Use a **loop** only when iteration adds value and the size is unknown
up front (a known fixed list is just a `map`), and give every loop a hard stop — a
counter (`while (found < 10)`) or a budget guard (`while (budget.total && budget.remaining() > 50_000)`).

### Schemas and model tiering

- **Schema at every consumed boundary.** Put a `schema` (JSON Schema) on any
  `agent()` whose result a later line reads a field off. Without it the agent returns
  free text and `r.field` is silently `undefined`. Free text is fine only when the
  whole string is passed into the next prompt. See `references/api-reference.md` for
  the structured-output contract.
- **Model tiering.** Mechanical, high-volume leaf work → `model: 'haiku'`. Judgment
  work → inherit the session model (omit `model`). **Verifiers default to the strong
  model** — verification quality is model-sensitive, and a downgraded verifier is the
  one place a cheap model costs you correctness.

### Starting points

- **Templates** (skeletons to fill in): `assets/templates/fan-out.template.js`,
  `pipeline.template.js`, `loop.template.js`.
- **Runnable raw examples** (complete, working): `assets/examples/verify-findings.js`
  (refute-first triple-verification of claims passed via `args`) and
  `assets/examples/repo-health-snapshot.js` (fan-out per repo area + synthesis barrier).

## Validate before you run

Lint the file against the parser's hard rules **before** spending a run:

```bash
node scripts/validate-workflow.mjs <path-to-workflow.js>
```

It checks the 512 KB size limit, the `meta`-first / pure-literal rule, the required
`name`/`description` fields, and the banned non-deterministic / host-API calls
(`Date.now`, `Math.random`, argless `new Date()`, `require`). **Exit 0 = clean**
(warnings allowed); **exit 1 = errors** — fix them before launching. The CLI prints
`  ERROR <message>` per error and `  warn: <message>` per warning.

## Run, watch, iterate

Launch via the Workflow tool, then keep two non-negotiable habits:

- **Right after install, use `scriptPath`** — `Workflow({ scriptPath: "..." })`
  always resolves, no registration needed. The `name` registry (keyed by `meta.name`,
  not the filename) refreshes **lazily** mid-session and silently excludes files over
  512 KB, so a freshly written workflow may not be findable by name yet. Plugin-shipped
  workflows resolve as `plugin-name:workflow-name`.
- **Always check `WorkflowOutput.error`.** A script that fails its syntax check still
  returns `status: "async_launched"` with `error` set — and **never runs**. Silence is
  not success. Watch live progress with `/workflows`.
- **On partial failure, relaunch with `resumeFromRunId`.** Completed `agent()` calls
  replay from the journal cache (same session only); only missing or failed work
  re-runs — no redoing finished analysis.

## Gotchas — check every one before handing over the file

1. **Determinism bans.** The sandbox throws on `Date.now()`, `Math.random()`, and
   `new Date()` without arguments — all three would make a resumed run diverge from
   its journal. Need a timestamp? Accept it through `args` and attach real dates once
   the workflow has returned. Need per-agent variation? Derive it from the loop
   index. An explicit `new Date(someValue)` stays legal.
2. **No filesystem, shell, or imports in the orchestrator.** No `require`, `fs`,
   `process`, `import`. Any file read/write/Bash work belongs **inside an `agent()`** —
   the subagent has the normal tools; the script does not.
3. **Thunks, not live promises, in `parallel()`.** Wrap every call:
   `parallel([() => agent('a'), () => agent('b')])`. Passing the result of calling
   `agent()` directly means each one fires the moment the array is built — the
   runtime's concurrency limiter never gets a say.
4. **Expect holes in result arrays.** When an item's agent dies, gets skipped by the
   user, or falls to the budget, `parallel()`/`pipeline()` hand you `null` in that
   position rather than rejecting. Run `.filter(Boolean)` before consuming — and
   **tally how many you filtered**, so lost coverage shows up in the output instead
   of disappearing.
5. **`meta` is a pure literal and the first statement.** No dynamic values, no code
   before it.
6. **Budget Infinity trap.** With no target set, `budget.total` is `null` and
   `budget.remaining()` is `Infinity`. An open-ended loop guarded only by
   `remaining()` never stops and sprints into the 1,000-agent lifetime cap, which
   throws. Floor any budget-driven loop with `budget.total &&` first.
7. **`isolation: 'worktree'` costs real time and disk** (~200–500 ms setup per
   agent). Reserve it for the one case that needs it: several agents writing to the
   repo at once, where shared files would corrupt each other's work.
8. **Trust no agent's self-report.** An agent that hits its context limit dies
   mid-reasoning, and its last text arrives as a **normal-looking completion**. Defend
   in layers: (a) put a `schema` on every result a later line reads a field off —
   catches truncation and shape drift; (b) add a **fresh-evidence checker stage** — a
   *separate* agent that re-verifies the producer's claims against the actual source
   (files, command output, the diff), never against its summary, with refute-first
   framing to kill plausible-but-wrong findings; (c) keep each agent's scope small
   enough to finish well inside its window — oversized scopes are the root cause of
   mid-reasoning death; (d) always check `WorkflowOutput.error` after launching, and
   resume with `resumeFromRunId` instead of re-running finished work.

## Worked example: the `pr-review` shape

Read the full source at `assets/examples/toolkit/pr-review.workflow.ts` (bundled with
this skill; the same file lives at `toolkit/examples/pr-review.workflow.ts` in the
repo). It is the canonical
illustration of every defence layer above. Five stages, each shaped by *why*:

**1. Classify the change.** `classifyAndAct` routes the target into one of
`feature | bugfix | refactor | config | docs`, then runs a category-specific summary
agent. The route must succeed — no category means classification failed entirely, so
the workflow throws rather than reviewing blind:

```ts
const routeResult = await classifyAndAct(rt, {
  items: [input.target],
  categories: ['feature', 'bugfix', 'refactor', 'config', 'docs'],
  classifyPrompt: (t) => `Classify this change into exactly one category…\n${t}`,
  actions: { /* one schema'd summary prompt per category */ },
  phase: 'Route',
})
const routed = routeResult.value[0]
if (routed === undefined) throw new Error('pr-review: classification failed…')
```

**2 + 3. Review then Verify — pipeline form, no barrier.** Each lens gets its own
reviewer whose findings flow straight into its own adversarial verifier. A barrier
here would be wrong: Verify needs *one* reviewer's findings at a time, not all of
them. Each reviewer carries a `schema` (defence a) and is told to **re-derive from the
actual diff, not the summary** (defence b); one reviewer per lens keeps scopes small
(defence c). A reviewer that dies returns `null` → the lens is skipped and counted:

```ts
const reviewStage = (lens) => rt.agent(
  `Review the "${lens}" aspect. Read the ACTUAL change — do NOT trust the summary…`,
  { schema: FINDINGS_SCHEMA, label: `pr-review:reviewer:${lens}`, phase: 'Review' },
)
const verifyStage = (prev, lens) => {
  if (prev === null) { dropped++; return null }   // reviewer died — count it
  return adversarialVerification(rt, /* re-derive each finding from the diff */)
}
```

**4. Synthesize — a genuine barrier.** Synthesis needs *all* verified findings from
*all* lenses, so this is the one place a barrier is correct. Only non-`refuted`
findings flow in: `unverifiable` means a verifier failed, not that the finding is
wrong, so those are **kept and flagged** rather than dropped. Synthesis is the final
gate — if it fails, throw with a resume hint:

```ts
rt.phase('Synthesize')
const synthesis = await rt.agent(
  `Synthesize a verdict over these verified findings:\n${JSON.stringify(findings)}…`,
  { schema: SYNTHESIS_SCHEMA, label: 'pr-review:synthesize', phase: 'Synthesize' },
)
if (synthesis === null) throw new Error('pr-review: synthesis failed — resume from the Synthesize phase…')
```

**5. Return an honest envelope.** The result carries `verdict` and `summary` plus
`stats` (reviewers spawned, findings raw/verified/refuted, dropped) and `warnings`.
Counting is a **code** responsibility, never the model's — tally
succeeded/failed/dropped in JavaScript so the caller always knows when coverage shrank.

## Learning more

- `references/api-reference.md` — the evidence-tiered runtime reference: every global,
  option, cap, and failure mode, each tagged documented / observed / verified.
- `references/patterns.md` — the seven orchestration patterns as copy-paste recipes.
