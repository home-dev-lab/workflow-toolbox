# Orchestration patterns

A workflow is deterministic JavaScript wrapped around `agent()` calls. The
control flow — `if`, `for`, `await`, `.map`, `.filter` — runs in code you can
read and predict; only the work *inside* each agent is non-deterministic. A
"pattern" is a recurring **code shape** around those agent calls: a way to
route, fan out, vote, loop, or decompose.

There are **three** ways to use a pattern:

- **Inline in the main conversation loop** — run the shape *by hand*, with **no
  workflow script at all**: the main loop emits the `Agent` (Task) tool calls itself
  and reconciles the results. Best for a one-off where you want the pattern's value
  (refute-first verify, fan-out, tournament, loop-until-dry) without a build step.
  This is what `deep-grounding` reaches for; see the translation table below.
- **Raw JavaScript idiom** — write the shape inline **as a workflow script** run by
  the Workflow tool. Best for a one-off whose orchestration is worth scripting but not
  maintaining. You control the prompts, schemas, and control flow directly; nothing is
  hidden. The snippets below show each shape in this form.
- **The `@workflow-toolbox` toolkit** — the same shapes as a typed library, one function per
  pattern, each returning a uniform result envelope (`value` + `stats` +
  `warnings` + `trail`). Best for repeatable, maintained workflows where you
  want the counting, the trail, and the guardrails for free. See
  `toolkit/README.md` for the authoring contract; each pattern below names its
  toolkit function.

The inline-main-loop mode runs the shape; the raw idiom scripts it; the toolkit
hardens it. Climb only as far as reuse, scale, or determinism forces you (see the
orchestration ladder in `SKILL.md`).

### Translating a shape to the main-loop (inline) mode

The snippets below use the sandbox globals (`agent`, `parallel`, `pipeline`) because
they are written as workflow scripts. To run the *same shape* inline in the main
conversation loop, with no script, map each global to its hand-run equivalent:

| Sandbox global (in a workflow) | Main-loop (inline) equivalent |
|---|---|
| `parallel(thunks)` | Emit **all** the `Agent` calls in **one** assistant message — they run concurrently. (Saying "in parallel" then emitting one call and awaiting it is *sequential* — the recurring mistake.) |
| `pipeline(items, a, b)` | Sequence across messages: run stage `a`, read results, then emit stage `b`. No per-item barrier-free streaming — you reconcile each stage yourself. |
| `agent(prompt, { schema })` | One `Agent` call; the `schema` becomes an explicit output-shape instruction in the prompt (or a structured-output subagent). You read fields off the returned text. |
| `.filter(Boolean)` + counting | Do it yourself in the reply: a dead/dropped agent returns nothing usable — drop it and **say how many** you dropped. |
| `budget` / `resumeFromRunId` / `trail` | **Not available inline** — these are exactly what graduate you to a compiled workflow (rung 4). |

The reconciliation (tally, dedup, verdict) stays your job either way — never ask a
model to count.

**Tuning scrutiny inline.** The toolkit's per-item knobs (e.g. `votesPerClaim` for
severity-gated verifier counts) have no inline helper — you tune by hand: emit fewer
`Agent` calls for low-stakes items and more for high-stakes ones (the same intent,
done by choosing how many calls go into the message). Likewise model tiering is just
the `model` on each `Agent` call. The shapes carry over; only the bookkeeping is
manual.

## Conventions used in every snippet

- An agent call returns `null` when the agent fails or skips — never assume a
  result is present, `.filter(Boolean)` it out or count it as dropped. That
  degrade path does NOT cover the shared token budget: once it is exhausted,
  `agent()` **throws** (`WorkflowBudgetExceededError`) instead of returning
  null — guard on `budget.total`/`remaining()` before a budget-driven loop
  rather than relying on a null result to signal exhaustion.
- Parallel work is expressed as **thunks** (`() => agent(...)`) handed to
  `parallel(...)`, so the runtime owns concurrency. Do not `await` inside the
  array literal.
- A `schema` is attached at every boundary a later line **reads a field off**.
  Free text is fine only when the whole string is piped into the next prompt.
