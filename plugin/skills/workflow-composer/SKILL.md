---
name: workflow-composer
user-invocable: true
description: >-
  Invoke when the user asks to build, generate, repair, or restructure a
  workflow for Claude Code's Workflow tool ("I want a workflow that…", "turn
  this process into a workflow", "set up a multi-agent pipeline"), to pick
  orchestration patterns, or to tune model/effort/agentType routing. Covers
  writing and debugging the single .js scripts where deterministic JavaScript
  drives fleets of fresh-context subagents (agent/parallel/pipeline/phase),
  via the @workflow-toolbox toolkit or the raw single-file path.
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

The reference files carry the deep material — read them when a step points you there:

- `references/api-reference.md` — every global, option, cap, and constant, each
  tagged with its evidence tier (documented / observed / verified).
- `references/patterns.md` — the nine orchestration patterns as copy-paste recipes.
- `references/premise-quality.md` — the authoring doctrine: how the quality of what
  you feed your agents (evidence, framing, complete source listings, a named
  "could-not-verify" out) caps what a fan-out can return, plus the failure modes that
  silently degrade agent output. Read it before writing the prompts, schemas, or
  `sourceRefs` for any analysis, audit, verification, or decision workflow.
- `references/orchestrator-pipelines.md` — human-gated multi-workflow jobs (L3).
- `references/shipped-compositions.md` — the 26 shipped compositions + operational lessons.
- `references/model-and-agent-routing.md` — schemas, tiering, effort, agentType routing.
- `references/observer-definitions.md` — authoring an observer (`<name>.observer.json`), the
  abstract-needs boundary, the selector/label coupling, and the `args.observers` launch bridge.
- `references/capability-needs.md` — giving a role more than the bare default via a
  workflow-owned `<name>.capabilities.json` sidecar of ABSTRACT needs (`$cap:<need>`),
  resolved per-machine at launch; the derivation pass, the machine-agnostic lint, adoption.
- `references/worked-example-pr-review.md` — the annotated pr-review walk-through.
- `references/observing-runs.md` — how to **launch a run so you can watch it live** and read the
  result with the dev-only `observe-ui` tool: the rich SDK pathway (compiled artifacts, live
  phase→agent DAG) and disk replay for any finished run (including your own Workflow-tool runs),
  plus the honest limit — inline / non-compiled runs have no live UI ("compile to observe").
  Read it when the user asks to *see / watch / observe / monitor* a workflow run.

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

### The orchestration ladder — pick the lowest rung that does the job

"Workflow or nothing" is a false choice. A workflow is the *fourth* rung of five;
most fan-out that doesn't earn a compiled artifact still wants a **pattern shape**,
just run by hand instead of compiled. Route to the lowest rung that fits:

1. **Answer directly** — no delegation needed.
2. **One subagent** — a single isolated task; `Agent` once and read the result.
3. **Inline fan-out in the main conversation loop** — run a pattern's *logic*
   directly: the main loop emits several `Agent` calls and reconciles their results
   itself, **with no `.js` artifact and without the Workflow tool**. This is the rung
   the gate above was hiding. It buys you the pattern (refute-first verify,
   fan-out-synthesize, tournament, loop-until-dry) for a one-off, at zero build cost.
   The nine shapes and a sandbox→main-loop translation table are in
   [patterns.md](references/patterns.md) (*"Inline in the main conversation loop"*).
   This is the same default `deep-grounding` reaches for; eight of the nine patterns
   translate cleanly — only `planAndExecute` at scale really wants the artifact.
4. **Compiled workflow** (the rest of this guide) — graduate here the moment **any**
   of three holds, and not before: **reuse** (kept, re-run, version-pinned), **scale**
   (enough fan-out that intermediate results would flood the main loop's context — the
   one thing inline cannot give you; the test is context-flood, not a fixed file count),
   or **determinism/resume** (the journal + `resumeFromRunId`). Note these last two are
   distinct: *resume* recovers a **single partially-failed run within the same session**;
   re-running the workflow on each new PR (across sessions) is just a fresh launch every
   time — that's **reuse**, not resume, and resume's journal cache does not carry across
   sessions. Absent all three, stay on rung 3.
5. **Agent teams** — only when the workers must *talk to each other* mid-run
   (competing-hypothesis debate, hand-offs). Teams is opt-in and off by default; don't
   assume it's available — propose it to the user with the enable step when it fits.
   See [deep-grounding](../deep-grounding/SKILL.md) (*"Subagents vs. agent teams"*) for
   the decision axis and how to handle its opt-in availability — it owns that rung;
   don't duplicate it here.

