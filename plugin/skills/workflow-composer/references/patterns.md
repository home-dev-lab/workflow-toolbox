# Orchestration patterns

A workflow is deterministic JavaScript wrapped around `agent()` calls. The
control flow — `if`, `for`, `await`, `.map`, `.filter` — runs in code you can
read and predict; only the work *inside* each agent is non-deterministic. A
"pattern" is a recurring **code shape** around those agent calls: a way to
route, fan out, vote, loop, or decompose.

There are two ways to use a pattern:

- **Raw JavaScript idiom** — write the shape inline. Best for one-off
  workflows. You control the prompts, the schemas, and the control flow
  directly; nothing is hidden. The snippets below show each shape in this form.
- **The `@workflow-toolbox` toolkit** — the same shapes as a typed library, one function per
  pattern, each returning a uniform result envelope (`value` + `stats` +
  `warnings` + `trail`). Best for repeatable, maintained workflows where you
  want the counting, the trail, and the guardrails for free. See
  `toolkit/README.md` for the authoring contract; each pattern below names its
  toolkit function.

The raw idiom teaches you the shape. The toolkit hardens it. Reach for the
toolkit once a workflow is worth maintaining.

## Conventions used in every snippet

- An agent call returns `null` when the agent fails, skips, or runs out of
  budget. Never assume a result is present — `.filter(Boolean)` it out, or count
  it as dropped. Failures degrade; they never throw.
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

**Toolkit:** `adversarialVerification(rt, { claims, renderClaim, votes, refuteThreshold, lenses })`.
The default model is `BEST_MODEL` (`'fable'`, exported by
`@workflow-toolbox/runtime`) — verification quality is model-sensitive, and
explicitly passing a weaker model warns. Optional `lenses` give one distinct angle per vote
(e.g. `['correctness', 'security', 'does-it-reproduce']`) so a claim that fails
in more than one way is caught.

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
or add `maxIterations`/`dryRounds`. This pattern spawns no agents of its own;
its trail records loop **iterations**, and any agents the body calls belong to
the caller's budget.

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