- `pipeline(items, stageA, stageB)` flows each item through every stage with no
  barrier between stages; `parallel(thunks)` is a barrier that waits for all.

---

## 1. Routing — `classifyAndAct`

**Use when:** inputs fall into distinct categories that are handled better by
separate prompts, and classification is reliably accurate.
**Do NOT use when:** the categories blur, or a single prompt handles every input
well — then one agent is simpler.

```js
const classified = await classify(input)        // returns { category }
const action = handlers[classified.category]     // pick the branch
const out = action ? await action(input) : null
```

As a per-item pipeline (classify then act, one item at a time, no barrier):

```js
const results = await pipeline(
  items,
  async (item) => ({ item, category: (await classify(item)).category }),
  async ({ item, category }) => handlers[category](item),
)
```

The classify agent's schema must `enum`-constrain `category` to the known set,
so the router can never branch on a category that has no handler.

**Toolkit:** `classifyAndAct(rt, { items, categories, classifyPrompt, actions })` —
the `categories` enum is built into the classifier's schema, and a missing
handler is a config error caught before any agent runs.

---

## 2. Parallel sectioning + synthesis barrier — `fanOutAndSynthesize`

**Use when:** independent subtasks run concurrently and the synthesis step
genuinely needs **all** of their results.
**Do NOT use when:** the stages flow per-item (use a pipeline) or there is only
one item.

```js
const parts = await parallel(
  sections.map((s) => () => agent(`Analyze: ${s}`, { schema: PART_SCHEMA })),
)
const survived = parts.filter(Boolean)           // drop failed agents
if (survived.length === 0) return null            // nothing to synthesize
const summary = await agent(
  `Synthesize these parts:\n${JSON.stringify(survived)}`,
  { schema: SUMMARY_SCHEMA },
)
```

The barrier is the whole point: synthesis cannot start until every section is
in hand. If it could start early, you wanted a pipeline.

**Toolkit:** `fanOutAndSynthesize(rt, { tasks, synthesisPrompt, ... })`. When every
section fails, synthesis is not spawned and `value` is `null`; when synthesis
itself fails, `value` is `null` while `stats.itemsOut > 0` records that the
per-section work survived.

---

## 3. Refute-first verification — `adversarialVerification`

**Use when:** findings will be acted on and a plausible-but-wrong one is costly.
**Do NOT use when:** the output is low-stakes, or there is no independent way to
re-derive the claim.

Each claim is checked by N verifiers (default 3) instructed to **try to refute**
it and to default to "refuted" under uncertainty — this is what kills
confirmation bias. The verdict is tallied **in code**, never by asking a model
to count votes:

```js
const VERDICT_SCHEMA = { /* enum: confirmed | refuted | unverifiable */ }

const votes = (await parallel(
  Array.from({ length: 3 }, () => () =>
    agent(
      `Adversarially verify this claim. Actively try to REFUTE it; ` +
      `re-derive from the source, not from any prior summary. Claim: ${claim}`,
      { schema: VERDICT_SCHEMA },
    ),
  ),
)).filter(Boolean)

let verdict
if (votes.length === 0)                                  verdict = 'unverifiable'
else if (votes.filter((v) => v.verdict === 'refuted').length >= 2) verdict = 'refuted'  // 2-of-3
else if (votes.every((v) => v.verdict === 'confirmed')) verdict = 'confirmed'
else                                                     verdict = 'partially-confirmed'
```

Two rules carry the integrity guarantee: a claim that could not be verified is
**kept and flagged**, never silently dropped — failure is distinct from
refutation; and verifiers re-derive from fresh evidence, not from the claim's
author. A cap never destroys evidence either: claims a cap cuts are kept too,
just flagged differently (see the toolkit vocabulary below).

