# Worked example: the `pr-review` shape

<!-- Extracted from SKILL.md (progressive disclosure) — loaded on demand via the stub that links here. -->


Read the full source at `assets/examples/toolkit/pr-review.workflow.ts` (bundled with
this skill; the same file lives at `toolkit/examples/pr-review.workflow.ts` in the
repo). It is the canonical
illustration of every defence layer (schema-at-boundary, refute-first verify, decomposed scopes — see [model-and-agent-routing.md](model-and-agent-routing.md)). Five stages, each shaped by *why*:

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

The lens list is category-driven, plus up to two conditionally-triggered extras
(docs-alignment and its inverse docs-coverage, below) — the first: the Route
stage returns the change's `changedFiles` (agent-reported from the real diff — the
script itself has no fs/git to cross-check it), and when any of them matches the
committed doc↔source provenance map (`docs-provenance.ts`, bundled at build time;
entries ending in `/` cover a subtree, all others match exactly), a
**`docs-alignment`** reviewer is appended, scoped to exactly the mapped doc
surfaces. Its findings are stale prose claims (`file` = the doc path), verified
like any other finding; the run's `provenanceDocs` output names the surfaces it
covered (empty = lens skipped, zero extra agents), and an empty `changedFiles` on a
range-shaped target trips a loud warning (a real range always changes ≥1 file — an
empty list there is schema capitulation, and it would otherwise silently disarm the
lens). The pattern to copy: *deterministic script code decides whether to spawn —
on agent-reported data; the LLM only judges the prose.*

The bundled map covers dwt paths only, so on an **external repo** the lens would
never arm — the launch-time **`provenance`** knob closes that: pass
`args.provenance` (a non-empty array of `{ sources, docs }` entries, same
subtree-vs-exact matching semantics) and it **replaces** the bundled manifest for
the whole cross-check (never merged — the bundled map is dwt-specific). Validated
fail-fast in `parseInput` (`parseProvenance`); the result's `provenanceSource`
(`'input'` | `'bundled'`) reports which manifest was consulted, so a mis-shaped
launch manifest that matches nothing stays distinguishable from "no mapped module
touched".

The INVERSE direction has its own conditional lens: the Route stage also reports
`addedPublicSurface` (the NEW exports, HTTP routes, env vars, CLI verbs/flags the
change adds; empty when nothing new is exposed), and when it is non-empty while
the diff touches **no** doc file, a **`docs-coverage`** reviewer is appended — it
judges each added surface *user-facing or internal plumbing?* and reports the
user-facing ones as findings naming the doc surface where they belong (the mapped
provenance homes when the module is mapped). The run's `coverageSurfaces` output
names what armed it (empty = silent: nothing added, or the author already touched
docs in the same diff — the alignment lens and the repo's mechanical inverse
docs-contract gates cover that path). Same pattern again: *deterministic script
code decides whether to spawn; the LLM only judges "user-facing?".*

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

**The proportionate-review ladder — a launch-time `mode` knob, not a design fork.**
`mode: 'full'` (default, and what an omitted `mode` resolves to — bit-compatible with
the pre-ladder behavior) runs the pipeline over EVERY lens above, one reviewer each,
exactly as shown. `mode: 'single-verifier'` is the quota-degraded rung: the pipeline
collapses to a single sentinel item, and the review stage builds ONE prompt that
concatenates every armed lens' own instructions (the same `lensInstructionsFor`
builder, called once per lens and joined) instead of spawning one reviewer per lens —
same `FINDINGS_SCHEMA`, same `agentTypes.review` routing (this is exactly the shape a
cross-family or quota-degraded verifier wants), same effort. `verifyStage` is
untouched: it still adversarially verifies whatever that one reviewer found — the
ladder degrades the *finder* count, never the *verification* step, and Synthesize is
unaffected either way. `'diff-read'`, the ladder's bottom rung, is deliberately not a
mode this workflow accepts: it means "read the diff yourself, don't launch this
workflow" — requesting it is a parse-time error, not a silent no-op.

**4. Synthesize — a genuine barrier.** Synthesis needs *all* verified findings from
*all* lenses, so this is the one place a barrier is correct. Only non-`refuted`
findings flow in: `unverifiable` means a verifier failed, not that the finding is
wrong, and `unverified-by-cap` means the verification cap cut the claim before any
verifier ran (`votes: []`) — both are **kept and flagged** rather than dropped, and
neither is a refutation. Synthesis is the final
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

