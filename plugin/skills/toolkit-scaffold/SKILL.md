---
name: toolkit-scaffold
user-invocable: true
description: >-
  Scaffold a new Claude Code Workflow as a build-clean `.workflow.ts` skeleton from the
  @workflow-toolbox pattern toolkit, so you never hand-roll the `defineWorkflow` boilerplate. Invoke
  when the user describes a workflow they want and asks to "scaffold a workflow", "start
  a new workflow", "generate a workflow skeleton", "set up a .workflow.ts", "wire these
  patterns together", or "use the toolkit to build a workflow". Given a plain job
  description, pick the patterns (from the L1 use/don't-use table), write a small JSON
  spec, run `workflow-toolbox scaffold`, then fill in the placeholder prompts/data and build + check.
  Out of scope: deep one-off authoring guidance (that is the broader workflow-composer
  skill), diagnosing a failed RUN (workflow-debugger), and re-verifying the runtime after
  a Claude Code upgrade (upgrade-canary).
argument-hint: "<spec.json> [--out-dir <dir>] [--stdout] [--force] [--no-tsconfig]"
---

# Toolkit scaffold — a job description → a build-clean `.workflow.ts`

The toolkit exists to kill one failure mode: hand-rolling the `defineWorkflow` wrapper,
the imports, the `meta`, and each pattern call from scratch every time — re-deriving the
boilerplate by hand. `workflow-toolbox scaffold` turns a small structured spec into a **complete,
build-clean** workflow skeleton that compiles, builds, and passes the linter **as-is** —
a working starting point you then customize.

It is deliberately lightweight (the toolkit's P1/P6 philosophy): the scaffolder only
assembles the skeleton. **Choosing the patterns from the job description is your job** —
that is the judgment the L1 table below encodes.

## The workflow

1. **Read the job.** What does the workflow need to do, end to end?
2. **Pick the patterns** (L1 table). One pattern per logical step; name a phase for each.
3. **Write the spec** — a tiny JSON file:
   ```json
   {
     "meta": { "name": "my-workflow", "description": "One-line summary." },
     "steps": [
       { "pattern": "classifyAndAct", "phase": "Route" },
       { "pattern": "adversarialVerification", "phase": "Verify" }
     ]
   }
   ```
   `meta.name` must be non-empty kebab-case (same rule the build enforces). `pattern` is
   one of the nine canonical names below; `phase` is the title shown in the `/workflows` UI.
4. **Scaffold, then build + check** (see below).
5. **Fill in the placeholders** — the emitted prompts, the `items`/`claims`/`tasks` data,
   and any `as const satisfies JsonSchema` schemas at consumed agent boundaries. Re-build.

## Pick the pattern (L1 use / don't-use)

| Pattern | Use when | Do NOT use when |
|---|---|---|
| `classifyAndAct` | Distinct input categories handled better separately; classification is reliable | Categories blur, or one prompt handles all inputs — a single agent is simpler |
| `fanOutAndSynthesize` | Independent subtasks; the synthesis genuinely needs all results | Stages flow per-item (use a pipeline idiom); or N=1 |
| `adversarialVerification` | Findings will be acted on and a plausible-but-wrong one is costly | Low-stakes output; or no independent way to verify |
| `generateAndFilter` | Wide candidate space, cheap generation, clear filter criteria | Criteria can't be articulated — the filter becomes noise |
| `tournament` | Solution space is wide; one-attempt-iterated is weak; angles genuinely differ | Convergent task where attempts would be near-identical |
| `loopUntilDone` | Clear evaluation criteria + iterative refinement adds value; or unknown-size discovery | No articulable feedback; or a fixed list is known up front (just map it) |
| `planAndExecute` | Subtasks can't be predicted up front; a planner decomposes dynamically | Subtasks are known — use `fanOutAndSynthesize` (cheaper, more predictable) |
| `scoreAndRank` | Many items, only a few worth an expensive next stage; a cheap model scores them on independent dimensions; you want a ranked cutoff to aim the premium model/human at the top | Few items (just act); scoring signal is garbage (GIGO); or a binary keep/drop suffices — use `generateAndFilter` |
| `chunkedAnalysis` | Content too big for a single agent context (a large diff, a long log, a CSV); want a deterministic chunker + map-analyze-then-synthesize pass | Content fits one context — just `agent()` it, or `fanOutAndSynthesize` over sections you already have; or the per-chunk outputs ARE the answer and need no synthesis barrier — use `rt.pipeline` |

Steps run in spec order. Repeating a `phase` across steps groups them under one phase entry.

> **⚠ Verifier model (`adversarialVerification`).** Its verifier defaults to `BEST_MODEL`
> (the strongest *reliably-callable* tier — currently `'opus'`). The default is already
> safe; the trap is only a hand-override to a top-tier alias that is not callable in the
> consumer's environment (availability varies by plan and over time) — an uncallable
> alias errors at runtime.

## Run it

Works in **any** project — make sure the published toolkit trio is installed, then
drive the `workflow-toolbox` CLI:

```bash
# 0) one-time setup: the toolkit packages, from npm
pnpm add -D @workflow-toolbox/runtime @workflow-toolbox/patterns @workflow-toolbox/build

# 1) scaffold the skeleton into the current directory
npx workflow-toolbox scaffold path/to/spec.json --out-dir .
#    (or --stdout to preview without writing)

# 2) build it — typechecked — to a self-contained .js artifact, then lint that artifact:
npx workflow-toolbox build <name>.workflow.ts --typecheck
npx workflow-toolbox check workflows/<name>.js
```

In a pnpm-managed project, `pnpm exec workflow-toolbox …` is the equivalent of `npx workflow-toolbox …`.

Scaffold into a directory where the `@workflow-toolbox` imports resolve — normally the
project root where you just installed the trio. esbuild resolves the imports from the
scaffolded file's location, so a loose file outside such a project will NOT build.

What `workflow-toolbox scaffold` writes:

- **`<name>.workflow.ts`** — the skeleton (refuses to overwrite an existing file
  unless `--force`).
- **`tsconfig.json`** — a minimal config (`moduleResolution: "bundler"`), written
  **only when the target dir has none**; it never overwrites an existing one. Pass
  `--no-tsconfig` to opt out. It exists so the `--typecheck` step (and your editor)
  work out of the box; the CLI prints the `npx workflow-toolbox build <file> --typecheck` next step.

Prefer `--typecheck` over a bare build: esbuild strips types without checking them, so
a plausible-but-wrong option name would otherwise ship silently and only fail at
runtime, inside the sandbox. `--typecheck` uses your project's **own** `typescript`
install (it warns and continues if typescript isn't installed).

The freshly scaffolded skeleton builds + checks green **before** you edit it — proof the
wiring is sound. A representative all-patterns skeleton bundles to ~40 KB (well under
the 512 KB sandbox cap).

> **Maintainer note (this repo).** Inside the toolkit workspace the same loop runs as
> `cd toolkit && pnpm wt:scaffold path/to/spec.json --out-dir examples`, then
> `pnpm wt:build examples/<name>.workflow.ts` and `pnpm wt:check workflows/<name>.js`
> — `examples/` is the natural home because it already depends on the workspace packages.

## It is a STARTING POINT, not a finished workflow

The emitted file uses **placeholder** prompts and `['placeholder-item']`-style data so it
compiles and builds immediately. It is not yet useful — you must:

- replace each prompt's text with your real instruction,
- replace the placeholder `items`/`claims`/`tasks`/`angles` with your real inputs (usually
  derived from the workflow's `input`; the skeleton omits the `input` param — add it back),
- add `as const satisfies JsonSchema` schemas at every consumed agent boundary (the
  scaffolder emits none, to stay lint-clean as-is — see the **workflow-composer** skill for
  the schema-authoring contract),
- and replace the `loopUntilDone` placeholder `done: false` with your real stop condition.

The skeleton wires `withLeafFence(rt0, { phase: 'Fence' })` as the FIRST line of `run` —
every agent it spawns denies SendMessage by default (the toolkit's `workflow-toolbox:leaf`
agentType), gracefully falling back to the standard subagent if that agentType isn't
registered (e.g. the plugin isn't installed). Leave it as-is unless this workflow genuinely
needs its agents to coordinate, in which case pass `{ disabled: true }` (or thread the
launch-time `messaging: true` knob via `parseConfig`) — see `references/model-and-agent-routing.md`.

Optionally **tune the agents** (the scaffold emits none of these — add what you need):
per-role `<role>Model`/`<role>Effort` on any pattern; `adversarialVerification`'s
`verifierType` for a cross-model (e.g. `codex:codex-rescue`, GPT) verifier; or, for
launch-time tuning without editing the source, wrap once with
`withAgentDefaults(rt, defaults)` and/or parse an `args` config via `parseConfig`. See
the **workflow-composer** skill's `references/patterns.md` ("Tuning at launch").

**Consider an observer.** If the job has long-running roles, doc/spec surfaces to keep
aligned, drift risk across a fan-out, or a human gate, the workflow may benefit from an
out-of-band **observer** — propose one rather than wait to be asked, and emit it with
`workflow-toolbox scaffold observer <spec.json>`. The **workflow-composer** skill's
`references/observer-definitions.md` carries the trigger checklist and `docs-butler` as the
worked example.

## How it works (for maintenance)

The logic is a tested private package in the toolkit; there is no bundled plugin
artifact — instead the published `@workflow-toolbox/build` package inlines it into the
`workflow-toolbox` CLI, which is how `workflow-toolbox scaffold` works off-repo with no extra install.

- `@workflow-toolbox/scaffold` `scaffold.ts` — the pure `scaffoldWorkflow(spec)` emitter + `PATTERN_NAMES`
  and the `ScaffoldSpec`/`ScaffoldStep` types. Deterministic (same spec → byte-identical
  output); throws an actionable error on an invalid spec. Unit-tested.
- `cli.ts` — impure: reads the JSON spec, narrows its shape, writes `<name>.workflow.ts`.
  Held out of `pnpm test` (the @workflow-toolbox/smoke + @workflow-toolbox/debugger convention); still typechecked.
  The published `workflow-toolbox scaffold` subcommand (in `@workflow-toolbox/build`) wraps the same
  pure emitter and adds the tsconfig emission.
- The committed **all-patterns golden fixture** is typechecked by `pnpm typecheck` and
  linted by `pnpm lint`, so the guarantee "every emitted skeleton compiles and is lint-clean"
  is enforced by the normal gates, not just asserted.

Emission invariants that keep the output build-clean: `defineWorkflow` is imported from the
sandbox-pure `@workflow-toolbox/build/define` subpath; `meta` strings are emitted via `JSON.stringify`
(no template literal / no call inside the meta object, which the linter forbids there);
`loopUntilDone` (which has no `phase` option) gets `rt.phase(...)` before the call; every
bound `stepN` is referenced in the return.

Related: **workflow-composer** is the broader authoring guide (schemas, composition rules,
one-off workflows); **workflow-debugger** diagnoses a failed run; **upgrade-canary** checks
whether a Claude Code upgrade moved the runtime surface.