**Toolkit:** `adversarialVerification(rt, { claims, renderClaim, votes, refuteThreshold, lenses, votesPerClaim, model, effort, verifierType, maxVerifyClaims })`.
The default model is `BEST_MODEL` (currently `'opus'`, exported by
`@workflow-toolbox/runtime`) — verification quality is model-sensitive, and
explicitly passing a weaker model warns. (`BEST_MODEL` names the strongest
*reliably-callable* tier, not merely the newest. Do not hand-override a verifier to a
top-tier alias you have not verified is callable in the consumer's environment —
alias availability varies by plan and over time, and an uncallable alias errors at
runtime.) Optional `lenses` give one distinct angle per vote
(e.g. `['correctness', 'security', 'does-it-reproduce']`) so a claim that fails
in more than one way is caught. Optional `votesPerClaim` (`(claim) => number`,
integer ≥ 1, validated for every claim before anything spawns) scales the vote
count per claim so low-stakes claims spend fewer verifiers — e.g.
severity-aware review: `(f) => f.severity === 'low' ? 1 : 3`. It overrides
`votes` per claim, and the refute threshold is clamped per claim to
`min(refuteThreshold, claimVotes)`, so a 1-vote claim is decided by its single
refute-first vote. `lenses` and `votesPerClaim` are mutually exclusive —
lenses need one fixed vote count (one lens per vote); pick one or the other
(additive, semver-minor change, ships in `@workflow-toolbox/patterns` 0.5.0).

**Cross-model verifier — `verifierType`.** `verifierType?: string` routes EVERY
verifier through a given subagent type (the `Agent` tool's `agentType`); omit it
for the standard same-model verifier. Its premier use is **genuine decorrelation**:
a same-model verifier shares the producing model's priors, so a clean panel is
weakly informative for reasoning errors — the one real lever is a verifier on a
*different model family*. On a machine with the `codex` plugin,
`verifierType: 'codex:codex-rescue'` runs every refute-first verifier on a
non-Claude (GPT) model — and it honors this pattern's structured verdict schema
(proven from inside a workflow). This plugin also ships
`workflow-toolbox:opencode-verifier` — a second cross-family option that routes to
any `opencode` model (`openai/gpt-5.4` by default; pick any other provider via
`OPENCODE_MODEL` for a family distinct from both Claude and codex-rescue's GPT)
and emits `OPENCODE_UNAVAILABLE` when opencode isn't installed or no
provider is authenticated. Whether that degrades to a Claude fallback or refuses
the launch depends on the probe mode the caller chose: `probeAgentType`'s default
degrades gracefully, but `required: true` throws instead — and the shipped
`cross-model-verify` workflow passes `required: true` when `verifierType` is set,
so an unavailable bridge there refuses the run rather than silently falling back.
Caveat: both depend on a local setup + login and are NOT portable; for a SHIPPED
workflow prefer an MCP→model endpoint as the cross-model verifier.
⚠ Both still run a Claude subagent that shells out — the workflow keeps a Claude turn
in that role, it does not become a zero-Claude run, and the pattern is slated for
removal (see `references/model-and-agent-routing.md`'s caveat under "Cross-family
routing"). For a stage with no Claude model at all, use a pipeline's `scripted` stage
(`references/orchestrator-pipelines.md`). This is distinct from (and stronger than) the discouraged
"specialist reviewer" use — "specialize the producer, not the skeptic" still holds
for *same-model* specialization. Launch-time exposure: on `cross-model-verify` and
`independent-analysis` the request travels in the STRUCTURED config envelope —
`args.agentTypes.verify` (role key mirrors `effort.verify`; no bespoke top-level
arg) — and is PROBED at entry (`probeAgentType`, one schema-less call) with a
graceful fallback to the standard verifier reported in the result's `probe` field;
`pr-review` routes its lens reviewers the same way via `args.agentTypes.review` (same role key as `effort.review`).
The dev family (`dev-plan` Critique, `dev-review-fix` Verify, orchestrated by
`dev-full`) still takes a bespoke `verifierType` input (unmigrated).

The toolkit's claim-level vocabulary (the exported `ClaimVerdict` type) has
five values: `'confirmed' | 'partially-confirmed' | 'refuted' | 'unverifiable'
| 'unverified-by-cap'`. The two non-refuted "could not verify" verdicts are
distinct: `'unverifiable'` means verifiers were spawned and **all failed**
(`votes` is a non-empty array of nulls, counted in `stats.dropped`);
`'unverified-by-cap'` means the claim was cut by `maxVerifyClaims` and **never
tested** (`votes: []`, no trail records, counted in `stats.truncated`).
Truncated claims stay in the output — `itemsIn === itemsOut` always holds —
and truncation is also reported via a warning. The 4-value agent-vote schema
above is unchanged: agents never emit `'unverified-by-cap'`; only the
deterministic tally assigns it. Backward compatibility: callers keying on
`'refuted'` are unaffected — treat `'unverified-by-cap'` with the same
kept-and-flagged handling as `'unverifiable'` (additive, semver-minor change,
ships in `@workflow-toolbox/patterns` 0.3.0).

> **Concurrency gotcha (observed live):** verifiers run in parallel. If
> `renderClaim` tells them to *drive a CLI or write files*, do NOT point them all
> at the same working directory — two verifiers racing on a shared scratch file
> (e.g. both writing a `spec.json`) contaminate each other's evidence. Give each
> prompt its own scratch dir, keyed by something unique carried IN the claim
> (an id, a file path — add one when you build the claims array):
> `renderClaim: (c) => \`Work in /tmp/verify-\${c.id}: …\``.

---

## 4. Generation + single-pass filter — `generateAndFilter`

**Use when:** the candidate space is wide, generation is cheap, and you can
articulate a clear filter criterion.
**Do NOT use when:** the criterion can't be stated — the filter becomes noise.

```js
const candidates = (await parallel(
  Array.from({ length: n }, (_, i) => () =>
    agent(`Produce candidate #${i} for: ${goal}`, { schema: CANDIDATE_SCHEMA }),
  ),
)).filter(Boolean)

