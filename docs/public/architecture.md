# Architecture — workflow-toolbox

**Scope:** this document describes the system as shipped — a Claude Code plugin plus the `@workflow-toolbox` compile-time pattern toolkit, both built on top of Claude Code Dynamic Workflows (the `Workflow` tool). The toolkit sits **on** the runtime; it never replaces it.

**Evidence tiers** (used throughout, same convention as the workflow-composer skill's [api-reference](../../plugin/skills/workflow-composer/references/api-reference.md)):

- `[documented]` — stated in official Anthropic documentation (Dynamic Workflows docs, Agent SDK docs).
- `[verified]` — confirmed against the Claude Code binary by running real workflows (dates noted). Treat as **unstable surface**: a Claude Code update can change it.
- `[observed]` — publicly observable behaviour (e.g. read from bundled scripts) but not officially documented.

---

## 1. Design principles

Each principle cites its source. `[BEA]` = [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents), `[WTA]` = [Writing Tools for Agents](https://www.anthropic.com/engineering/writing-tools-for-agents), `[CB]` = [anthropic-cookbook](https://github.com/anthropics/anthropic-cookbook) patterns/agents, `[CF]` = Cloudflare Agents documentation, `[DOCS]` = official Dynamic Workflows documentation, `[SDK]` = official Agent SDK documentation.

- **P1 — Simple, composable patterns, not a framework.** "The most successful implementations weren't using complex frameworks or specialized libraries. Instead, they were building with simple, composable patterns." [BEA]. The cookbook implements all five Anthropic patterns with exactly **two helpers** (`llm_call`, `extract_xml`) and native control flow [CB]. Cloudflare deliberately did **not** ship the patterns as a typed library — they keep them as transparent functions and invest in the runtime substrate [CF]. Consequence: the toolkit is a *thin pattern layer*, not an engine.

- **P2 — Patterns are workflows, not agents.** Anthropic distinguishes "workflows — LLMs and tools orchestrated through predefined code paths" from "agents — LLMs dynamically direct their own processes" [BEA]. Dynamic Workflows is precisely the "predefined code paths" form: deterministic JS orchestration, model only at the leaves [DOCS]. The SDK docs position it as the scale-up path: "Subagents work well for a few delegated tasks per turn. For runs that coordinate dozens to hundreds of agents, use the Workflow tool" [SDK]. The toolkit targets the workflow side exclusively.

- **P3 — Composition is plain control flow.** The cookbook composes via `for`, `dict` lookup, `while True`, `ThreadPoolExecutor` [CB]; Cloudflare composes via `Promise.all`, `while`, dictionary routing [CF]. Consequence: the toolkit's composition model is **ordinary async TypeScript**, never a graph DSL or fluent builder.

- **P4 — The runtime owns durability, concurrency, and state; pattern code stays pure.** Cloudflare's split: platform owns durable execution, retries, scheduling, state; pattern code owns the LLM call graph, prompts, schemas [CF]. Claude Code's runtime owns: journal + resume caching, concurrency caps (16 concurrent / 1000 lifetime), per-agent stall retries, budget enforcement, structured-output validation (AJV with retry — observed on CC 2.1.170 as in-conversation nudges of the same agent, with `agent()` throwing if never satisfied), permission UI [DOCS] `[verified]`. The toolkit reimplements **none** of these.

- **P5 — Contracts via small, required-tight schemas at every consumed boundary.** Structured output through JSON Schema is how data crosses the agent boundary `[observed]` — the pr-review example uses `{schema}` throughout. The cookbook's XML-tag parsing is the same idea with weaker enforcement [CB]; the toolkit uses the runtime's schema mechanism, which is strictly better (validated, retried).

- **P6 — Add complexity only when it demonstrably improves outcomes.** "Find the simplest solution possible… This might mean not building agentic systems at all." [BEA]. Consequence: every pattern documents *when NOT to use it*, and the toolkit ships the smallest viable surface — nine patterns, each one earned against this bar.

- **P7 — ACI (agent-computer interface) discipline applies to pattern APIs.** From [WTA]: unambiguous parameter names, high-signal returns, token efficiency (pagination/truncation **with explicit reporting**, never silent), error messages that state the specific corrective action. These govern the pattern functions' options and result envelopes.

- **P8 — Human-in-the-loop happens *between* workflows, not within.** Official docs: no mid-run user input; "run each stage as its own workflow for sign-off between stages" [DOCS]. Cloudflare needed a durable-execution product (`waitForApproval`, days-long pauses) to do in-flight HITL [CF] — Dynamic Workflows has no equivalent, and the toolkit doesn't build one. Checkpoints = workflow boundaries + artifacts passed via `args`.

- **P9 — Verification is adversarial and refute-first.** The Dynamic Workflows announcement's headline use case is "adversarial agents working to break the result before you see it"; the pr-review example uses 3 votes per claim, ≥2 refutations kill, default-refute-when-uncertain `[observed]`. The `@workflow-toolbox` pattern envelope adds the keep-unverified-rather-than-drop rule and deterministic tallying in code.

---

## 2. What belongs where

### 2.1 Responsibility split

| Concern | Owner |
|---|---|
| Agent execution, fresh contexts, tool access | **Runtime** |
| Concurrency caps, queuing, stall retries | **Runtime** |
| Journal, resume, result caching | **Runtime** |
| Budget enforcement (hard ceiling) | **Runtime** |
| Structured-output validation + retry (AJV) | **Runtime** |
| Permission, progress UI (`/workflows`), skip/retry | **Runtime** |
| Model alias resolution | **Runtime** |
| Pattern definitions (typed functions) | **Toolkit** |
| Input/output contracts (schemas + envelopes) | **Toolkit** |
| Composition idioms + example compositions | **Toolkit** |
| Guardrails that are *policy* (stop conditions, coverage reporting, refute thresholds) | **Toolkit** |
| Build: TS → self-contained workflow `.js` artifact | **Toolkit** (`@workflow-toolbox/build`) |
| Static validation (linter, banned APIs, size, meta shape) | **Toolkit** (`lintWorkflowSource`); the plugin ships a standalone CLI derivation (`validate-workflow.mjs`), parity-tested against it |
| Authoring guidance for Claude | **Plugin skills** (workflow-composer, toolkit-scaffold) |

Explicitly **NOT built**: retry layers, caching layers, a scheduler, a state store, a graph/DAG engine, a prompt-templating framework, in-flight HITL.

### 2.2 Evidence status of the runtime surface (honesty table)

| Runtime capability | Status |
|---|---|
| What workflows are, save locations, `/name` invocation, 16/1000 caps, no mid-run input, no script FS/shell access, `args` global | `[documented]` |
| Workflow tool I/O schema (`script/name/scriptPath/args/resumeFromRunId`; `scriptPath` precedence; persist-and-edit loop), `meta` must be a literal first statement with `{ name, description, phases }`, the four primitives `agent()/parallel()/pipeline()/phase()`, resume caching (unchanged `agent()` calls cached, same session only), async-launch output (`status/taskId/runId/transcriptDir/error`), availability in the TS Agent SDK ≥ v0.3.149, research-preview status (Claude Code ≥ v2.1.154; all paid plans; Bedrock/Vertex/Foundry; Pro opt-in via `/config`; enterprise kill-switch) | `[documented]` |
| `{schema}` structured output usage, `whenToUse` meta field | `[observed]` |
| `agent()` options `label/model/agentType/isolation/stallMs`, `log()`, `budget`, `workflow()` nesting (1 level), determinism bans (`Date.now`/`Math.random`/argless `new Date()`), journal cache keys, 512 KB script cap, stall timeout | `[verified]` (2026-06) — treat as **unstable surface** |
| Plugins registering a `workflows/` dir (namespaced `plugin:name` invocation) | `[verified]` (2026-06), undocumented |

**Engineering consequence:** everything `[verified]`-only is isolated behind a single typings package (`@workflow-toolbox/runtime`). If a Claude Code update changes the surface, exactly one package changes. This is the **stability firewall** ([ADR 0004](adr/0004-explicit-runtime-parameter.md)).

### 2.3 Facts verified by running real workflows (2026-06)

These started as engineering assumptions and were confirmed live against the Claude Code binary; all are `[verified]` tier:

- **Bundling is the bridge.** Workflow scripts cannot `import` anything (sandboxed, no Node APIs), so a TypeScript library reaches the runtime only as a **build artifact**: tsc-strict sources → esbuild IIFE bundle (`--global-name=__wt`) → concatenated with serialized meta + invocation glue → accepted and executed by the real Workflow tool.
- **Serialized meta is accepted.** The pure-literal rule is satisfied by *emitting* `meta` via serialization at build time — JSON-quoted keys and bundler helper residue after the meta statement both pass. A statement placed *before* `meta` is rejected synchronously at the tool layer for `scriptPath` invocations.
- **The 512 KB cap applies to `scriptPath`** (tool-layer rejection: "exceeds 524288 bytes") **and to `name` resolution by silent exclusion** — an oversized file in a workflows directory is simply never registered; no error anywhere. The build CLI therefore pre-checks size, or an oversized workflow would "disappear" with no diagnostic.
- **The `name` registry is keyed by `meta.name`, not the filename**, and refreshes lazily mid-session. The build CLI keeps filename = `meta.name` to avoid confusion; right after installing a new artifact, `scriptPath` is the reliable invocation form.
- **String `args` arrive JSON-encoded** (a string input reaches the script *including its quotes*). `defineWorkflow`'s args normalizer exists because of this, not as a convenience.
- **`json-schema-to-ts` is genuinely types-only**: `FromSchema` usage leaves zero residue in the esbuild bundle; tsc-strict passes with `--moduleResolution bundler`.

---

## 3. The central constraint and the build answer

The sandbox bans `import`/`require`/Node APIs; `meta` must be the first statement and a pure literal; scripts are capped at 512 KB. Therefore the toolkit is a **compile-time library** ([ADR 0001](adr/0001-compile-time-library.md)):

```text
TS sources (patterns + workflow definitions)
   │  typecheck (tsc strict) — contracts enforced here
   ▼
@workflow-toolbox/build (esbuild: bundle, treeshake, inline pattern fns, no imports in output)
   │  emit: `export const meta = {…literal…}` + bundled async body
   ▼
self-contained workflows/<meta.name>.js  (committed — ADR 0002)
   │  lintWorkflowSource (rules R1–R9, below)
   ▼
runnable by Workflow({ name }) or { scriptPath } — runtime untouched
```

**Output size policy (512 KB cap).** The cap applies to the inline `script` parameter (`maxLength: 524288` in the tool schema) and — verified — to `scriptPath` files and `name`-registry registration (§2.3). The build defaults to **readable** output (no minification): the emitted `.js` is what users review in permission dialogs, debug via persisted run scripts, and edit for `scriptPath` re-invocation. `workflow-toolbox build` warns from 400 KB and points at the real levers first — embedded data moves to `args` or stays on disk for *agents* to read (string literals don't minify), and an oversized workflow is usually two workflows with a checkpoint between them. `--minify` exists as an explicit escape hatch (`minifyWhitespace` + `minifySyntax`, never `minifyIdentifiers` — names stay readable in stack traces); the linter always runs on the *emitted* output, minified or not, and `meta` must remain the first parseable statement.

**The static linter.** `lintWorkflowSource(src)` returns `{ errors, warnings }` and enforces, on the emitted artifact: size ≤ 512 KB (R1); `export const meta` present (R2), first (R3), a pure literal — no spreads (R4a), no template literals (R4b), no calls (R4c); no reserved prototype-chain keys (R5); `name` + `description` required (R6); banned non-deterministic **calls** — `Date.now()`, `Math.random()`, argless `new Date()` (R7); host-API use flagged — `require()`, `import … from`, `process.*` (R8, warning); `parallel()` arrays mixing thunks with bare calls flagged element-wise (R9, warning). The plugin ships the same rules as a standalone CLI (`validate-workflow.mjs`, derived from `lint.ts`), and a parity test suite pins the two implementations to identical verdicts.

**Typechecking is opt-in at build time (`workflow-toolbox build --typecheck`).** esbuild strips TypeScript types without checking them, so `workflow-toolbox build` alone will happily bundle type-broken source. In-repo the gates run `tsc` directly; an off-repo consumer passes `--typecheck`, which resolves the **consumer's own** `typescript` (never a bundled copy; absent → warn-and-skip, the build still runs), prefers the tsconfig nearest the entry (falling back to minimal options), and refuses to emit the artifact on type errors.

**Alternative considered — templates only** (copy-paste patterns from the skill, no build step). Rejected as the *primary* mechanism because it gives no type safety, no testable pattern logic, and no reuse guarantee — every instantiation re-derives the pattern by hand. Retained as the *secondary* mechanism: the workflow-composer skill remains the authoring guide for one-off workflows, with the toolkit as its "standard library" for repeatable ones.

---

## 4. Repository structure

pnpm workspace, three core packages plus examples (and three further packages: the
private `@workflow-toolbox/smoke` upgrade-canary harness, the private `@workflow-toolbox/debugger` run diagnoser,
and the author-facing `@workflow-toolbox/scaffold` workflow scaffolder; plus the zero-dependency
`@workflow-toolbox/std` shared-narrowing leaf consumed by smoke + debugger) — deliberately few:

```text
workflow-toolbox/
├── plugin/                              # the Claude Code plugin
│   ├── skills/
│   │   ├── workflow-composer/            #   authoring guide + linter CLI + assets
│   │   ├── upgrade-canary/              #   re-verify the runtime after a CC upgrade
│   │   ├── workflow-debugger/           #   diagnose a run from its journal
│   │   ├── toolkit-scaffold/            #   spec → build-clean .workflow.ts skeleton
│   │   └── independent-analysis/        #   trigger the bias-free analysis workflow
│   ├── workflows/                       #   independent-analysis.js (mirror of the canonical artifact)
│   └── bin/                             #   wt-debug.mjs (debugger CLI) + wt-stop-hook.mjs (Stop hook)
├── docs/public/                         # this doc + ADRs
└── toolkit/                             # pnpm workspace
    ├── packages/
    │   ├── runtime/                     # @workflow-toolbox/runtime — the ONLY coupling point to Claude Code
    │   │   ├── src/types.ts             #   WorkflowRuntime, AgentOptions, Budget, schema typing
    │   │   ├── src/fake.ts              #   FakeRuntime test double (FIFO/handler modes)
    │   │   └── globals.d.ts             #   opt-in ambient decls of the sandbox globals
    │   ├── patterns/                    # @workflow-toolbox/patterns — the 9 patterns + envelope.ts
    │   ├── build/                       # @workflow-toolbox/build — defineWorkflow, esbuild pipeline, linter, CLI
    │   ├── std/                         # @workflow-toolbox/std — zero-dep narrowing leaf (isRecord/numOrNull/strOrNull)
    │   ├── smoke/                       # @workflow-toolbox/smoke (private) — headless upgrade-canary harness
    │   │   ├── src/                     #   pure lib (unit-tested) + the live SDK runner
    │   │   └── wt-smoke.js             #   dedicated round-trip artifact (built, committed)
    │   ├── debugger/                    # @workflow-toolbox/debugger — diagnose a run + audit-report it + Stop hook (#19, #24)
    │   │   ├── src/                     #   pure journal/diagnose/format/report/stop-detect/stop-surface (unit-tested) + impure resolver/writer/CLIs/stop-hook
    │   │   └── build.ts                 #   esbuild → plugin/bin/{wt-debug,wt-stop-hook}.mjs (byte-identical to toolkit/bin)
    │   └── scaffold/                    # @workflow-toolbox/scaffold — spec → build-clean .workflow.ts skeleton
    │       ├── src/scaffold.ts          #   pure scaffoldWorkflow emitter (unit-tested) + impure CLI
    │       └── test/fixtures/           #   committed all-patterns golden (typechecked + linted by the gates)
    ├── examples/                        # 23 compositions (.workflow.ts) + their tests
    ├── bin/                             # wt-debug.mjs + wt-stop-hook.mjs — source-of-truth twins of plugin/bin
    └── workflows/                       # committed build artifacts (12–52 KB each)
```

- **`@workflow-toolbox/runtime`** is types + a test fake only — near-zero runtime code. It is the unstable-surface firewall (§2.2).
- **`@workflow-toolbox/patterns`** depends only on `runtime` types. Pure functions; no I/O of their own.
- **`@workflow-toolbox/build`** is the only package with Node dependencies (esbuild). Workflow entry files import the sandbox-pure subpath **`@workflow-toolbox/build/define`**, never the package root — the root drags Node-only modules into the bundle ([ADR 0005](adr/0005-sandbox-pure-entry-subpath.md)). `bundleWorkflow` pre-flights this with an actionable error.
- **`@workflow-toolbox/std`** is a zero-dependency leaf — the canonical `isRecord`/`numOrNull`/`strOrNull` narrowers shared by `debugger` and `smoke`. Its `isRecord` excludes arrays so callers can index string keys safely; it gets inlined into the bundled bins by esbuild.
- Schemas are authored as `as const` JSON Schema literals with types derived via `json-schema-to-ts` (`FromSchema`) — a **types-only** dependency, erased at compile time, zero bundle weight. JSON Schema over zod because the runtime consumes JSON Schema natively ([ADR 0003](adr/0003-json-schema-over-zod.md)).
- Built artifacts are **committed** ([ADR 0002](adr/0002-commit-built-artifacts.md)): they are reviewable, diffable, and usable without building — they are the deliverable users actually run. The build is deterministic across invocation forms (module-path comments are pinned to the entry's directory), so rebuilds don't churn the diff.

**CLI.** The published `workflow-toolbox` command (`@workflow-toolbox/build` ≥ 0.2.0) carries the full authoring loop off-repo — `npx workflow-toolbox <subcommand>` from any project with the npm trio installed. In this repo the same subcommands run as maintainer scripts from `toolkit/` (`pnpm wt:build`, `pnpm wt:check`, …):

- **`workflow-toolbox scaffold <spec.json> [--out-dir <dir>] [--no-tsconfig]`** — emits a build-clean `.workflow.ts` skeleton from a `{ meta, steps }` spec, plus a minimal `tsconfig.json` when the target dir has none (never overwrites; `--no-tsconfig` opts out) so `--typecheck` and editor type hints work out of the box.
- **`workflow-toolbox build <entry.ts> [--typecheck] [--out-dir <dir>] [--minify]`** — compiles a workflow definition to its artifact (default out-dir `workflows/`, **filename = `meta.name`**, not the entry filename). `--typecheck` runs the consumer's own `typescript` on the entry before bundling (§3) — esbuild strips types without checking them — and skips with a warning when typescript isn't installed.
- **`workflow-toolbox check <artifact.js>`** — lints an emitted artifact (rules R1–R9, §3).
- **`workflow-toolbox debug [runId|latest|<journal-path>]`** — diagnoses a run from its journal (the zero-install end-user equivalent is the bundled `node "${CLAUDE_PLUGIN_ROOT}/bin/wt-debug.mjs"`).
- **`workflow-toolbox report [runId|latest|<journal-path>] [--out <dir>]`** — produces a cost + traceability **audit report** for a run from its journal:
  - per-agent token cost, reconciled against the run total;
  - a per-agent **transcript-driven token breakdown** (input / output / cache-read / cache-write, summed from each agent's transcript and deduped by `message.id`) — kept as a section SEPARATE from the journal cost rollup, because the two are different measures (per-turn billed tokens vs the journal aggregate) and are deliberately not reconciled;
  - the decision trail;
  - best-effort transcript links.

  The report always prints to stdout; setting `$DWT_WORKFLOW_LOG_DIR` (or `--out`) additionally writes a persistent audit folder `<dir>/<runId>/{report.md, journal.json, transcripts/}` (off by default, for enterprise audit trails).

Both `workflow-toolbox debug` and `workflow-toolbox report` accept a literal journal path, take leading-dash `--project` slugs in space and equals forms, and print the `[project dir: …]` they resolved against.

**Bundling the private packages into the `workflow-toolbox` CLI.** `scaffold`, `debugger`, and `std` are not published to npm; they reach the published CLI as build **devDependencies** that tsup inlines into `@workflow-toolbox/build`'s dist (real `dependencies` — `runtime`, `esbuild` — stay external). The debugger exposes narrow subpath exports (`./source`, `./audit-folder`, `./cli-args`) so the CLI bundles only the modules it needs, never the package's flat index barrel; ~40 lines of orchestration in `build/src/cli.ts` are consciously duplicated from the debugger's own CLI entries, which self-execute (`process.exit(main())`) and cannot be imported as functions.

**Run-end surfacing.** The runtime fires no per-workflow completion hook (`TaskCompleted` is bound to the teammate/todo system, not Workflow background tasks), so the report is journal-driven. Automatic in-session surfacing at run end ships as a plugin **`Stop` hook** (`plugin/bin/wt-stop-hook.mjs`): it detects a finished background workflow by diffing the `Stop` payload's `background_tasks[]` across firings, maps the task to its journal by `taskId`, and surfaces the report **hybrid-style** — always a one-line `systemMessage` notice, plus a `decision:"block"` continuation carrying a compact report ONLY when the run looks like trouble (failed / agent-died / schema-retries), so healthy runs stay quiet. (A `Stop` hook's only model-context injection is `decision:"block"`+`reason` — `additionalContext` is not a `Stop` output field.) The audit folder stays gated by `$DWT_WORKFLOW_LOG_DIR`; the hook never breaks the session (any error → emits `{}`, exits 0).

---

## 5. Pattern taxonomy

Four layers. Lower layers are never wrapped, only used.

### L0 — Runtime primitives (not abstracted)

`agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `budget`, `workflow()`, `{schema}`. Patterns call them through the typed `rt` parameter; compositions may call them directly. **Prompt chaining is deliberately NOT a pattern** — it is two sequential `await rt.agent(...)` lines; abstracting it would obscure, not help. It is documented as an idiom instead.

### L1 — Patterns (the library)

| Pattern | Anthropic mapping | Use when | Do NOT use when |
|---|---|---|---|
| `classifyAndAct` | Routing | Distinct input categories handled better separately; classification is reliably accurate [BEA] | Categories blur, or one prompt handles all inputs well — a single agent is simpler |
| `fanOutAndSynthesize` | Parallelization (sectioning) + synthesis barrier | Independent subtasks; synthesis genuinely needs all results [BEA] | Stages flow per-item — use the `pipeline` idiom; or N=1 |
| `adversarialVerification` | Parallelization (voting), refute-first | Findings will be acted on and a plausible-but-wrong one is costly | Low-stakes output; or no independent verification method exists |
| `generateAndFilter` | Generation + evaluator (single pass) | Wide candidate space, cheap generation, clear filter criteria | Criteria can't be articulated — the filter becomes noise |
| `tournament` | Voting + judge panel + synthesis | Solution space wide; one-attempt-iterated is weak; angles genuinely differ | Convergent tasks where attempts would be near-identical |
| `loopUntilDone` | Evaluator-optimizer / loop-until-dry | Clear evaluation criteria + iterative refinement adds measurable value [BEA]; or unknown-size discovery | No articulable feedback; or a fixed list is known up front (just map it) |
| `planAndExecute` | Orchestrator-workers | Subtasks can't be predicted up front; a planner agent decomposes dynamically [BEA] | Subtasks are known — use `fanOutAndSynthesize` or `rt.pipeline` directly (cheaper, more predictable) |

Every pattern: takes `rt` + a typed options object (prompts as data, items, schemas, caps, model tiering) and returns the standard envelope (§7). All but one assign their agents to a caller-provided `phase` — the exception is `loopUntilDone`, which has no `phase` option (call `rt.phase()` before it); it spawns no agents itself but counts the body's `agent()` calls, made through the `rt` the body receives (including via `rt.parallel`/`rt.pipeline` thunks), into `stats.agentsSpawned`, while its trail stays per-iteration (`trail.length === iterations`, so `trail.length !== agentsSpawned` for this pattern).

### L2 — Compositions

Plain async functions in workflow definition files that call several patterns in sequence/parallel. The twenty-three shipped examples live here (§6.3). Compositions are **examples and templates, not library API** — copying and editing one is the intended usage.

### L3 — Checkpointed compositions (HITL)

A multi-stage job with human gates = **several workflow files**, each ending by returning an artifact (plan, review, candidate set). The human approves; the next workflow takes the artifact via `args`. This is the documented runtime pathway [DOCS] and stays out of the library entirely — it's a convention plus the `args` normalization helper. The shipped `monorepo-refactor-plan` / `monorepo-refactor-execute` pair demonstrates it.

---

## 6. Composition model

### 6.1 Rules

1. **In-file composition is the default.** Patterns are inlined functions; compose them with plain `await`, `if`, `for`. No barriers between patterns unless a pattern's output set is needed whole.
2. **`pipeline` by default between stages; `parallel` only for genuine cross-item needs** (dedup, merge, count-based early-exit) — the strongest authoring rule there is.
3. **Schema at every consumed boundary.** Any agent result a later line reads a field off must have a schema. Free text only when passed whole into another prompt.
4. **Data crosses agent boundaries as prompt text** (`JSON.stringify` into the next prompt) — the orchestrator shares no memory with subagents.
5. **`workflow()` nesting is reserved for frozen, independently-owned workflows** invoked as a sub-step. One level only `[verified]`; no bundled composition nests today (the capability is reserved, currently unused) — so the library never builds compositions that nest; patterns inline instead.
6. **HITL = workflow boundary** (§5 L3). A composition needing sign-off splits into N workflow files at exactly the approval points.
7. **Every loop has a typed stop condition** — `maxIterations`, `dryRounds`, or `budgetFloor`; the options type makes omitting all three a compile error.

### 6.2 Authoring contract

```ts
// pr-review.workflow.ts — entry shape
import { defineWorkflow } from '@workflow-toolbox/build/define'   // sandbox-pure subpath (ADR 0005)

export default defineWorkflow({
  meta: { name: 'pr-review', description: '…', phases: [{ title: 'Route' }, { title: 'Review' }, { title: 'Verify' }, { title: 'Synthesize' }] },
  // input: normalized args (string|object|undefined → typed input or fail-fast error)
  run: async (rt, input) => { /* composition body using patterns */ },
})
```

`defineWorkflow` contributes exactly three things: build-time `meta` extraction/serialization, the standard `args` normalizer + fail-fast input validation, and binding the ambient sandbox globals into the typed `rt` object. Nothing else — no lifecycle hooks, no middleware, no plugins.

### 6.3 The shipped compositions

1. **`pr-review`** — `classifyAndAct` (route by change type) → per-lens specialized reviewers with `adversarialVerification` in pipeline form (each lens's findings verified as they land, no barrier) → synthesis. Teaches the four agent-self-report defence layers.
2. **`monorepo-refactor-plan`** — `planAndExecute` (a planner decomposes the refactor) + `adversarialVerification` (refute-first review of the proposed plan) → returns an execution-plan artifact for human approval (the L3 boundary).
3. **`monorepo-refactor-execute`** — takes the approved plan via `args`, re-validates it, then runs the *known* steps with `rt.pipeline` directly (planAndExecute would be waste — the subtasks are no longer unknown). Mutating agents run with `isolation: 'worktree'`; fresh-evidence checker agents verify each step's claim.
4. **`doc-rewrite`** — `generateAndFilter` (N candidate rewrites, index-diverse prompts → evaluate against criteria) → `loopUntilDone` (evaluator-optimizer until PASS or a typed stop) → final version with an honest `stoppedBy`.
5. **The dev-workflow family** — `dev-plan`, `dev-implement`, `dev-review-fix`, plus the `dev-full` orchestrator: a TDD feature pipeline with human gates between phases. `dev-plan` (Critique) and `dev-review-fix` (Verify) expose a `verifierType` input for a cross-model verifier, routed across the chain by `dev-full`. Documented in depth in [dev-workflow.md](dev-workflow.md).
6. **`independent-analysis`** — (optional) lens auto-proposal → `fanOutAndSynthesize` (one analyst per lens, dedup against the caller's stated assumptions) → `adversarialVerification` (refute-first) of the survivors. A bias-free multi-lens review of an arbitrary subject (design, plan, claim, decision, or code); the `verifierModel` input overrides `adversarialVerification`'s BEST_MODEL default, and `args.agentTypes.verify` (the structured config envelope — the bespoke top-level `verifierType` arg was removed) routes the verifiers through a cross-model (e.g. `codex:codex-rescue`, GPT) skeptic, probe-resolved at entry with graceful fallback to the standard verifier. Built to counter the driving model's go-fast / confirm-prior-assumption bias.
7. **`backlog-triage`** — `scoreAndRank` (a cheap-model sweep scores a large candidate set on impact × tractability, ranks, applies a `topK` cutoff) → a premium per-survivor deep-dive aimed only at the survivors. The "targeting machine": teaches the one shape `scoreAndRank` is for (large set, expensive downstream, dropping the tail acceptable *by construction*) and — crucially — where its drop-the-tail cutoff is **not** safe (never in front of a correctness gate; contrast `pr-review`'s keep-everything verify cap and `monorepo-refactor-plan`'s impact-scaled votes, both of which never drop).
8. **`cross-model-verify`** — the focused cross-family showcase: refute-first `adversarialVerification` of caller claims with an optional cross-model (non-Claude) verifier. Omit `agentTypes.verify` for the same-model default; pass `{ agentTypes: { verify: 'codex:codex-rescue' } }` for a GPT verifier (the structured config envelope — the bespoke top-level `verifierType` arg was removed; probe-resolved at entry with graceful fallback; local-machine-only — prefer an MCP→model endpoint for a portable one).
9. **`demo-all-patterns`** — exercises all nine patterns in one workflow; the reference for how they wire together and render in observe-ui.
10. **`loop-demo`** — `loopUntilDone` with `generateAndFilter` + `scoreAndRank` inside the loop body.

---

## 7. Input/output contracts

### 7.1 Standard result envelope (every pattern returns one)

```ts
interface PatternResult<T> {
  value: T                      // the pattern's actual product
  stats: {
    itemsIn: number             // work units received
    itemsOut: number            // work units surviving
    agentsSpawned: number
    dropped: number             // null results (skip/error/budget) — counted, never silent
    truncated: number           // cap-induced omissions — counted, never silent
  }
  warnings: string[]            // human-readable coverage caveats (also log()-ed live)
  trail: TrailRecord[]          // audit trail — REQUIRED, every pattern emits one
}

interface TrailRecord {
  stage: string                 // pattern-qualified step id, e.g. 'planAndExecute:work:3'
  outcome: 'ok' | 'null'        // whether the step produced a result
  model?: string                // model override in effect, when one was set
  decision?: string             // typed control decision (e.g. a route taken) — never prose
}
```

The envelope implements the "no silent caps" rule and [WTA]'s actionable-error principle: deterministic tallying **in code**, unverified-but-kept results flagged rather than dropped, coverage gaps surfaced as warnings. The `trail` is metadata only — stages, outcomes, decisions; no payloads, no timestamps (determinism), deterministic order — and is what makes a pattern run **auditable after the fact**: which stages ran, what was decided, where nulls appeared.

`planAndExecute` extends the envelope: `PlanAndExecuteResult<TWork, TOut>` adds `workerResults: TWork[]` (per-worker results in subtask order), so compositions consume worker output through the type instead of closure-capture tricks.

### 7.2 Schema strategy

- JSON Schema literals `as const`, types via `FromSchema` — one source of truth for both the runtime contract and the TS type.
- Schemas live next to the pattern that consumes them; patterns accept caller-supplied schemas for their domain payloads and own only their *control* schemas (verdicts, scores, classifications — e.g. the verdict enum `confirmed | partially-confirmed | refuted | unverifiable`). That 4-value enum is the **agent-vote** schema and is unchanged; the **claim-level result** vocabulary (the exported `ClaimVerdict` type) adds a fifth, deterministically-assigned value, `'unverified-by-cap'`, for claims cut by `maxVerifyClaims` (never verified; `votes: []`, counted in `stats.truncated`) — distinct from `'unverifiable'` (verifiers ran and all failed; votes is a non-empty array of nulls, counted in `stats.dropped`). Agents never emit the cap verdict — only the deterministic tally assigns it.
- Small and `required`-tight; enums for closed sets; bounded numbers for scores.

---

## 8. Guardrails

**Resource/budget** *(framed as token-budget and latency control)*

- Loop patterns require a stop condition **by type** (§6.1 rule 7); `budgetFloor` guards always check `rt.budget.total` first — with no budget set, `remaining()` is Infinity and a floor-only loop would never stop. If `budgetFloor` is the *only* stop condition and `rt.budget.total` is null, the pattern fails fast at start (an inert floor = an unbounded loop).
- `budgetFloor` semantics: budgets are **opt-in** (no user target → no constraint at all); when one exists, the floor decides *where the cut falls* — breadth (fewer rounds) rather than integrity (dying mid-verification) — and reports it (`stoppedBy`, coverage warning). Honesty note: the floor is a heuristic, not a reservation — the pool is global and shared with sibling workflows in the same turn, and the runtime has no per-stage reserve primitive. Picking a floor number is data-driven via `pnpm wt:calibrate` (maintenance tooling in `@workflow-toolbox/smoke`): `record` captures a real run's agent count + `rt.budget.spent()` + the completion notification's token `usage` into a gitignored log, and `derive` prints `floor ≈ tokens-per-agent × (claims × votes + synthesis) × margin` (with `votesPerClaim`, `claims × votes` is an upper bound only when the mapping never exceeds `votes` — low-vote claims spend less; a mapping that returns more than `votes` makes it an under-estimate, so size the formula with the max over claims instead). Since the runtime has no per-agent token primitive, tokens-per-agent is a cross-run approximation, and the two token signals are kept segregated: `budget.spent()` is OUTPUT tokens (what the floor compares against via `remaining()`), the notification `total_tokens` is the in+out total — both were live-verified to scale with sub-agent count. The number stays a lower bound from cheap probe agents until real workflow runs accrue, which the safety margin covers.
- **Budget exhaustion is a checkpoint, not a loss**: a floor-stopped run returns its partial result; relaunching with `resumeFromRunId` replays completed `agent()` calls from cache — only the missing work runs again [SDK]. This is the standard "ran out → review partial → resume" pattern, and a de-facto HITL point. (Proven live: a run that lost agents to transient API errors was resumed and only the dead agents re-ran.) The **workflow-debugger** skill reads this off disk and tells you whether a resume would actually replay cached work — gated on the **same-session-only** rule, since the cache is gone once you debug from a different session.
- Model tiering: every pattern exposes per-stage `model` options; mechanical/high-volume leaf work → `'haiku'`, judgment work → inherit. Verification quality is model-sensitive: verifiers default to **`BEST_MODEL`** (a shared constant exported by `@workflow-toolbox/runtime`, currently `'opus'`; the constant names the strongest *reliably-callable* tier, not merely the newest — top-tier alias availability varies by plan and over time), and explicitly passing anything weaker logs a warning. `BEST_MODEL` is the only VALUE the patterns import from `runtime` (their other imports are `import type`; the package root also value-exports the `FakeRuntime` test double, which workflow entries never import): esbuild inlines it into bundled workflow artifacts, so bumping the constant re-emits the committed `workflows/*.js`.
- Per-pattern caps (`maxItems`, `maxVerifyClaims`, …) with mandatory truncation reporting. A cap never destroys evidence: in `adversarialVerification`, cap-truncated claims stay in the output with the nominal claim verdict `'unverified-by-cap'` (`votes: []`) rather than being silently dropped — `itemsIn === itemsOut` holds, and `trail.length === stats.agentsSpawned` (truncated claims get no trail records).

**Risk**

- Refute-first verification with majority thresholds (default 2-of-3) and default-refute-when-uncertain.
- Keep-unverified-rather-than-drop: a failed verifier never destroys collected evidence; it flags it. The claim verdicts make the two kept-and-flagged cases nominally distinct: `'unverifiable'` (verifiers ran, all failed) vs `'unverified-by-cap'` (the cap cut the claim, never tested) — both mean the claim is kept and flagged, never silently dropped.
- Read-only-by-default guidance for analysis patterns.
- Mutating compositions (refactor execution) sit behind an L3 human checkpoint; parallel mutating agents require `isolation: 'worktree'` (documented as expensive, used only then).

**Quality**

- Build-time: tsc strict; esbuild output linted by `lintWorkflowSource` (R1–R9, §3); thunks-not-promises is typed away in TS and linted in raw JS.
- Test-time: every pattern is unit-tested against `FakeRuntime` (scripted, deterministic agent responses; assertions on spawned-agent counts, phases, envelope stats, trail contents, null-handling). Composition tests exercise the example compositions end-to-end against the fake (one `*.test.ts` per composition under `examples/test/`).
- Launch-time: **always check `WorkflowOutput.error`** — a script failing its syntax check still returns `status:"async_launched"` with `error` set and never runs [SDK]. The skill guidance and examples encode this check.
- Run-time (by convention): patterns `log()` coverage warnings live, so `/workflows` shows degradation as it happens.
- A defence-in-depth rule runs through everything: **trust no agent's self-report.** Schemas force structure, refute-first verification attacks claims, fresh-evidence checkers re-derive them, and the envelope counts what was dropped — four layers, because a single subagent asserting "done" is evidence of nothing.

---

## 9. Over-engineering risks and what stays unabstracted

| Risk | Counter-decision |
|---|---|
| Building a workflow *engine* (DAG/graph/fluent DSL) | Composition = plain async TS. No combinator zoo. If a composition can't be written as readable sequential code, it's too complex. |
| Prompt templating framework | Prompts are plain template-literal functions next to their pattern. Nothing more. |
| Reimplementing runtime features (retry, cache, concurrency, state) | Forbidden by P4. The toolkit has no execution semantics of its own. |
| Generic gymnastics in types | Generics one level deep (`PatternResult<T>`, `FromSchema`). No conditional-type APIs. |
| Wrapping `pipeline`/`parallel` "for safety" | Exposed raw through `rt`. Patterns use them; compositions may too. |
| Premature MCP abstraction | The toolkit does nothing for MCP. The seam is already right: agents reach MCP tools natively; pattern prompts can mention them. Revisit only with a concrete need. |
| Library sprawl (a pattern for everything) | Nine patterns. New patterns need a demonstrated, repeated real-world use (P6) — `scoreAndRank` cleared that bar (the cheap-triage-then-aim practice). The count is not frozen; the *bar* is. |

**What remains small, explicit, unabstracted:**

- `meta` — written per workflow, serialized verbatim.
- Prompts — plain strings/functions, visible in the workflow file, greppable.
- Control flow — `await`, `if`, `for`, `while`. The reviewer of a workflow file reads JavaScript, not a DSL.
- Schemas — plain JSON Schema objects, no schema builder.
- The envelope — five counters, a string array, and a trail of small records.
- `defineWorkflow` — three responsibilities (§6.2), nothing else.

---

## 10. Design decisions

The load-bearing decisions are recorded as ADRs in [docs/public/adr/](adr/):

| ADR | Decision |
|---|---|
| [0001](adr/0001-compile-time-library.md) | Compile-time pattern library, not a runtime framework |
| [0002](adr/0002-commit-built-artifacts.md) | Commit built workflow artifacts |
| [0003](adr/0003-json-schema-over-zod.md) | JSON Schema + `json-schema-to-ts`, not zod |
| [0004](adr/0004-explicit-runtime-parameter.md) | Explicit runtime parameter (`rt`), not ambient globals |
| [0005](adr/0005-sandbox-pure-entry-subpath.md) | Sandbox-pure entry subpath `@workflow-toolbox/build/define` |
| [0008](adr/0008-pipeline-authoring-surface-vocabulary.md) | Pipeline authoring surface & orchestrator vocabulary |
| 0006 · 0007 · 0009 · 0010 | Observe-product decisions — these records ship with the Workflow Observatory product (its own repository) |

Two further standing decisions, not ADR-sized:

- **Same repo, plugin + toolkit co-evolving.** The plugin teaches what the toolkit builds; the parity and anti-drift test suites only work because both live together.
- **Runtime instability is accepted and firewalled** (§2.2). The canary on each Claude Code upgrade: run the linter on the committed artifacts, smoke-run one workflow, and re-check the `[verified]`-tier facts. This is implemented as `pnpm smoke` (the `@workflow-toolbox/smoke` package): it drives the Workflow tool through the TS Agent SDK (≥ v0.3.149) [SDK] to launch every committed artifact (asserting the runtime still accepts each) and to round-trip a dedicated minimal workflow to completion (asserting the result envelope survives) — headless and CI-runnable. `pnpm smoke` covers the *positive* path; a companion `pnpm canary` covers the *negative* surface — it launches deliberately-invalid scripts and asserts the runtime still rejects them (the 512 KB cap and the "`meta` must be the first statement" rule), the regression to catch if an upgrade silently accepts one. Alongside that, canary C1 (`pnpm canary:nesting`) re-verifies `workflow()`'s one-level nesting cap (§2.2) live: it launches a parent→child→grandchild round trip and asserts the child's OWN nested `workflow()` call is rejected — plus, as a positive control, that depth-1 (parent→child) still runs, so a broken `workflow()` never masquerades as "nesting rejected". Canary C2 (`pnpm canary:budget`) re-verifies a second runtime fact the multi-level-pipeline execution model depends on: that two orchestrator-launched Workflow runs — two independent SDK sessions, not a nested `workflow()` call — have SEPARATE `budget.spent()` pools. It launches one probe run to completion, then a second, and refutes sharing by monotonicity: a genuinely shared/leaking counter could only put the second run's starting spend AT OR ABOVE the first run's ending spend, so any strict decrease already falsifies it — no assumption that a fresh pool "starts near zero" is needed (real sessions carry a small non-zero per-launch baseline that would otherwise produce a false alarm). `[observed]` (live probe, CC 2.1.199, 2026-07-03): separate pools, confirmed on two independent live runs with different absolute baselines (~15 and ~130 tokens) but the same qualitative pattern both times. A version gate (`pnpm canary:version`) re-runs the set only when the `claude` CLI or SDK version changed since the last pass. The full canary (`pnpm canary`) is a **matrix**: it runs smoke + edge + nesting + budget against BOTH runtimes that drive `@workflow-toolbox` workflows — the user's interactive `claude` binary and the one bundled inside the Agent SDK (they drift independently) — reads each run's Claude Code version from its init message, and diffs the outcome against the last run to report **what changed** (version moves, check flips, rejection-wording drift) as drivers for fixes/features. Alongside that, it inspects the official Claude Code changelog for the `(last-verified, current]` version range and prints the documented entries — highlighting lines that touch the workflow/agent/tool/sdk surface — so a flip can be cross-read against what the release notes actually changed (informational only; a missing changelog never affects the verdict). The `upgrade-canary` plugin skill is the operator playbook over this. Its post-hoc complement is the **workflow-debugger** skill: where the canary asks "did the runtime move?", the debugger asks "why did *this run* fail?" — it reads a run's on-disk journal (`workflows/wf_<runId>.json`) through one pure decision table (`completed-ok` / `script-throw` / `agent-died` / `schema-retries` / `in-progress`) and recommends `resumeFromRunId` only when agents actually cached AND you are still in the originating session. One nuance is `[observed]` (live probe, CC 2.1.170): an unsatisfiable schema never yields journal-visible retries — the runtime nudges the same agent conversation, then `agent()` throws `subagent completed without calling StructuredOutput` while the journal records the agent as `done` — so the debugger also matches that error signature into an advisory `schema-hint` finding (the schema failure that wears a script-throw costume). It ships to end users as a self-contained `plugin/bin/wt-debug.mjs` (esbuild platform:node, zero deps, frozen byte-identically into `toolkit/bin/` + `plugin/bin/`). The third skill is the authoring complement: **toolkit-scaffold** turns a structured `{ meta, steps: [{ pattern, phase }] }` spec into a complete, **build-clean** `.workflow.ts` skeleton (`@workflow-toolbox/scaffold`'s pure `scaffoldWorkflow`), so an author never hand-rolls the `defineWorkflow` boilerplate — the scaffolder assembles the wiring, while choosing *which* patterns stays the author's judgment (the skill encodes the L1 use/don't-use table). The skeleton ships placeholder prompts/data and no active schemas so it compiles and builds as-is; that guarantee is gate-enforced by a committed all-patterns golden fixture (typechecked by `pnpm typecheck`, linted by `pnpm lint`). There is no bundled plugin artifact, but the scaffolder ships inside the published `workflow-toolbox` CLI (`npx workflow-toolbox scaffold` — §4) — a scaffold output is usable wherever esbuild can resolve the `@workflow-toolbox/*` imports: a toolkit workspace package in-repo, or any project with the npm trio installed off-repo.
