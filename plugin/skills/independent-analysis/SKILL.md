---
name: independent-analysis
description: >-
  Run a bias-free, multi-lens adversarial analysis of any non-trivial subject — a
  design, plan, decision, claim, architecture, root-cause theory, or change set — via
  the bundled independent-analysis workflow. Fresh agents, each pinned to a distinct
  lens and blind to the conversation, surface what the driving model overlooked, then
  refute-first verifiers kill the plausible-but-wrong ones. Use this PROACTIVELY
  before committing to a non-trivial design or decision, and whenever the user asks to
  stress-test or red-team thinking, get a second opinion, sanity-check a conclusion,
  audit docs or a plan for accuracy, or "make sure no angle is forgotten" — even if
  they never say the words "workflow" or "analysis". Reach for it ESPECIALLY when you
  suspect your own reasoning may be biased by going fast or by confirming a prior
  assumption: independent agents are the cheapest way to catch that.
---

# independent-analysis

A standing tool to counter the single-context biases of whatever model is driving the
conversation — going fast, and confirming its own earlier assumptions. It runs the
**`independent-analysis` workflow** (the 9th `@workflow-toolbox` composition, also bundled as the
plugin workflow `workflow-toolbox:independent-analysis`): one analyst agent per lens, each
*blind to this conversation*, finds forgotten angles; a synthesis step dedups them
against what you already know; then `adversarialVerification` re-derives each survivor
refute-first and reports a verdict. Because the agents can't see the chat, they can't
inherit its blind spots — that is the whole point.

## When to reach for it

- **Before committing to a non-trivial design, plan, or decision** — let independent
  agents try to break it first.
- The user asks to **stress-test / red-team / poke holes / get a second opinion**, or
  says **"are you sure?", "what am I missing?", "did we forget anything?"**.
- **Auditing docs, a spec, or a plan for accuracy** (it dogfooded exactly this: it
  audited its own catalog change and caught real stale counts a self-review missed).
- You notice you're **moving fast or defending a prior conclusion** — the failure mode
  this exists to catch.

**When NOT to:** a single quick fact lookup, a mechanical edit, or a task with no
"could this be wrong?" surface — the fan-out isn't worth it. It **finds issues, it
does not fix them**: apply confirmed findings yourself.

## How to invoke

It is a Workflow-tool workflow (main-loop only). `scriptPath` always resolves;
invocation by `name` works once the registry has picked it up.

```js
// Always-reliable form:
Workflow({
  scriptPath: "<repo>/toolkit/workflows/independent-analysis.js",
  args: { subject, context, assumptions, lenses, sourceRefs, lensCount, votes, verifierModel },
})
// Bundled-plugin form (once registered): name: "workflow-toolbox:independent-analysis"
```

| Arg | Type | Meaning |
|---|---|---|
| `subject` | string **(required)** | What to analyze — state it concretely. |
| `context` | string | Background the analysts need (they can't see the chat). |
| `assumptions` | string[] | What you already believe/know — findings are **deduped against these**, so analysts spend their effort on genuinely-new angles. |
| `lenses` | string[] | Explicit analysis angles; `[]` → auto-propose `lensCount` diverse lenses. |
| `sourceRefs` | string[] | Files the agents must READ to ground claims in real content. |
| `lensCount` | number (default 5) | How many lenses to auto-propose when `lenses` is empty. |
| `votes` | number (default 3) | Verifier votes per non-low candidate (low-severity → 1). |
| `verifierModel` | alias | Verifier model override. **Leave unset** — see below. |

### Model note

The verifier **defaults to `BEST_MODEL`** (currently `'opus'`), so you normally pass
**no `verifierModel` at all**. Do **not** pass `'fable'`: Fable 5 is suspended by
export control (since 2026-06-12) and errors at runtime until it returns. (Passing
`'opus'` explicitly is harmless but redundant — it matches the default and emits no
warning.)

## What it returns

A result envelope: `{ subject, lensesUsed, confirmed, refuted, allVerified,
candidateCount, stats, warnings }`. `confirmed` is the actionable list (each with a
`verdict` of `confirmed`/`partially-confirmed`); `refuted` is what the verifiers
killed; `stats`/`warnings` make dropped or capped work visible. Read `confirmed`,
decide which to act on, and **apply them by hand**.

## Example

```js
Workflow({
  scriptPath: "/path/to/toolkit/workflows/independent-analysis.js",
  args: {
    subject: "Promote the cache layer to write-through before the Q3 launch.",
    context: "Read-heavy API; current cache is write-back with a 5s flush.",
    assumptions: ["The DB can absorb 2x write load", "Cache hit rate stays ~90%"],
    lenses: ["failure modes", "data consistency", "operability", "cost", "rollback"],
    votes: 3
  }
})
```
