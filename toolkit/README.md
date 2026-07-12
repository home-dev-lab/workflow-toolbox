# @workflow-toolbox — Dynamic Workflow Toolkit

## In plain words

Claude Code's Workflow tool lets a plain JavaScript script orchestrate dozens
of AI agents: the loops and the fan-out are deterministic code, and only the
leaf `agent()` calls think, each in a fresh context window. Powerful — but
every raw workflow re-invents the same machinery by hand: fan-out with
verification, loops with stop conditions, honest accounting of what got
dropped along the way.

This toolkit is the box of molded bricks for that baseplate: nine tested
orchestration patterns (classify-and-act, fan-out, adversarial verification,
tournament, loop-until-done, plan-and-execute, chunked-analysis…) that snap together with
ordinary `await` / `if` / `for` in TypeScript. You get type-checked contracts
at every agent boundary, compositions you can unit-test offline against a
fake runtime, and a one-command build that compiles a workflow into a single
self-contained `.js` the Workflow tool runs directly. The committed artifacts
under `workflows/` need no toolchain at all — point the Workflow tool at one
and it runs.

The rest of this README is the technical reference.

## What it is

A **compile-time** TypeScript pattern library for Claude Code Dynamic
Workflows (the `Workflow` tool, currently a research preview). It sits on top
of the runtime; it never replaces it.

The sandbox bans `import`/`require` and all Node APIs, so the library can only
reach the runtime as a **build artifact**: each workflow definition compiles
(esbuild) to one self-contained `.js` with the pattern functions inlined and
`meta` serialized as the literal first statement. Type safety, tests, and
contracts all live at compile time. See
[ADR 0001](../docs/public/adr/0001-compile-time-library.md).

Design principles (sourced in `docs/` ADRs and the Anthropic agent-building
guidance): simple composable patterns, not a framework; composition is plain
async TypeScript, never a DSL; the runtime owns durability/concurrency/state,
pattern code stays pure; schemas at every consumed boundary; every pattern
documents when **not** to use it.

## Layout

```text
toolkit/
├── packages/
│   ├── runtime/    # @workflow-toolbox/runtime  — sandbox typings + FakeRuntime (the ONLY
│   │               #   coupling point to Claude Code; unstable-surface firewall)
│   ├── patterns/   # @workflow-toolbox/patterns — the 9 patterns + result envelope
│   └── build/      # @workflow-toolbox/build    — defineWorkflow + the `workflow-toolbox` CLI (build/check)
├── examples/       # @workflow-toolbox/examples — 9 teaching workflows (*.workflow.ts; the
│                   #   monorepo-refactor pair and the dev-workflow family are
│                   #   multi-workflow L3 compositions — see docs/public/dev-workflow.md)
└── workflows/      # committed build artifacts (.js) — the runnable deliverable
```

Packages export TypeScript source directly (no build step); vitest and esbuild
consume it natively. Node ≥ 20, pnpm workspace.

```bash
pnpm install
pnpm typecheck   # tsc strict, all packages (src AND test)
pnpm test        # vitest, FakeRuntime-based
pnpm lint
```

## Authoring a workflow

A workflow definition is one TypeScript file, default-exporting
`defineWorkflow`:

```ts
// my-workflow.workflow.ts  (filename = meta.name, by convention)
import { defineWorkflow } from '@workflow-toolbox/build/define'   // ⚠ NOT '@workflow-toolbox/build' — see below
import type { WorkflowRuntime } from '@workflow-toolbox/runtime'
import { fanOutAndSynthesize } from '@workflow-toolbox/patterns'

export default defineWorkflow({
  meta: {
    name: 'my-workflow',                  // kebab-case, validated at call time
    description: 'One line, shown in the permission dialog',
    phases: [{ title: 'Review' }],
  },
  // Optional: validate/normalize the (already JSON-decoded) args into typed input.
  // Throw with an actionable message on bad input — fail fast, before any agent runs.
  parseInput: (raw): { target: string } => {
    if (typeof raw?.target !== 'string') {
      throw new Error('Pass { "target": "<git ref range or change description>" }')
    }
    return { target: raw.target }
  },
  run: async (rt: WorkflowRuntime, input) => {
    // Fan independent reviewers out over the input, then synthesize once all
    // return. (A fuller body — classify → reviewers → adversarial verify →
    // synthesis — is in examples/pr-review.workflow.ts.)
    const review = await fanOutAndSynthesize<string>(rt, {
      tasks: ['correctness', 'security', 'readability'],
      taskPrompt: (lens) => `Review ${input.target} for ${lens}. List concrete issues.`,
      synthesisPrompt: (parts) => `Merge these into one verdict:\n${parts.join('\n\n')}`,
      phase: 'Review',
    })
    return { verdict: review.value, warnings: review.warnings, stats: review.stats }
  },
})
```

