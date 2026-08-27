# Pattern execution, tuning, and reporting

Continues [patterns.md](patterns.md) — the nine orchestration patterns (routing,
fan-out+synthesize, refute-first verification, generate+filter, tournament,
loop-until-done, orchestrator-workers, triage+rank, chunked analysis) and their
shared conventions live there. This file covers RUNNING and TUNING those
patterns: rung-3 DAG-execution companions, per-role model/effort/agentType
knobs, cache-warm, `stageKey` salting, composition idioms, schemas, honest
reporting, and cost engineering.

## Rung 3 companions — generic DAG execution, a persisted shape, and budgeted named forms

These three are exported from `@workflow-toolbox/patterns` alongside the nine canonical
patterns above, but are NOT one of the scaffold tool's nine `PATTERN_NAMES` — they exist
specifically to make rung 3 (inline, hand-run fan-out in the main conversation loop, see
`SKILL.md`'s orchestration ladder) practical without hand-rolling the wave/dispatch
machinery, or the private `dev-implement.workflow.ts` example, every time.

### Generic wave-parallel DAG execution — `dagExecute`

**Use when:** you have an arbitrary set of nodes with `dependsOn` edges (a diamond: two
independent nodes feeding a third; or wider/deeper graphs) and want independent nodes at
the same dependency level to run CONCURRENTLY, not one at a time. This generalizes the
wave computation `dev-implement.workflow.ts`'s worktree mode already does bespoke
(Kahn-level waves dispatched via `rt.parallel`) into a reusable, typed pattern any
workflow — or any inline rung-3 fan-out — can call instead of re-deriving it.
**Do NOT use when:** the graph is a single connected chain (no independent nodes at any
level) — a plain sequential loop is simpler and identical in wall time; or the "auto"
mode's shared-worktree-per-lane constraint applies (tasks sharing ONE worktree cannot run
concurrently regardless of the pattern used — that is a resource constraint, not a
dispatch-shape one).

```js
const { value, stats, trail } = await dagExecute(rt, {
  nodes: [
    { id: 'A', dependsOn: [] },
    { id: 'B', dependsOn: [] },
    { id: 'C', dependsOn: ['A', 'B'] },
  ],
  run: async (node) => agent(`do the work for ${node.id}`),
})
// value.waves === 2 (A,B concurrent, then C); value.results carries per-node status
```

**Toolkit:** `dagExecute(rt, options: DagExecuteOptions<TNode, TOut>)` returns the
standard envelope wrapping a `DagExecuteResult<TNode, TOut>` (`value: { results:
DagNodeResult<TNode, TOut>[], waves }`, `stats`, `warnings`, `trail`). Config errors
(empty `nodes`, a duplicate `id`, a `dependsOn` referencing an unknown id, or a CYCLE)
throw synchronously before any node runs — a cycle is a hard error here, not silently
dropped, because a general-purpose pattern has no upstream validator guaranteeing
acyclicity the way `dev-implement`'s L3 boundary does. A node whose dependency did not
succeed is `'skipped'` (computed in code, never attempted) — the same skip semantics as
`dev-implement`'s per-task reporting.

