---
name: workflow-composer
user-invocable: true
description: >-
  Invoke ONLY when you are about to build, generate, repair, or restructure a workflow for Claude
  Code's Workflow tool and need authoring guidance or code changes, or when the user says "I
  want a workflow that…", "turn this process into a workflow", or "set up a multi-agent
  pipeline", or needs help picking orchestration patterns or tuning model, effort, or agentType
  routing. Write or repair the workflow artifact through the `@workflow-toolbox` path for
  repeatable work or the raw single-file path for one-offs. Not for debugging a specific failed
  run or re-verifying runtime drift after an upgrade.
---

# Authoring workflows for Claude Code's Workflow tool

A workflow moves a multi-step plan out of the conversation and into code. Normally
Claude is the orchestrator: it decides turn by turn what subagent to spawn, and
every intermediate result lands back in its context. A workflow inverts that — a
script holds the plan, the runtime executes it in isolation, and intermediate
results stay in script variables. Only the leaf `agent()` calls spend model
tokens; the loops, conditionals, and fan-out are plain deterministic JavaScript.

⚠ **Every `agent()` call is a Claude Code subagent, always — a workflow has no
primitive that runs a process or reaches another model directly.** Routing a role to
`codex:codex-rescue` or `workflow-toolbox:opencode-verifier` (see
`references/model-and-agent-routing.md`) still spends a Claude turn: that agent itself
shells out to an external CLI, and the host cannot see or reroute what happens inside
its call once it starts. Recognise this before authoring, not after: composing a
workflow that cannot do the job is wasted work.

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
- [references/patterns.md](references/patterns.md) — the nine orchestration patterns as copy-paste recipes.
- [references/patterns-execution.md](references/patterns-execution.md) — running and tuning those patterns.
- `references/premise-quality.md` — the authoring doctrine: how the quality of what
  you feed your agents (evidence, framing, complete source listings, a named
  "could-not-verify" out) caps what a fan-out can return, plus the failure modes that
  silently degrade agent output. Read it before writing the prompts, schemas, or
  `sourceRefs` for any analysis, audit, verification, or decision workflow.
- `references/orchestrator-pipelines.md` — human-gated multi-workflow jobs (L3).
- `references/shipped-compositions.md` — the 26 shipped compositions + operational lessons.
- `references/model-and-agent-routing.md` — schemas, tiering, effort, agentType routing, including
  the heavy-wrapper vs thin-envelope split (`workflow-toolbox:opencode-envelope`) and how to wire
  it through `agentTypes.<role>`. That reference also carries the shipped least-privilege
  agentTypes, including `workflow-toolbox:leaf-readonly` for read/search-only worker roles that
  must inspect the repo directly but must not execute, edit, or message.
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

Open [references/orchestration-ladder.md](references/orchestration-ladder.md) before choosing the orchestration rung.

## The toolkit path (repeatable workflows)

Open [references/toolkit-path.md](references/toolkit-path.md) when authoring a repeatable workflow, before writing or building its TypeScript definition.

## The raw authoring path (one-offs)

Open [references/raw-authoring-path.md](references/raw-authoring-path.md) when using the raw JavaScript authoring path, before writing its script, and before choosing agent-type routing (`withLeanRouting`, `withReadOnlyRouting`) for any composition.

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

The full reference-file index — every `references/*.md` file and what it covers —
is listed once, near the top of this skill, right after "There are **two ways to
author one**". Same files; not repeated here.