const kept = []
for (const c of candidates) {
  const judged = await agent(
    `Does this meet the criteria? ${criteria}\n${JSON.stringify(c)}`,
    { schema: FILTER_SCHEMA },                  // { pass: boolean, reason }
  )
  if (judged?.pass) kept.push(c)
}
```

Vary the candidates by an **index-derived** angle (the sandbox bans
`Math.random()` and `Date.now()`); determinism comes from the loop index, not a
random seed.

**Toolkit:** `generateAndFilter(rt, { ... })` — one evaluator pass, dropped
candidates counted.

---

## 5. Judge panel + synthesis — `tournament`

**Use when:** the solution space is wide and the attempts genuinely differ by
angle.
**Do NOT use when:** the task is convergent and attempts would be near-identical
(then a single attempt or a simpler pattern is enough; two-plus angles are
required by definition).

```js
const attempts = (await parallel(
  angles.map((a) => () => agent(`Solve via the "${a}" angle: ${problem}`,
                                { schema: ATTEMPT_SCHEMA })),
)).filter(Boolean)

const ranked = (await Promise.all(attempts.map(async (att) => {
  const scores = (await parallel(
    Array.from({ length: 3 }, () => () =>
      agent(`Score this attempt 0-10: ${JSON.stringify(att)}`,
            { schema: JUDGE_SCHEMA })),
  )).filter(Boolean).map((j) => j.score)
  return { att, score: median(scores) }          // median in CODE, not by a model
}))).sort((a, b) => b.score - a.score)            // winner first