**Measured:** a controlled synthetic test (fixed per-node
latency, isolating the dispatch mechanism from real API-call variance) confirmed the
theoretical 1.5x speedup for a 2-wave diamond exactly. Two small real runs against the
production runtime, on a trivial 3-node diamond with one-word replies, were inconclusive
(1.32x and ~1.0x) — real per-call latency variance swamps the signal at this tiny a
scale. The mechanism (`rt.parallel` is a genuine `Promise.all`, confirmed by reading
`@workflow-toolbox/runtime`'s fake and its documented contract) is sound; the practical
payoff grows with wave WIDTH (more concurrent nodes) and per-node DURATION (real TDD
loops run minutes, not seconds) — both amortize the fixed per-call overhead that
dominated the tiny-diamond measurement. This pattern's value proposition is reuse and
correctness (cycle detection, deterministic waves) as much as raw speed on a small graph.

### A persisted, re-readable DAG shape — `serializeDagArtifact` / `parseDagArtifact`

**Use when:** rung 3's shape should survive the conversation that produced it — a later
session (yours or someone else's) should be able to re-read a `{name, nodes}` graph shape
from disk without re-deriving it from a transcript. This is rung 3's missing persisted
artifact: the shape becomes a file you can diff and reuse weeks later, without the
build/typecheck/commit ceremony of compiling a full `.workflow.ts`.

```js
const artifact = serializeDagArtifact({ name: 'my-shape', createdAt: new Date().toISOString(), nodes })
// write artifact (JSON.stringify) to a <name>.dag.json file yourself — this package
// never touches disk
const reloaded = parseDagArtifact(JSON.parse(fs.readFileSync('my-shape.dag.json', 'utf8')))
```

**Toolkit:** `serializeDagArtifact(input: SerializeDagArtifactInput)` → `DagArtifact`;
`parseDagArtifact(raw)` → `DagArtifact`, throwing a message naming the exact defect
(missing field, wrong `schemaVersion`, a malformed node) on bad input — the property that
makes it re-readable by a fresh session rather than a silent garbage-in/garbage-out
parse. Neither function calls `Date.now()` — a workflow SANDBOX SCRIPT cannot (it breaks
resume determinism); `createdAt` is always caller-supplied. Each artifact node
(`DagArtifactNode`) is a `DagNode` plus an optional `label` for a human-readable name.

### Budgeted named shapes — declaring what a reduced execution keeps and loses

**Use when:** you are reproducing an existing workflow's SHAPE by hand, at rung 3, with
fewer agents than the full workflow spends — e.g. a `pr-review` run with 3 review lenses
and one shared finding-verifier instead of ~6 lenses and one verifier per finding.
Reducing agent counts without saying what was given up is a machine for producing
verdicts that look like the real ones without the coverage behind them.
`BudgetedShape` makes the reduction, and its
cost, an explicit, renderable declaration instead of an implicit one nobody stated.

```js
const shape = makeBudgetedShape({
  name: 'pr-review-budgeted',
  referenceWorkflow: 'pr-review',
  stages: [
    { name: 'diff classification', fullBudget: 1, reducedBudget: 0, lost: ["folded into the calling loop's own reasoning"] },
    { name: 'review lenses', fullBudget: 6, reducedBudget: 3, lost: ['3 of 6 lenses dropped'] },
    { name: 'finding verification', fullBudget: 12, reducedBudget: 1, lost: ['per-finding independent verification collapses to one shared verifier'] },
    { name: 'synthesis', fullBudget: 1, reducedBudget: 0, lost: ["folded into the calling loop's own reasoning"] },
  ],
})
console.log(describeBudgetedShape(shape)) // renders the table
budgetTotals(shape) // { full: 20, reduced: 4 }
```

**Toolkit:** `makeBudgetedShape(shape)` validates and returns a `BudgetedShape` —
throwing IMMEDIATELY (not deferred to the first render/totals call) when any stage
reduces its budget with an empty `lost`; plain object literals skip this check until
`describeBudgetedShape`/`budgetTotals` runs, so prefer the factory when you control
construction. `describeBudgetedShape(shape: BudgetedShape)` renders a markdown table
(one row per `BudgetedStage`: stage, full budget, reduced budget, lost); `budgetTotals(shape)`
sums both columns. A stage where `reducedBudget < fullBudget` and `lost` is
empty is a config error, thrown
synchronously — a reduction with nothing declared lost is exactly the failure mode this
exists to prevent. A worked `pr-review` example lives in
`toolkit/packages/patterns/examples/`.

---

## Tuning at launch — per-role model/effort, and the config helpers

Every pattern exposes **per-role** knobs so you tune each role independently
without editing the workflow source:

- **Per-role model** — `<role>Model` (e.g. `attemptModel`/`judgeModel`/
  `synthesisModel` on `tournament`, `scoreModel` on `scoreAndRank`,
  `generateModel`/`filterModel` on `generateAndFilter`, `classifyModel` on
  `classifyAndAct`, `taskModel`/`synthesisModel` on `fanOutAndSynthesize`,
  `planModel`/`workerModel`/`synthesisModel` on `planAndExecute`,
  `analyzeModel`/`synthesizeModel` on `chunkedAnalysis`). `scoreAndRank`
  also takes a per-dimension `model`; `classifyAndAct` a per-action `model`.
- **Per-role effort** — the matching `<role>Effort` knob takes an `EffortAlias`
  (`'low' | 'medium' | 'high' | 'xhigh' | 'max'`); omit to inherit the session
  effort. Mirrors the model plumbing one-for-one.
- **Per-role agentType** — the matching `<role>Type` knob (a subagent-type string,
  the `Agent` tool's `agentType`) routes just that role to a different subagent —
  the lever for cross-family decorrelation (see §3); omit for the standard Claude
  subagent. Every evaluator/worker role has one: `taskType`/`synthesisType`
  (`fanOutAndSynthesize`), `generateType`/`filterType` (`generateAndFilter`),
  `attemptType`/`judgeType`/`synthesisType` (`tournament`),
  `planType`/`workerType`/`synthesisType` (`planAndExecute`), `classifyType`
  (`classifyAndAct`, plus a per-action `ActionSpec.agentType`), `scoreType`
  (`scoreAndRank`), `analyzeType`/`synthesizeType` (`chunkedAnalysis`), and
  `verifierType` (`adversarialVerification`). `loopUntilDone`
  has none — its author callback selects `agentType` directly. This generalizes the
  cross-family lever to every role so the composer can decorrelate a producer from
  its verifier (different unrelated families); it is NOT an invitation to route
  roles to same-model specialists — "specialize the producer, not the skeptic"
  still holds there (see §3). Use the generic wrapper below to route the WHOLE
  workflow in one line instead.

**Two launch-time config helpers** let a caller tune a workflow at invocation,
without touching its source — the natural home for an `args`-driven config:

- **`withAgentDefaults(rt, defaults)`** (`@workflow-toolbox/runtime`) — wrap `rt`
  ONCE at the top of `run()`; every agent in every pattern downstream inherits the
  defaults (`model` / `effort` / `agentType` / `isolation` / `stallMs`). Per-call
  opts always WIN (these are DEFAULTS), so a pattern that pins `judgeModel:'opus'`
  keeps it. This is the generic alternative to per-role knobs — e.g.
  `withAgentDefaults(rt, { agentType: 'codex:codex-rescue' })` routes every
  `agent()` call in the workflow through the cross-family bridge in one line (when
  you want every agent's turn reasoning on the other model, not just the verifier's).
  ⚠ Each of those agents is still a Claude subagent that shells out — the workflow
  never runs with zero Claude models this way, and the pattern is slated for removal
  (see `references/model-and-agent-routing.md`'s caveat).
- **`parseConfig(raw)`** (`@workflow-toolbox/build/define`) → a typed
  `WorkflowConfig { perAgent, models, effort, agentTypes, sizing }` — normalizes an
  `args` config envelope so a workflow can accept launch-time tuning declaratively.
  `perAgent` feeds straight into `withAgentDefaults`.

### Auto-selecting WORKER effort by task difficulty — `autoSelectEffort`

Complexity triage of a code task is a JUDGMENT call, not a classification, so
the decided form is three-tiered: **deterministic signals first, in script
code** (`deterministicEffortOf` over `EffortSignals` — file counts, diff size,
spec length — decides only the clear extremes: small-and-known → `medium`,
clearly-large → `xhigh`); then **ONE batched best-model triage call** scoring
every remaining `EffortWorkItem` at once with the standing instruction *"when
unsure, score UP"*; and anything the triage failed to decide lands on the
caller's `fallback` (`AutoSelectEffortOptions`) — the fail-safe direction is
always UP, so auto-selection is a cost optimization, never a silent quality
downgrade. The `AutoSelectEffortResult` reports per-item efforts, how each was
decided (`deterministic` / `triage` / `fallback`), and diagnostics.

**Routing applies to WORKERS only.** Verifier/checker roles keep their static
`'high'` floor via `resolveVerifierEffort` — that boundary is the caller's to
hold. Opt in per launch (`args.effort.<workerRole> = 'auto'` in the shipped
dev-implement and pr-review), never as a blanket default: effort is
task-relative, not identity- or project-relative.

## Cache-warm — staggering for a concurrent burst (on by default)

`fanOutAndSynthesize`, `chunkedAnalysis`, `planAndExecute`, `scoreAndRank`,
`generateAndFilter`, `classifyAndAct`, `adversarialVerification`, and
`tournament` accept `cacheWarm?: boolean`, **default `true`**. N agents
launched at once each write the identical shared system/tools prefix to the
provider's prompt cache before any single write becomes reusable by the
others; by default the burst is staggered so one call's write lands first,
letting the rest read that cache entry instead of re-writing it. This is a
**heuristic cost/latency lever** — provider-side cache behavior is not
guaranteed, and this toolkit does not measure the actual hit rate — it is
never a correctness change, and does not belong among the *measured* levers
in "Cost engineering" below. Pass `cacheWarm: false` to opt OUT for a
specific call.

Two mechanisms, already chosen for you per pattern (nothing to configure
beyond the boolean):

- **first-completes-then-burst** — `fanOutAndSynthesize`, `chunkedAnalysis`,
  `planAndExecute`, `scoreAndRank`, `generateAndFilter`, `classifyAndAct`.
  The first real task/item runs alone to completion, then the rest launch
  concurrently. Zero extra agents; costs +1 task's latency on the critical
  path — cheap when the burst is large, since the added latency doesn't scale
  with N. Safe even when items resolve to different models (e.g.
  `scoreAndRank`'s per-dimension `model` override) because the peeled-out call
  is one of the real agents, never a stand-in.
- **warmup-agent** — `adversarialVerification`, `tournament` (the latter warms
  BOTH its attempts stage and its judges stage independently). A single
  throwaway agent, on the SAME model/agentType as the stage it primes (a
  different model does not share the prefix cache), runs first; then the
  full burst launches at full concurrency. Used where the whole burst shares
  one uniform model AND is typically small (e.g. a 3-vote verifier panel or a
  3-judge panel) — losing one real slot to serial execution there would cost
  proportionally more than one extra cheap agent. A failed/null warmup only
  warns; the real burst always proceeds unaffected.

**When composing a workflow, consider asking the user the trade-off
explicitly** rather than silently accepting the default: "this fan-out can
stagger to save redundant cache writes (default), at the cost of a bit more
wall-clock latency per burst — does latency or token/cache cost matter more
for this workflow?" If the user (or the workflow's own purpose — an
interactive, latency-sensitive tool vs. a background batch job) says latency
wins, set `cacheWarm: false` on that pattern call. Default to leaving it on
(`true`) when unclear — it costs nothing extra to ask, and the pattern is
already inert-safe (bursts of 0-1 agents are always no-ops either way).

## Per-invocation stage salting — `stageKey`

`classifyAndAct`, `generateAndFilter`, `adversarialVerification`, `planAndExecute`,
`scoreAndRank`, `fanOutAndSynthesize`, and `chunkedAnalysis` accept `stageKey?:
string`. (`tournament` and `loopUntilDone` deliberately do NOT — see each
pattern's own source comment for why.)

**What it does:** claims a per-invocation discriminator and appends it
TERMINALLY (` #<key>`) to every stage/label string that invocation's agents
build — the same string used for both the agent's `label` and the result
envelope's `stage`. Without it, every invocation of a pattern on the same `rt`
builds IDENTICAL stage strings, which the debugger's trail-by-stage index and
the observe effort bridge cannot tell apart (silently collided or dropped
enrichment). With no `stageKey` given, a pattern falls back to an **auto
counter**: bare on the first invocation, then ` #2`, ` #3`, … per (rt, pattern)
pair.

**When to use it:** whenever the SAME pattern is invoked more than once on the
SAME `rt` — e.g. once per lens/category, or from inside a caller's own loop —
and **especially for concurrent invocations** (multiple calls inside one
`rt.pipeline`'s no-barrier per-item stages, or one `rt.parallel` burst). The
auto counter is only deterministic for SEQUENTIALLY invoked patterns (claim
order = code order); concurrent same-pattern invocations get
completion-order numbers instead — not wrong, but not predictable from source
order, and not stable across a `resumeFromRunId` replay. Pass an explicit,
author-meaningful `stageKey` (e.g. the lens name, as pr-review's per-lens
`adversarialVerification` calls do) for a stable, resume-safe discriminator.

**Constraints:** letters, digits, underscore, dot, hyphen, 1-32 chars, and
**not purely numeric** — a bare numeric key (e.g. a raw loop index passed
as-is) would produce salt ` #2`, format-identical to the auto counter's own
` #<n>` salt, silently colliding with a later auto-salted invocation and
defeating the whole point of an explicit key; numeric keys are reserved for
the auto counter's own format. An invalid `stageKey` (wrong charset, wrong
length, or purely numeric) never throws — it is reported as a warning and the
invocation falls back to (and advances) the auto counter, so it is never left
unsalted-and-silent when a real invocation follows.

## Composition idioms (not patterns)

These are how patterns and agents combine. They are deliberately **not**
abstracted into library functions.

- **Prompt chaining** is two sequential awaits — no helper:
  ```js
  const outline = await agent(`Outline: ${topic}`, { schema: OUTLINE_SCHEMA })
  const draft   = await agent(`Write from this outline:\n${JSON.stringify(outline)}`)
  ```
  Data crosses an agent boundary as prompt text (`JSON.stringify` into the next
  prompt) — the orchestrator shares no memory with subagents.

- **Pipeline by default, barrier only for cross-item needs.** Use `pipeline`
  for multi-stage work; reach for `parallel` only when a stage needs the
  *entire* previous result set — dedup, merge, or a count-based early-exit.
  **Smell test:** if you'd write `parallel(...)`, then a plain
  `map`/`filter`/`flat` with no cross-item dependency, then another
  `parallel(...)`, that middle transform doesn't need the barrier — make it a
  pipeline stage. When in doubt, `pipeline`.

- **Human-in-the-loop is a workflow boundary.** There is no mid-run user input;
  a sign-off point splits the work into two workflows. Stage one returns an
  artifact via its output; a human approves or prunes it; stage two takes the
  approved artifact through `args` and **re-validates it on entry** — that
  re-validation is the entire point of the checkpoint, because the human may
  have hand-edited the artifact (see the `monorepo-refactor-plan` /
  `-execute` pair).

- **`workflow()` nesting is reserved for frozen, independently-owned
  sub-workflows** invoked as one step, **one level only** (no bundled
  composition nests today — the capability is reserved, currently unused).
  Patterns inline; the library never nests compositions inside compositions.

---

## Schemas

Attach an as-const JSON Schema at every boundary a later line reads a field off.
Keep it small and required-tight, and use `enum` for any closed set so the agent
cannot return a value your control flow doesn't handle:

```js
const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    severity: { enum: ['low', 'medium', 'high'], type: 'string' },
    title:    { type: 'string' },
  },
  required: ['severity', 'title'],
  additionalProperties: false,
} // as const satisfies JsonSchema  (in the typed toolkit, with FromSchema<…> for the static type)
```

The schema does double duty: it constrains the agent's output **and** catches a
truncated or mis-shaped result before the next line trusts it.

**Bound every prose field and array** (`maxLength`, `maxItems`, plus `minLength`
on required prose): an unbounded long field is what starves its required
siblings out of the JSON, and bounds turn a runaway into an actionable "too
long" rejection instead of a missing-property mystery.

### Structured-output salvage (automatic in every pattern)

The host's schema-retry loop lives inside the agent conversation; when it
exhausts, the pattern used to see a bare `null` — the item died with zero
diagnostics. Every pattern now routes schema-bearing calls through
`agentWithSchemaSalvage`: on native exhaustion it respawns the agent ONCE
without the host schema, states the schema's constraints in prose, parses the
raw answer, validates it against the same schema, and deterministically repairs
what repair can never fabricate — over-`maxLength` strings are truncated,
over-`maxItems` arrays sliced, unexpected properties dropped. Missing required
properties, wrong types, and enum violations are never invented: an
unrepairable answer still degrades to `null`, now with the exact violations
(field path + bound + received) in `warnings`. The salvage respawn is a real
spawn: it appears in `stats.agentsSpawned` and gets its own `<stage>:salvage`
trail record, so a rescued value is always auditable, never silent.

The helpers are exported for workflow authors too: `describeSchemaConstraints`
(embed a schema's bounds in your PRIMARY prompt as prevention),
`validateAgainstSchema` / `repairToSchema` (the subset validator/repairer,
returning `SchemaViolation` records — field path + constraint + received), and
`extractJsonObject` (tolerant JSON extraction from prose/fenced answers).
`agentWithSchemaSalvage` itself returns a `StructuredCallOutcome`: the value
(or null), the specific warnings, the spawn count, and a `salvaged` flag.

---

## Honest reporting

Workflows must not lie about coverage, and must not trust an agent's word.

**No silent caps.** Whenever a cap or filter drops or truncates work, **count
it and surface it**. The toolkit envelope reports `dropped` (null results) and
`truncated` (cap-induced omissions) in `stats`, and live-logs human-readable
coverage warnings as they happen. A cap should never destroy evidence silently
— prefer keeping a flagged-but-unverified item over dropping it.

**Trust no agent's self-report.** An agent can die at its context limit and its
last mid-thought arrives looking like a normal completion. Four defence layers:

1. **Schema at every consumed boundary** — catches truncation and shape drift.
2. **A fresh-evidence checker stage** — a *separate* agent re-derives the result
   from the actual source (the diff, the files, a command run), never from the
   worker's summary. Refute-first framing kills plausible-but-wrong findings.
3. **Decomposed agent scopes** — small focused contexts; an oversized scope is
   the root cause of mid-reasoning death.
4. **Launch hygiene** — check the workflow's `error` field on completion, and
   resume with `resumeFromRunId` instead of re-running finished work (completed
   steps replay from cache; only failed or dropped steps re-run).

Counting is a **code** responsibility, never a model one: tally
succeeded/failed/dropped in JavaScript. Spawning an agent to count is slower,
non-deterministic, and adds a failure point for no gain.

### Envelope helpers (`@workflow-toolbox/patterns`)

Three small helpers back the envelope conventions above, exported for workflow and
pattern authors who want the same guarantees in their own code, outside the nine patterns:

- **`applyCap(items, cap)`** — the truncation-with-reporting primitive behind every
  pattern's `maxItems`/`maxVerifyClaims`-style knob. `cap === undefined` is a no-op
  (nothing withheld); a positive-integer `cap >= 1` keeps the first `cap` items and
  reports how many were dropped; `cap < 1` throws synchronously with an actionable
  message instead of silently returning nothing. Pass a positive integer — the `cap < 1`
  guard doesn't catch `NaN` or fractional values, which can slice unexpectedly and report
  a truncation count that doesn't match. Mirrors "no silent caps" above — reach for it
  whenever your own workflow code truncates a list.
- **`emitDigest(rt, digest)`** — logs one structured `rt.log` line per pattern run,
  parsed back by observe on reload into a phase's output/choices and attributed to a
  phase by matching `digest.stage`. Call it once per pattern invocation — including on
  an early failure return, so a failed run still reports an outcome — with
  `digest.stage` equal to the pattern-name prefix used by that invocation's agent
  labels, or observe cannot resolve which phase it belongs to.
- **`assertAgentTypeOption(stage, name, value)`** — validates an optional per-role
  `agentType` routing input (the `<role>Type` knobs, e.g. `verifierType`): `undefined`
  is fine (the standard subagent), but a defined, blank/whitespace-only string is a
  config mistake — it throws synchronously at entry instead of spawning an agent with
  an invalid empty `agentType`.

## Cost engineering

Agent cost follows **tool-call count**, not prompt size — each turn re-reads
the context so far, so anything that makes an agent's first read *targeted*
instead of exploratory pays for itself. Five levers, all measured on this
toolkit's own dev-workflow family (full numbers and the code in the public
[cost-engineering guide](https://github.com/home-dev-lab/workflow-toolbox/blob/main/docs/public/cost-engineering.md)) —
the percentages below are what THOSE runs measured, not constants: treat them
as which-lever-moves-what guidance and re-measure on your own composition
before relying on a number:

1. **Gate scrutiny on stakes** — `votesPerClaim: (claim) => claim.severity
   === 'low' ? 1 : 3` cut a verification phase −47%. But harden the gating
   signal: a self-assessed label needs a deterministic structural floor, and
   a label crossing an agent boundary needs in-code enforcement.
2. **Tier models only behind a safety net** — route a stage to a cheaper
   `model:` only when its errors are catchable downstream (fallbacks +
   integrity guards + adversarial verification). Never tier a stage whose
   output becomes unverified ground truth for everything after it.
3. **Never gate COVERAGE on an unverified classification** — skipping a
   reviewer/dimension is unrecoverable (verification only checks what WAS
   reported). Adapt coverage only on deterministic, conservative, loudly
   warned in-code rules, always overridable by explicit input.
4. **Quote the code to the verifier** — have upstream agents return a
   verbatim snippet per claim and embed it in `renderClaim` (−19% to −25%
   per verifier across two measured runs, exploratory tail gone; stacked
   with severity-gated votes the verification stage halved). Contracts:
   fenced with `untrusted()` (`@workflow-toolbox/patterns`) at EVERY
   embedding site, capped in code, never a substitute for on-disk
   re-derivation, and required-with-empty rather than optional (models omit
   optional fields under output pressure).
5. **Caps never destroy evidence** — sort by stakes in code before any
   positional cap, and keep-unverified-rather-than-drop.