`defineWorkflow` does exactly three things: build-time `meta`
extraction/serialization, `args` normalization (string args arrive
JSON-encoded — the normalizer is a proven necessity) + fail-fast input
validation, and binding the ambient sandbox globals into the typed `rt`
parameter ([ADR 0004](../docs/public/adr/0004-explicit-runtime-parameter.md)).
No lifecycle hooks, no middleware.

> **⚠ Import `defineWorkflow` from `@workflow-toolbox/build/define`, never `@workflow-toolbox/build`.**
> The package root re-exports the bundler (node:vm, esbuild) and breaks the
> platform-neutral bundle. `workflow-toolbox build` pre-flights this mistake with an
> actionable error.
> [ADR 0005](../docs/public/adr/0005-sandbox-pure-entry-subpath.md).

## Build → check → launch loop

```bash
# From toolkit/ — paths are relative to the toolkit root.

# Build: TS entry → self-contained .js (default out-dir: workflows/)
pnpm wt:build examples/my-workflow.workflow.ts

# Check: standalone sandbox lint of any artifact (meta-first, banned APIs, size)
pnpm wt:check workflows/my-workflow.js
```

Flags pass straight through (`pnpm wt:build entry.ts --minify`, `-o <dir>`).
The emitted artifact is byte-deterministic regardless of the invocation cwd —
module-path comments are anchored to the entry's directory, so rebuilds stay
diffable against the committed artifacts
([ADR 0002](../docs/public/adr/0002-commit-built-artifacts.md)).

The build emits readable (unminified) output by default — the artifact is what
users review in permission dialogs and edit for re-invocation. `--minify` is
an explicit escape hatch. `workflow-toolbox build` warns from 400 KB (the cap is 512 KB);
an oversized
workflow is usually two workflows with a checkpoint between them.

Launch via the Workflow tool, then **two non-negotiable habits**:

1. **Always check `WorkflowOutput.error`.** A script that fails its syntax
   check still returns `status: "async_launched"` with `error` set — and never
   runs. Silence is not success.
2. **On partial failure, relaunch with `resumeFromRunId`.** Completed
   `agent()` calls replay from the journal cache (same session); only the
   missing or failed work re-runs — no redoing finished analysis.

Invocation paths, in order of reliability right after a build:

- `scriptPath: "toolkit/workflows/my-workflow.js"` — always works, no install.
- `name: "my-workflow"` after copying into `.claude/workflows/` — the registry
  is keyed by `meta.name` (not the filename — keep them equal), refreshes
  lazily mid-session, and **silently excludes** files over 512 KB.
- Plugin-shipped workflows resolve as `plugin-name:workflow-name`.

## The pattern library (L1)

Every pattern takes `rt` plus a typed options object and returns the standard
envelope (below). All but one assign their agents to a caller-provided
`phase` — the exception is `loopUntilDone`, which has no `phase` option (call
`rt.phase()` before it); it spawns no agents itself but counts the body's
`agent()` calls, made through the `rt` the body receives (including via
`rt.parallel`/`rt.pipeline` thunks), into `stats.agentsSpawned`, while its
trail stays per-iteration (`trail.length === iterations`). Each speaks its own
domain language (claims, tasks, angles…) — deliberately not a
uniform `items` API.