const winner = await agent(
  `Synthesize the best solution. Ranked, winner first:\n${JSON.stringify(ranked)}`,
  { schema: SYNTH_SCHEMA },
)
```

The ranked list reaches synthesis winner-first, so it can build on the winner
while runners-up stay available for comparison.

**Toolkit:** `tournament(rt, { angles, attemptPrompt, judgePrompt, synthesisPrompt, judgeCount })`.

---

## 6. Loop until done — `loopUntilDone`

**Use when:** there is a clear evaluation signal and iteration adds measurable
value, or the work size is unknown up front (loop-until-dry discovery).
**Do NOT use when:** there is no articulable feedback, or the full list is known
in advance — then just `map` it.

Every loop needs a stop condition. In the toolkit the options type makes an
omission a **compile error**; in raw JS, write it by hand and never trust the
agent alone to say "done":

```js
let state = initial
let dry = 0
for (let i = 0; i < maxIterations; i++) {        // hard ceiling
  const tick = await agent(`Improve. Current:\n${JSON.stringify(state)}`,
                           { schema: TICK_SCHEMA })   // { state, done, progressed }
  if (!tick) break
  state = tick.state
  if (tick.done) break                           // body-signalled completion
  dry = tick.progressed ? 0 : dry + 1
  if (dry >= dryRounds) break                    // N rounds with no progress
}
```

**Toolkit:** `loopUntilDone(rt, { initial, body, maxIterations?, dryRounds?, budgetFloor? })`
with **typed** stop conditions — at least one of the three is required.
`budgetFloor` stops when remaining budget drops to the floor. There is one trap
the type system can't fully prevent and the pattern guards at runtime: if
`budgetFloor` is the *only* stop condition **and no budget target is set**
(`budget.total` is effectively `Infinity`), the floor is inert and the loop is
unbounded — the pattern throws with an actionable message. Set a budget target,
or add `maxIterations`/`dryRounds`. This pattern spawns no agents directly, but
it counts the body's `agent()` calls — made through the `rt` the body receives,
including via `rt.parallel`/`rt.pipeline` thunks — into `stats.agentsSpawned`;
its trail stays per-**iteration** (`trail.length === iterations`, not
`agentsSpawned`), and the body's agents still draw on the caller's budget.

> **Gotcha — `loopUntilDone` takes no `phase` option.** Unlike the other six
> patterns (which accept `phase` and tag their agents with it), the loop's body
> owns its own phase context. So if you want its iterations grouped under a named
> phase, call `rt.phase('Refine')` **before** the loop — otherwise its agents
> carry no `phaseIndex` and land in the observe-ui "(no phase)" column (and any
> phase you only declared in `meta.phases` renders as an empty container). The
> bundled `demo-all-patterns` does exactly this (`rt.phase('Refine')` on the line
> above its loop). The observe-ui graph names the loop's back-edge after that
> phase — e.g. `↺ repeat Refine (ran 3×)` — so a missing `rt.phase` shows up
> immediately as `↺ repeat (no phase)`. Give that `meta.phases` entry a `detail`
> string (see `api-reference.md`) and the otherwise-empty container shows that
> text inline instead of a bare box — useful when a phase is legitimately agent-
> less (e.g. deterministic setup/report stages).

---

## 7. Orchestrator-workers — `planAndExecute`

**Use when:** the subtasks can't be predicted up front and a planner agent must
decompose the work dynamically.
**Do NOT use when:** the subtasks are already known — then `fanOutAndSynthesize`
or a `pipeline` over the known list is cheaper and more predictable (a planner
agent for known work just adds a redundant call and non-determinism).

```js
const plan = await agent(`Decompose this goal into subtasks: ${goal}`,
                         { schema: PLAN_SCHEMA })    // { subtasks: [...] }
if (!plan) return null

const workerResults = (await parallel(
  plan.subtasks.map((t) => () => agent(`Do subtask: ${t.action}`,
                                       { schema: WORK_SCHEMA })),
)).filter(Boolean)

const synthesis = await agent(
  `Combine the worker outputs:\n${JSON.stringify(workerResults)}`,
  { schema: SYNTH_SCHEMA },
)
```

**Toolkit:** `planAndExecute(rt, { planPrompt, workerPrompt, synthesisPrompt, maxSubtasks? })`.
Its result exposes the surviving `workerResults` alongside the synthesis — so a
failed synthesis (`value === null` with `itemsOut > 0`) does not lose the
per-worker work.

---

## 8. Cheap-model triage + rank cutoff — `scoreAndRank`

**Use when:** there are many items but only a few deserve an expensive next
stage; a cheap model can score each on one or more *independent* dimensions
(the classic `impact × opportunity`), and you want a ranked cutoff to AIM the
premium model / human / downstream pattern at the top — the "targeting machine"
before you spend the premium tokens.
**Do NOT use when:** few items (just act on them); the scoring signal is garbage
(GIGO → the ranks are meaningless); or a binary keep/drop is enough — then
`generateAndFilter` is simpler (its filter is a yes/no, not a numeric rank).

```js
const SCORE = { type: 'object', properties: { score: { type: 'number' }, reason: { type: 'string' } }, required: ['score', 'reason'] }

