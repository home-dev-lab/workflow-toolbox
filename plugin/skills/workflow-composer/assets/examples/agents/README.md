# Example reviewer/verifier agents

Two ready-to-copy `agentType` definitions for the review/verify roles that
`@workflow-toolbox/patterns` compositions expose via the structured `agentTypes.<role>`
config envelope:

- **`reviewer.md`** — a domain-agnostic, diff-grounded multi-lens code reviewer
  (correctness, security, performance, test coverage). Read-only tools plus read-only git;
  no `SendMessage`.
- **`verifier.md`** — a refute-first adversarial verifier that checks a single finding at a
  time, defaulting to refuted unless the evidence survives. Same read-only, no-`SendMessage`
  shape, pinned to a strong model since a wrong verdict here is the expensive kind of wrong.

## Why these live here, not in `plugin/agents/`

`plugin/agents/` is reserved for runtime-required, cross-cutting defaults every consumer of
the plugin gets automatically (e.g. the leaf-agent fence). `reviewer.md` and `verifier.md`
are optional accessories for a specific composition's routing knob — bundling them as
plugin agents would register them in every user's agent list whether or not they use them.
As example assets, they cost nothing until a user copies them in.

## Wiring in

1. Copy both files into your project's own agent registry:

   ```bash
   cp reviewer.md verifier.md /path/to/your/project/.claude/agents/
   ```

   The registry is read at session start, so a fresh session is needed before
   `agentType: 'reviewer'` (or `'verifier'`) resolves.

2. Route the **reviewer** role into `pr-review`'s per-lens reviewers via the structured
   config envelope:

   ```js
   Workflow({
     scriptPath: '.../pr-review.js',
     args: { target: 'HEAD~3..HEAD', agentTypes: { review: 'reviewer' } },
   })
   ```

   `pr-review` probes the requested type before any reviewer spawns and degrades to the
   standard subagent — reported in the result's `probe` field, never silently — when the
   type can't answer.

3. **`verifier.md` and the `verify` role.** The structured `agentTypes.verify` knob is real
   and used by other compositions in this toolkit (`independent-analysis`,
   `cross-model-verify`) to route their adversarial-verification fan to a specialist or a
   cross-family bridge. `pr-review`, as shipped, only reads `agentTypes.review` — its verify
   fan does not currently expose a matching `verify` role knob, so passing
   `agentTypes: { verify: 'verifier' }` to `pr-review` has no effect today. Use
   `verifier.md` directly wherever `adversarialVerification`'s own `verifierType` option is
   exposed (`independent-analysis`, `cross-model-verify`, or a custom composition you
   author), and treat wiring it into `pr-review` as a natural follow-on enhancement to that
   workflow rather than something these example files alone can turn on.

## The trade-off these mitigate

Every agent a toolkit workflow spawns defaults to a leaf-fenced generic executor (no
`SendMessage`, no advertisement of who else is addressable) — that fence is the toolkit's
own baseline, not something these files add. What the fence gives you is a personality-less
worker: safe, but with no review lenses, no refute-first discipline, no model/effort tuned
for the role. `reviewer.md` / `verifier.md` keep that same safety property (still no
messaging surface) while adding the domain-specific behavior a generic leaf lacks.

The residual case these files are the direct mitigation for: launching the workflow
in-session (rather than via a headless/server launch) from a conversation that itself has
other live agents addressable by name. Where that combination is a concern, either launch
headless instead, or wire these agent definitions in so the roles run under a fixed,
reviewed persona rather than the ambient default.

## See also

- [`../toolkit/pr-review.workflow.ts`](../toolkit/pr-review.workflow.ts) — the composition
  these agents route into (the `Probe` phase and the `agentTypes.review` knob).
- [`../../references/model-and-agent-routing.md`](../../references/model-and-agent-routing.md)
  — the full rules on model tiering, `agentType` routing, and the capability-fence
  mechanism these two files rely on.