| Pattern | Also known as | Use when | Do NOT use when |
|---|---|---|---|
| `classifyAndAct` | · Routing<br>· intent classification<br>· dispatcher | Distinct input categories handled better separately; classification is reliably accurate | Categories blur, or one prompt handles all inputs — a single agent is simpler |
| `fanOutAndSynthesize` | · Parallelization (sectioning)<br>· map-reduce<br>· scatter-gather<br>· fan-out/fan-in | Independent subtasks; synthesis genuinely needs **all** results | Stages flow per-item — use `rt.pipeline`; or N=1 |
| `adversarialVerification` | · Parallelization-voting<br>· LLM-as-judge (ensemble)<br>· self-consistency<br>· critic/verifier | Findings will be acted on and a plausible-but-wrong one is costly | Low-stakes output; or no independent verification method exists |
| `generateAndFilter` | · Generation + evaluator (single pass)<br>· best-of-N<br>· rejection sampling<br>· generate-and-rank | Wide candidate space, cheap generation, clear filter criteria | Criteria can't be articulated — the filter becomes noise |
| `tournament` | · Judge panel + synthesis<br>· best-of-N selection<br>· LLM-as-judge tournament | Wide solution space; angles genuinely differ | Convergent tasks where attempts would be near-identical |
| `loopUntilDone` | · Evaluator-optimizer<br>· iterative refinement<br>· self-refine / Reflexion<br>· loop-until-dry | Clear evaluation criteria + iteration adds measurable value; unknown-size discovery | No articulable feedback; or a fixed list is known up front (just map it) |
| `planAndExecute` | · Orchestrator-workers<br>· plan-and-execute (LangChain)<br>· planner-executor | Subtasks can't be predicted up front; a planner decomposes dynamically (its `PlanAndExecuteResult` also exposes the surviving `workerResults`, not just the synthesis) | Subtasks are known — `fanOutAndSynthesize` or `rt.pipeline` is cheaper and more predictable |
| `scoreAndRank` | · Targeting machine<br>· cheap-model triage<br>· impact × opportunity ranking<br>· prioritized sweep | Many items, only a few worth an expensive next stage; a cheap model can score them on one+ independent dimensions; you want a ranked cutoff to **aim** the premium model/human at the top | Few items (just act); scoring signal is garbage (GIGO); or you need a binary keep/drop rather than a ranking — `generateAndFilter` |
| `chunkedAnalysis` | · Chunked map-reduce<br>· RLM-like long-context<br>· map-analyze-then-synthesize<br>· sectioning by size | Content is too large for one agent context (a big diff, log, or CSV): a deterministic **char-based** chunker splits it, each chunk is analyzed in parallel, one synthesis folds the results (its result also exposes the surviving per-chunk `chunkResults`) | Content fits one context — `fanOutAndSynthesize` over sections you already have; or the per-chunk outputs are the answer and need no synthesis (`rt.pipeline`) |

> In each row the first term is Anthropic's [*Building Effective Agents*](https://www.anthropic.com/engineering/building-effective-agents) vocabulary; the rest are common cross-ecosystem names for the same shape (different frameworks, same orchestration).

### `cacheWarm` — opt-in cache-warm staggering for concurrent fan-outs

`fanOutAndSynthesize`, `chunkedAnalysis`, `planAndExecute`, `scoreAndRank`,
`generateAndFilter`, `classifyAndAct`, `adversarialVerification`, and
`tournament` accept an opt-in `cacheWarm?: boolean` (default `false`, inert —
byte-identical to omitting it). A fan-out of N concurrent agents pays a
redundant prompt-cache **write** cost: each agent writes the identical shared
system/tools prefix to the provider's cache before any single write becomes
reusable by the others. `cacheWarm: true` staggers the burst so one call's
write lands before the rest launch, letting them **read** the warmed cache
entry instead. This is a **heuristic cost/latency lever** — provider-side
cache behavior is not guaranteed and is not measured by this toolkit — never a
correctness change.

Two mechanisms, picked per pattern by its burst shape:

