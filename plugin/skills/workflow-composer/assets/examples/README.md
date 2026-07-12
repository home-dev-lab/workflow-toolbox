# Example workflows

Working material for the `workflow-composer` skill. Two of these files are
complete, runnable raw `.js` workflows; the `toolkit/` subdir holds TypeScript
sources you read rather than run.

## Runnable raw examples

- **`verify-findings.js`** — refute-first adversarial verification of claims
  passed in via `args`. Each claim gets independent verifiers, decided by a
  2-of-3 vote; anything that can't be verified is **kept and flagged**, never
  silently dropped.
- **`repo-health-snapshot.js`** — fans out one reader agent per repo area, then
  hits a synthesis barrier that needs every reader's result at once. Dead or
  skipped readers leave `null` holes that are filtered out and **counted**, so
  coverage loss is visible.

## The `agents/` subdir

Two ready-to-copy `agentType` definitions — `reviewer.md` and `verifier.md` — for the
review/verify roles a composition exposes via `agentTypes.<role>`. See
[`agents/README.md`](agents/README.md) for what they are, how to wire them into
`pr-review`, and which role knob (`review`) is actually wired there today.

## The `toolkit/` subdir

All nine TypeScript composition **sources** from the `@workflow-toolbox` toolkit, kept here
as reading material that shows the library form of a workflow (progressive disclosure
means each one costs no context until you actually read it):

- `pr-review.workflow.ts` — classify the change → per-lens reviewers →
  adversarial verify → synthesis.
- `monorepo-refactor-plan.workflow.ts` — fan out per area, classify, synthesize
  a plan.
- `monorepo-refactor-execute.workflow.ts` — execute the plan with mutating
  agents behind isolation.
- `doc-rewrite.workflow.ts` — generate-and-filter doc rewrites.
- `dev-review-fix.workflow.ts` — review → consolidate → adversarially verify →
  fix → check loop over a change set (the cost-engineering reference: severity-
  gated votes, tiered consolidator, snippet-enriched claims).
- `dev-plan.workflow.ts` — discovery → planner fan-out → adversarial plan
  critique → plan artifact.
- `dev-implement.workflow.ts` — per-task red → green → check TDD loops over a
  plan artifact, sequential or worktree-parallel.
- `dev-full.workflow.ts` — chains the three dev-workflow children via
  `rt.workflow()`, converting human gates into code gates.
- `independent-analysis.workflow.ts` — (optional) lens proposal →
  `fanOutAndSynthesize` one analyst per lens → `adversarialVerification` of the
  survivors. Bias-free multi-lens review of any subject; also shipped as the
  bundled `workflow-toolbox:independent-analysis` plugin workflow.

These `.ts` files are **not directly runnable** as raw workflows. They are
built into `.js` artifacts with `npx workflow-toolbox build <entry>.workflow.ts --typecheck`
(the `workflow-toolbox` CLI ships in `@workflow-toolbox/build`; in the toolkit workspace the
maintainer equivalent is `pnpm wt:build`) — see `toolkit/README.md` at the
repo root.

## Techniques worth copying from the raw examples

- **Args normalization** — read and validate `args` up front, fail fast on bad
  input.
- **Schema'd verdicts** — put a `schema` on every result a later line reads a
  field off.
- **Thunks for `parallel()`** — `[() => agent(...)]`, never bare calls.
- **`.filter(Boolean)` + counted drops** — strip the `null` holes and tally how
  many you lost.
- **Typed stops** — every loop has a hard counter or budget guard.
- **Deterministic tallies in code** — counting is the script's job, never the
  model's.

## Input → output

`verify-findings.js` reads its claims from `args` and returns a tallied verdict.
Launch it with:

```js
Workflow({
  scriptPath: ".../verify-findings.js",
  args: { claims: ["The login endpoint rate-limits at 5/min", "Tokens expire after 24h"] },
})
```

and it returns a shape like:

```jsonc
{
  "confirmed":    [{ "claim": "Tokens expire after 24h", "confirms": 3 }],
  "refuted":      [{ "claim": "The login endpoint rate-limits at 5/min",
                     "refutes": 2, "evidence": ["no limiter in the route", "..."] }],
  "unverifiable": [],            // anything without a 2-of-3 majority lands here — kept, never dropped
  "stats": { "claims": 2, "confirmed": 1, "refuted": 1, "unverifiable": 0 }
}
```

## Running one

1. **Validate first.** From this directory:

   ```bash
   node ../../scripts/validate-workflow.mjs verify-findings.js
   ```

   Or use a full path from the repo root. Exit 0 = clean (warnings allowed);
   exit 1 = errors to fix before launching.

2. **Launch** via the Workflow tool with `scriptPath`, e.g.
   `Workflow({ scriptPath: ".../verify-findings.js" })`. Always check
   `WorkflowOutput.error` — a script that fails its syntax check still returns
   `status: "async_launched"` with `error` set and **never runs**.

## See also

- The `pr-review` composition's committed artifact: `toolkit/workflows/pr-review.js`
  in the repo, run via `Workflow({ scriptPath: '…/pr-review.js' })`.