The graduation that matters is **3 → 4**: keep work inline until reuse, context-scale,
or resume forces a compiled artifact.

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
   `references/patterns.md`). It defaults to `true` (staggers the burst to save
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

## The raw authoring path (one-offs)

Hand-write the `.js` when the job is a one-off, fits none of the nine patterns, or
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

### Schemas, model tiering, and agent routing — the digest

- **Schema at EVERY consumed boundary**, with anti-capitulation bounds
  (`minLength`/`maxLength`) — never blindly trust a raw string.
- **Model tiering:** mechanical/classify → cheap tier; synthesis/consolidation →
  medium; verifiers/judges → the strong model as a quality FLOOR.
- **Per-role effort mirrors the model choice** (low mechanical / high verifiers).
- **agentType routing:** default = the standard subagent, always. Launch-time
  requests travel in `args.agentTypes.<role>` (probe-resolved at entry, graceful
  fallback reported in the result's `probe`). Cross-family routing is something
  the composer PROPOSES to the user (plan-aware, decorrelate producer/verifier by
  FAMILY) — never silently applied, never silently skipped.
- **agentType is ALSO a capability fence** — deny by REMOVING tools in the agent
  definition, never by instruction alone.
- **Pure-reasoning stages should shed the ambient context.** A stage whose prompt is
  100% inline (classify / vote / score / dedup / synthesize — no "read the repo/diff" /
  "run git" instruction anywhere in it) pays the full ambient tool/skill injection on
  every spawn for capabilities it cannot use. TS compositions: route exactly those call
  sites through `withLeanRouting` (selective — a separate lean-defaulting runtime, never
  blanket; `withLeafFence` stays the blanket default and the scaffold wires it in). Raw
  sandbox scripts (no imports available): pass `agentType: 'workflow-toolbox:lean'` on
  the call's opts — safe whenever this plugin is installed, which is the case if you are
  reading this skill.

**Read [references/model-and-agent-routing.md](references/model-and-agent-routing.md)
BEFORE tuning schemas, models, effort, or any agentType routing** — it carries the
full rules, the measured evidence (reviewer A/B, GLM-Lite concurrency), the
cross-family proposal protocol, and the capability-fence how-to.

### Starting points

- **Templates** (skeletons to fill in): `assets/templates/fan-out.template.js`,
  `pipeline.template.js`, `loop.template.js`.
- **Runnable raw examples** (complete, working): `assets/examples/verify-findings.js`
  (refute-first triple-verification of claims passed via `args`) and
  `assets/examples/repo-health-snapshot.js` (fan-out per repo area + synthesis barrier).
- **Example agentType definitions** (copy-and-wire): `assets/examples/agents/reviewer.md`
  and `assets/examples/agents/verifier.md` — a diff-grounded multi-lens reviewer and a
  refute-first verifier, both read-only and fenced against `SendMessage`. See
  `assets/examples/agents/README.md` for wiring into `pr-review`'s `agentTypes.review` /
  `agentTypes.verify`.

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
- **A rejected launch is loud — read the error, then treat the run as never started.**
  A script that fails the module parse (or puts a statement before `meta`) is rejected
  synchronously with an explicit tool error and no run ids; a script that parses but
  breaks the sandbox dialect (e.g. any `export` beyond the leading `export const meta`)
  returns `status: "async_launched"` with **`error` set**. Either way it **never runs**.
  A successful launch's envelope carries no `error` — and launch acceptance is not run
  success (completion arrives asynchronously). Watch live progress with `/workflows`.
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
   resume with `resumeFromRunId` instead of re-running finished work. See
   `references/premise-quality.md` for the deeper doctrine — bounding every field
   against the model's output ceiling, giving agents a named "could-not-verify" out,
   and why premise quality (not agent count) caps what a fan-out can return.
9. **Never make correctness depend on a network tool.** A subagent's `WebFetch` /
   `WebSearch` access is environment-specific and, when a hook or sandbox denies it,
   fails **silently** — the agent answers blind from priors and its output looks
   identical to a grounded one. Ground any factual or doc claim the result depends on
   by passing the source as a file via `sourceRefs` (`Read` is never network-gated),
   or ground it out-of-band first and pass the conclusion in as `context`. See
   `references/premise-quality.md` (*Never make correctness depend on a network tool*).

## Worked example: the `pr-review` shape

**Read [references/worked-example-pr-review.md](references/worked-example-pr-review.md)
for the annotated walk-through** of the flagship composition (classify → lens
reviewers → refute-first verify → synthesize) — the shape to imitate for any
review-like workflow.

## Learning more

- `references/api-reference.md` — the evidence-tiered runtime reference: every global,
  option, cap, and failure mode, each tagged documented / observed / verified.
- `references/patterns.md` — the nine orchestration patterns as copy-paste recipes.
- `references/premise-quality.md` — premise quality caps the fan-out result: evidence,
  complete source listings, neutral framing, named could-not-verify outs, and the
  output failure modes to bound against.
- `references/orchestrator-pipelines.md` — human-gated multi-workflow jobs (L3).
- `references/shipped-compositions.md` — the 26 shipped compositions + operational lessons.
- `references/model-and-agent-routing.md` — schemas, tiering, effort, agentType routing.
- `references/observer-definitions.md` — authoring an observer (`<name>.observer.json`), the
  abstract-needs boundary, the selector/label coupling, and the `args.observers` launch bridge.
- `references/capability-needs.md` — giving a role more than the bare default via a
  workflow-owned `<name>.capabilities.json` sidecar of ABSTRACT needs (`$cap:<need>`),
  resolved per-machine at launch; the derivation pass, the machine-agnostic lint, adoption.
- `references/worked-example-pr-review.md` — the annotated pr-review walk-through.