- **first-completes-then-burst** (`fanOutAndSynthesize`, `chunkedAnalysis`,
  `planAndExecute`, `scoreAndRank`, `generateAndFilter`, `classifyAndAct`): the
  first real task runs alone to completion, then the rest launch concurrently.
  Zero extra agents; costs +1 task's latency on the critical path. Works even
  when different items in the same burst resolve to different models (e.g.
  `scoreAndRank`'s per-dimension `model` override), since the peeled-out call
  is one of the real agents, never a stand-in.
- **warmup-agent** (`adversarialVerification`, `tournament`): a single
  throwaway agent (on the SAME model/agentType as the burst — a different
  model does not share the prefix cache) runs first, then the full burst
  launches at full concurrency. Chosen where every agent in the burst shares
  one uniform model and the burst is typically small (e.g. a 3-vote verifier
  panel), so losing one real slot to serial execution would cost
  proportionally more than a single extra agent. A failed warmup only warns —
  the real burst always proceeds.

The other layers:

- **L0 — runtime primitives** (`rt.agent`, `rt.parallel`, `rt.pipeline`,
  `rt.phase`, `rt.log`, `rt.budget`, `rt.workflow`): used directly, never
  wrapped. Prompt chaining is deliberately not a pattern — it's two sequential
  `await rt.agent(...)` lines.
- **L2 — compositions** (`examples/`): plain async functions calling several
  patterns. They are **templates, not library API** — copying and editing one
  is the intended usage.
- **L3 — checkpointed compositions (HITL)**: there is no mid-run user input in
  Dynamic Workflows, so a human gate = a **workflow boundary**. Stage 1
  returns an artifact; the human approves/prunes it; stage 2 takes it via
  `args` and **re-validates it** (that re-validation is the point of the
  checkpoint). See the `monorepo-refactor-plan` / `monorepo-refactor-execute`
  pair.

## Composition rules

1. In-file composition is the default — patterns compose with plain `await`,
   `if`, `for`.
2. **`pipeline` by default between stages; `parallel` only for genuine
   cross-item needs** (dedup, merge, count-based early-exit). A barrier wastes
   the fast items' idle time.
3. **Schema at every consumed boundary** — any agent result a later line reads
   a field off must carry a `schema`. Free text only when passed whole into
   another prompt.
4. Data crosses agent boundaries as prompt text (`JSON.stringify` into the
   next prompt) — the orchestrator shares no memory with subagents.
5. `rt.workflow()` nesting is reserved for frozen, independently-owned
   workflows (one level only); the library never builds compositions that
   nest.
6. Every loop has a typed stop condition — `maxIterations`, `dryRounds`, or
   `budgetFloor`; omission is a compile error.
7. Parallel **mutating** agents require `isolation: 'worktree'` (expensive —
   per-agent setup; never for read-only analysis), and mutating compositions
   sit behind an L3 human checkpoint.

## The result envelope

Every pattern returns:

```ts
interface PatternResult<T> {
  value: T            // the pattern's product (see each pattern for its T)
  stats: {
    itemsIn: number   // work units received
    itemsOut: number  // work units surviving
    agentsSpawned: number
    dropped: number   // null results (skip/error/budget) — counted, never silent
    truncated: number // cap-induced omissions — counted, never silent
  }
  warnings: string[]  // human-readable coverage caveats (also log()-ed live)
  trail: TrailRecord[] // audit trail: which agent did what, deterministic order
}

interface TrailRecord {
  stage: string            // pattern-qualified step id, e.g. 'planAndExecute:work:3'
  outcome: 'ok' | 'null'   // 'null' = the agent returned null (skip / error / budget)
  model?: string           // only set when the pattern passed an explicit model override
  decision?: string        // typed control value taken at this step (e.g. 'subtasks=5', a
                           //   verdict enum, a stoppedBy value) — never free prose or payloads
}
```

For synthesis-bearing patterns (`planAndExecute`, `fanOutAndSynthesize`,
`tournament`), `value === null` while `stats.itemsOut > 0` signals a failed
synthesis stage — the per-item work survived (and `planAndExecute` additionally
exposes it via `workerResults`).

The `trail` is the **traceability artifact**: a structured, replayable record of
which agent did what and what was decided — the enterprise audit trail of a run.
It is **metadata only** — no agent payloads, no timestamps; the array order *is*
the chronology, built deterministically so a `resumeFromRunId` replay reconstructs
it identically. `trail` is **required** on every pattern (tsc enforces no
construction site can omit it). Trail semantics are per-pattern, like `dropped`:
direct-spawn patterns emit one record per agent (`trail.length === stats.agentsSpawned`),
whereas `loopUntilDone` records loop **iterations** (stage
`loopUntilDone:tick:<i>`) while `stats.agentsSpawned` counts the body's
`agent()` calls through the `rt` it receives (including via
`rt.parallel`/`rt.pipeline` thunks) — so `trail.length === iterations` and
`trail.length !== agentsSpawned` for that pattern.

No silent caps, ever: every `max*` option reports what it cut. For
`adversarialVerification`, a cap never destroys evidence: claims cut by
`maxVerifyClaims` stay in the output (`itemsIn === itemsOut`) and carry the
distinct claim verdict `'unverified-by-cap'` (`votes: []`, no trail records —
`trail.length === stats.agentsSpawned` still holds), counted in
`stats.truncated` and reported via a warning. That is different from
`'unverifiable'` (verifiers ran and **all** failed: `votes` is a non-empty
array of nulls, counted in `stats.dropped`). The full claim-level vocabulary is
the exported `ClaimVerdict` type — `'confirmed' | 'partially-confirmed' |
'refuted' | 'unverifiable' | 'unverified-by-cap'`; the 4-value agent-vote
schema is unchanged (agents never emit the cap verdict). Backward
compatibility: callers keying on `'refuted'` are unaffected — treat
`'unverified-by-cap'` with the same kept-and-flagged handling as
`'unverifiable'` (additive, semver-minor; ships in
`@workflow-toolbox/patterns` 0.3.0). In
compositions, use the `warn(rt, warnings, msg)` helper only for
composition-originated warnings (it records **and** live-logs); warnings
propagated from a pattern's envelope are pushed plain — re-warning would
double-log.

Severity-aware votes: `adversarialVerification` also takes
`votesPerClaim?: (claim) => number` to scale the verifier-vote count per claim
(integer ≥ 1, validated for every claim synchronously at entry — nothing
spawns on a bad mapping). The refute threshold is clamped per claim to
`min(refuteThreshold, claimVotes)`, so a 1-vote claim is decided by its single
refute-first vote. Cannot be combined with `lenses` (one lens per vote needs a
fixed count). `dev-review-fix` uses it to spend 1 vote on `low` findings and
keep the 2-of-3 quorum on `medium`/`high`; `dev-plan` (task `risk`) and
`monorepo-refactor-plan` (proposal `impact`) wire the same low:1 / else:3
mapping (additive, semver-minor; ships in `@workflow-toolbox/patterns` 0.5.0
together with `relativizeUnder`).

Specialist verifiers: `adversarialVerification` also takes
`verifierType?: string` to route **every** refute-first verifier agent to a
specialist subagent type via the Agent tool's `agentType` (omit for the standard
subagent). Shape-only validated (non-empty string); the runtime owns registry
membership and *throws* on an unknown type — so never hard-code a private
(`magic-claude:*`) type as a default in a published artifact. It is a
**flexibility knob, not a proven quality win**: a controlled A/B measured a
specialist *reviewer* at a ~50% false-positive rate, and a refute-first verifier
benefits *least* from domain specialization — prefer specializing the producer
(the reviewer feeding this stage) over the skeptic. Routing is surfaced on the
agent call only; the trail is intentionally not extended (the `model` field
already covers the pattern's load-bearing audit concern). Additive, semver-minor;
ships in `@workflow-toolbox/patterns` 0.6.0.

The "specialize the producer, not the skeptic" caveat above is about *same-model*
specialization. The **premier use of `verifierType` is the opposite — cross-model
decorrelation**: routing to a *different model family* is the one real lever
against same-model correlated errors. `verifierType: 'codex:codex-rescue'` runs
every refute-first verifier on a non-Claude (GPT) model — verified to honor the
structured verdict schema from inside a workflow. Crucially, this routes ONLY the
skeptic: the producers stay on the session model, which `withAgentDefaults({ agentType })`
(blanket, all-or-nothing) cannot express. Launch-time exposure: `cross-model-verify`
and `independent-analysis` take the request via the structured config envelope
(`args.agentTypes.verify`) and PROBE it at entry (`probeAgentType`) with a graceful
fallback to the standard verifier; `pr-review` routes its lens reviewers likewise
via `args.agentTypes.review` (the same role key as `effort.review`). The dev family (`dev-plan` Critique,
`dev-review-fix` Verify, orchestrated by `dev-full`) still takes a bespoke
`verifierType` input.
The plugin also ships **`workflow-toolbox:opencode-verifier`**, a second
cross-family verifier that routes to any `opencode` model (default GLM 5.2 /
zai-coding-plan — a *different* family again) and degrades gracefully to a Claude
fallback (`OPENCODE_UNAVAILABLE`) when opencode isn't installed or no provider is
authenticated. Caveat: both `codex-rescue` and `opencode-verifier` are
local-machine-only (each needs its own setup + login) and opt-in; for a fully
portable endpoint prefer an MCP→model bridge.

The same per-role `agentType` routing now generalizes beyond the verifier: every
fan-out/synthesis pattern exposes a `<role>Type` knob (`taskType`/`synthesisType`,
`generateType`/`filterType`, `attemptType`/`judgeType`/`synthesisType`,
`planType`/`workerType`, `scoreType`, `classifyType` + a per-action
`ActionSpec.agentType`), so *any* role can be routed to a different model family —
the composer's lever for decorrelating a producer from its verifier. Omit every
knob for the standard Claude subagent.

Path mapping: `relativizeUnder(root, path)` is the boundary-safe POSIX
relativization kernel promoted from the dev-workflow family. It answers ONE
question — "can `path` be expressed relative to `root`?" — returning the
relative remainder (`relativizeUnder('/repo', '/repo/src/x.ts')` → `'src/x.ts'`,
trailing slashes on the root tolerated) and `null` in every case it cannot
prove containment: a relative or `/` root, a path outside the root, an
adjacent-prefix lookalike (`/a/b` never matches `/a/bc/file` — segment
boundaries, not string prefixes), or `path === root` (no relative form). The
null policy IS the contract: the helper never warns, throws or falls back —
what to do with an unmappable path (warn-and-keep, throw, pass through) stays
a caller decision, which is exactly why three call sites with three different
terminal policies share it.

## Trust no agent's self-report

Agents can die mid-reasoning at their context limit — and their last
mid-thought text arrives as a normal-looking completion. The examples encode
four defence layers (see `examples/pr-review.workflow.ts`):

1. **Schema at every consumed boundary** — catches truncation and shape drift.
2. **Fresh-evidence checker stage** — verifiers re-derive from the actual
   source (diff, files, commands), never from the worker's summary;
   refute-first framing kills plausible-but-wrong findings.
3. **Decomposed agent scopes** — small focused contexts; oversized scopes are
   the root cause of mid-reasoning death.
4. **Launch hygiene** — check `WorkflowOutput.error`; resume with
   `resumeFromRunId` instead of re-running finished work.

## Budgets and model tiering

Budgets are opt-in (the user's `+500k`-style directive); with no target,
`rt.budget.total` is null and `remaining()` is `Infinity` — guard on
`budget.total` before any budget-driven loop. `budgetFloor` decides where a
cut falls: breadth (fewer rounds) rather than integrity (dying
mid-verification), reported via `stoppedBy` and a coverage warning. A
floor-stopped run is a **checkpoint, not a loss**: review the partial result,
relaunch with `resumeFromRunId`.

**Calibrating a floor (`pnpm wt:calibrate`).** Picking a `budgetFloor` number
is data-driven, not guesswork. `pnpm wt:calibrate record` drives a small probe
workflow through the real runtime and appends one run record (the runtime agent
count + `rt.budget.spent()` + the completion notification's `usage`) to the
gitignored `run-stats/runs.jsonl`; `pnpm wt:calibrate derive` reads the log and
prints `floor ≈ tokens-per-agent × (expected claims × votes + synthesis) ×
margin` (with `votesPerClaim`, `claims × votes` is an upper bound only when
the mapping never exceeds `votes` — low-vote claims spend less; a mapping that
returns more than `votes` makes it an under-estimate, so size the formula with
the max over claims instead). The maintainer loop: run real workflows against real codebases, `record`
after each, and once ~10 have accrued, `derive` and fold the number into the
guidance here. **Honesty:** the runtime exposes no per-agent token primitive, so
tokens-per-agent is a cross-run approximation, and the two token signals are kept
**segregated** — `budget.spent()` is OUTPUT tokens (the metric the floor compares
against via `remaining()`; it scales with agent count plus a small fixed launch
overhead) while the notification `total_tokens` is the in+out total (it scales
linearly with sub-agents — verified 2×agents → 2×tokens). The probe's echo agents
are cheap, so its tokens-per-agent is a **lower bound**; real best-model
verifiers cost far more, which is exactly why the floor carries a safety margin.

Model tiering: mechanical high-volume leaf work → `'haiku'`; judgment work →
inherit the session model. Verification quality is model-sensitive — verifiers
default to `BEST_MODEL` (a constant exported by `@workflow-toolbox/runtime`,
currently `'opus'` — the constant names the strongest *reliably-callable* tier,
not merely the newest; top-tier alias availability varies by plan and over time),
and explicitly passing anything weaker logs a warning.
In-repo adopter: dev-review-fix routes its consolidation agent (a mechanical
dedup/merge, ~44k tokens measured) to `'sonnet'` — safe because the merge is
triple-netted (in-code concat fallback, integrity guards, downstream
adversarial verification of every finding); reviewers, verifiers, fixer and
checker stay untiered. Its other cost lever is adaptive dimensions: a
docs-only `changedFiles` set defaults to two reviewers instead of four
(deterministic extension allowlist, loudly warned, explicit `dimensions`
always wins).

**Effort tiering** is the sibling axis to model tiering: every pattern's
`effort?: EffortAlias` option (omit = inherit the session effort) lets a stage
run at a cheaper reasoning tier than the session default. The bundled
compositions (`toolkit/examples/*.workflow.ts`) pin a stage-CLASS default at
each call site — classify/mechanical/routing → `'low'`, synthesis/consolidation
→ `'medium'`, reviewer/implementer/fixer/planner → `'high'`, adversarial
verifiers/judges/checkers → `'high'` as a FLOOR — instead of silently
inheriting the session effort. `@workflow-toolbox/std` exports
`resolveEffort(argsValue, stageDefault)` (falls back to the stage default on
undefined/invalid input, never throws) and its verifier-site variant
`resolveVerifierEffort(argsValue, stageDefault, floor = 'high')` (clamps UP
only — an override can raise a verifier's effort, never lower it below the
floor). Callers retune a composition's effort per role at launch time via the
existing Class B/C `parseConfig(args).effort` role map (`args: { effort: {
judge: 'xhigh' } }`) — the same convention that already carries `models` — so
one config channel governs both axes.

## Auditing a run (`pnpm wt:report`)

Every Workflow run leaves a structured journal on disk
(`$CLAUDE_CONFIG_DIR/projects/<project>/<session>/workflows/wf_<runId>.json`,
default config dir `~/.claude`).
`pnpm wt:report [runId|latest] [--project <slug>] [--out <dir>] [--quiet]`
turns one journal into a **cost + traceability audit report**: run identity
(incl. `taskId`), a per-agent cost rollup (model / tokens / tool calls / phase)
**reconciled** against the run's total token count, the decision trail, and
best-effort links to each agent's transcript.

The report **always prints to stdout** — the data is never withheld, so the
session always has it. Setting `$DWT_WORKFLOW_LOG_DIR` (or passing `--out <dir>`)
**additionally** writes a persistent audit folder
`<dir>/<runId>/{ report.md, journal.json, transcripts/agent-<id>.jsonl }`
for enterprise audit trails — off by default, so individuals get zero disk
side effects.

**Honesty:** transcripts are best-effort — the journal persists, but the
per-agent `.jsonl` files are pruned by Claude Code's >30-day cleanup, rendered
as "not captured" rather than implied. The decision trail is sourced from the
always-present per-agent journal rows, enriched by the result envelope's trail
when present. And there is **no per-workflow completion hook**: `TaskCompleted`
fires for the teammate/todo system, not for Workflow background tasks (verified
empirically), so the report is journal-driven.

**Automatic surfacing at run end** ships as a plugin `Stop` hook
(`plugin/bin/wt-stop-hook.mjs`). It detects a finished background workflow by
diffing the `Stop` payload's `background_tasks[]` across firings, maps the task
to its journal by `taskId`, and surfaces the report **hybrid-style**: always a
one-line notice to you, plus — only when the run looks like trouble (failed /
agent-died / schema-retries) — it grabs the session with a compact report so you
act on it. Healthy runs stay quiet. The audit folder is still written only when
`$DWT_WORKFLOW_LOG_DIR` is set, and the hook never breaks the session.

Sibling tool: **`pnpm wt:debug [runId|latest]`** reads the same journal for the
other question — not "what did it cost?" but "why did it fail, and will a
`resumeFromRunId` actually save work?". Reach for `wt:debug` when a run errored
or stalled; reach for `wt:report` when you need the cost + traceability picture
of any run (success or failure).

Third sibling: **`wt-observe`** (the bundled CLI — `start|stop|status`) drives a
local browser UI over the SAME journal: replay a finished run's phase→agent DAG,
or watch a live one. ONE server always runs, resolving 1+ Claude config dirs —
**`wt-observe start [--source <dir>]...`** — 1 resolved source serves it
unprefixed (a personal `~/.claude`, say); a machine running several config dirs at
once (a personal `~/.claude` and a work `~/.claude-work`) resolves 2+ and gets a
source switcher in the UI automatically, no separate verb needed. With no
`--source` flags, a persistent source list (`<observeConfigRoot>/config.json`,
managed via `wt-observe config show|add-source|remove-source`) wins if configured,
else it auto-discovers existing dirs — `$CLAUDE_CONFIG_DIR` plus every `~/.claude` /
`~/.claude-<name>` sibling (a glob, e.g. `~/.claude-work`, `~/.claude-acme`) that also
has a `projects/` run store (a name match alone isn't enough — a stray
`~/.claude-backup` isn't discovered). Reach for `wt-observe` when you want to *see* the
run, not just read a report.

## Testing

Patterns and compositions are tested end-to-end against `FakeRuntime`
(`@workflow-toolbox/runtime`): scripted deterministic agents via an `onAgent` handler,
with assertions on spawned-agent calls (`calls`, including per-call `opts`),
`phases`, `logs`, and envelope stats. The bundler is golden-file tested;
emitted artifacts are linted by `workflow-toolbox check`.

## Stability

The Workflow tool is a research preview, and part of its surface
(`agent()` options, `log`, `budget`, determinism bans, the 512 KB cap) is
binary-verified rather than documented. All of it is firewalled behind
`@workflow-toolbox/runtime` — if a Claude Code update changes the surface, exactly one
package changes. Re-verify on upgrades with the smoke canary below.

## Smoke test (upgrade canary)

`pnpm smoke` exercises the committed artifacts against the **real** Workflow
runtime — the check to run before a release and after every Claude Code
upgrade:

```bash
# From toolkit/. Runs under your local Claude Code subscription (the TS Agent
# SDK reuses ~/.claude credentials — no API key in env). NOT part of `pnpm test`.
pnpm smoke
```

It has two tiers, both driving the Workflow tool through the
[TS Agent SDK](https://docs.claude.com/en/api/agent-sdk/typescript) (≥ 0.3.149,
which is where the Workflow tool ships):

- **Tier 1 — launch canary.** Launches every `workflows/*.js` and asserts the
  runtime still accepts it (no syntax-check error). Arg-less launches are safe:
  each workflow's `parseInput` throws before any agent runs.
- **Tier 2 — round trip.** Launches the dedicated `packages/smoke/wt-smoke.js`
  to completion and asserts its `PatternResult` envelope arrived intact.

The message-parsing and verdict logic lives in `@workflow-toolbox/smoke` and is unit-tested
in `pnpm test` against real captured SDK messages; only the live runner is held
out (it spends real agent runs). A non-zero exit means an upgrade moved the
surface — start firewalling in `@workflow-toolbox/runtime`.

`pnpm smoke` covers the *positive* path against the bundled runtime. The upgrade
canary builds on it:

```bash
pnpm canary          # the matrix: smoke + edge (negative) + nesting against BOTH
                     # runtimes (system + bundled), prints a SUMMARY (per-runtime
                     # CC version, SDK⇒bundled-CC mapping, latest SDK on npm) and a
                     # WHAT CHANGED section, then records the per-machine marker.
                     # --target narrows.
pnpm canary:edge     # just the negative checks (cap + meta-order) on the bundled runtime.
pnpm canary:nesting  # canary C1: workflow() rejects nesting past one level (a
                     # parent→child→grandchild round trip) on the bundled runtime.
pnpm canary:version  # read-only gate: exit 0 = unchanged since last pass (skip),
                     # 3 = a signal changed / forced (run), 2 = error.
```

Two runtimes drive `@workflow-toolbox` workflows and drift independently: the **system**
`claude` CLI (auto-updates) and the **bundled** binary inside the Agent SDK
(moves on `pnpm update`). `pnpm canary` runs the checks against each, reads the
measured Claude Code version from each run's init message, and diffs the outcome
against the last run — so a version move, a check flip, or rejection-wording drift
shows up in **WHAT CHANGED** (which can drive a fix or feature). The negative
checks catch the regression where an upgrade silently *accepts* an oversized or
`meta`-disordered script. The nesting check (canary C1) catches the regression
where an upgrade silently *allows* `workflow()` nesting past one level — it
launches a parent→child→grandchild round trip and asserts the child's OWN nested
`workflow()` call is rejected (depth-1, parent→child, is asserted too, as a
positive control: otherwise a broken `workflow()` that never reaches the child
would masquerade as "nesting rejected"). It does NOT check the `name`-registry-keyed-by-`meta.name`
behavior (side-effectful, not headlessly checkable, least load-bearing since
`workflow-toolbox build` keeps filename == `meta.name`). The **`upgrade-canary` plugin skill**
is the operator playbook: gate on a version change, run the matrix + `wt:check`,
interpret the report. `canary` is the sole writer of the marker; `canary:version`
only reads it. All live canaries are out of `pnpm test`.

## Decisions

Architecture decision records live in [`docs/public/adr/`](../docs/public/adr/):

- [0001 — Compile-time pattern library, not a runtime framework](../docs/public/adr/0001-compile-time-library.md)
- [0002 — Commit built workflow artifacts](../docs/public/adr/0002-commit-built-artifacts.md)
- [0003 — JSON Schema + json-schema-to-ts, not zod](../docs/public/adr/0003-json-schema-over-zod.md)
- [0004 — Explicit runtime parameter, not ambient globals](../docs/public/adr/0004-explicit-runtime-parameter.md)
- [0005 — Sandbox-pure entry subpath `@workflow-toolbox/build/define`](../docs/public/adr/0005-sandbox-pure-entry-subpath.md)

## License

[PolyForm Noncommercial 1.0.0](../LICENSE) — free for any noncommercial
purpose; commercial use requires a separate license, see
[COMMERCIAL-LICENSE.md](../COMMERCIAL-LICENSE.md).
