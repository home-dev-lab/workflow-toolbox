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

The lens list is category-driven, plus one MECHANICALLY-triggered extra: the Route
stage returns the change's `changedFiles`, and when any of them prefix-matches the
committed doc↔source provenance map (`docs-provenance.ts`, bundled at build time —
the sandbox has no fs), a **`docs-alignment`** reviewer is appended, scoped to
exactly the mapped doc surfaces. Its findings are stale prose claims (`file` = the
doc path), verified like any other finding; the run's `provenanceDocs` output names
the surfaces it covered (empty = lens skipped, zero extra agents). The pattern to
copy: *deterministic script code decides whether to spawn; the LLM only judges the
prose.*

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