// Cheap sweep: each (item, dimension) scored independently by a CHEAP model.
const scored = (await parallel(items.map((it) => () =>
  parallel(['impact', 'opportunity'].map((dim) =>
    () => agent(`Score ${it} on ${dim}, 1-5.`, { schema: SCORE, model: 'haiku' })))
    .then((dims) => dims.every(Boolean)
      ? { it, score: dims.reduce((a, d) => a * d.score, 1) }   // impact × opportunity
      : null)),                                                // fail-closed: drop on a missing dim
)).filter(Boolean)

// Rank, then keep the top — aim the PREMIUM stage ONLY at these.
const targets = scored.sort((a, b) => b.score - a.score).slice(0, K)
```

**Toolkit:** `scoreAndRank(rt, { items, dimensions, cutoff, scoreModel?, combine?, maxItems? })`.
Each dimension is scored independently by the cheap `scoreModel`; `combine` folds
them (default: product = `impact × opportunity`, which **assumes non-negative
scores** — pass your own `combine` for a signed scale, else two negatives rank a
doubly-bad item top); `cutoff` is `{ type: 'threshold', min }` or
`{ type: 'topK', k }`. It returns the ranked survivors and STOPS — point the
expensive stage at them yourself (the pattern deliberately does NOT bundle the
premium pass, so it stays composable). A null **or non-finite** dimension/score
drops that item (fail-closed, so a NaN/±Infinity never corrupts the rank);
below-cutoff items are logged and derivable from the stats, never silently dropped.

---

## 9. Chunked map-analyze + synthesis — `chunkedAnalysis`

**Use when:** the content is too big for a single agent context — a large diff, a
long log, a CSV — and you want a map-analyze-then-synthesize pass: a deterministic
chunker splits the text, each chunk is analyzed in parallel, and one synthesis
folds the per-chunk results (the RLM-like shape).
**Do NOT use when:** the content fits one context (just `agent()` it, or
`fanOutAndSynthesize` over sections you already have); or the per-chunk outputs
ARE the answer and need no synthesis barrier — then `rt.pipeline`.

```js
// Deterministic char-based chunker (no tokenizer): cut at maxChars, preferring
// line boundaries, with optional overlap. PURE — safe in the sandbox.
const chunks = chunkText(bigLog, { maxChars: 4000, overlapChars: 200 })

// Map: analyze each chunk in parallel. Reduce: one synthesis over the survivors.
const parts = (await parallel(chunks.map((c, i) => () =>
  agent(`Chunk ${i + 1}/${chunks.length}. List error signatures:\n${c}`)))
).filter(Boolean)
const report = await agent(`Cluster these per-chunk findings:\n${parts.join('\n')}`)
```

**Toolkit:** `chunkedAnalysis(rt, { input, maxChars, overlapChars?, analyzePrompt, synthesizePrompt, analyzeSchema?, synthesizeSchema?, maxChunks?, ... })`.
`input` is a string (chunked) or a `string[]` (caller pre-chunks, each still
re-split to respect `maxChars`); the chunker prefers cutting at line boundaries
and hard-cuts a single over-long line. Chunk analyzers fan out concurrently; the
synthesis runs once after the barrier, over the surviving analyses. Chars are a
DELIBERATE token proxy (a real tokenizer is a heavy, model-specific dependency) —
size `maxChars` for the analyze model. `maxChunks` caps the fan-out on a giant
input (truncation reported). The result exposes the nullable synthesized `value`,
the surviving per-chunk `chunkResults`, and the standard stats/trail. `chunkText`
is exported standalone too, for when you only need the deterministic split.

---

## Execution, tuning, and reporting

The remaining sections — the rung-3 DAG-execution companions, per-role
model/effort/agentType tuning, cache-warm, per-invocation `stageKey` salting,
composition idioms, schemas, honest reporting, and cost engineering — moved to
[patterns-execution.md](patterns-execution.md) to keep this file under the
500-line skill-reference cap.
