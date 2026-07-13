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

2. Route the **reviewer** and **verifier** roles into `pr-review` via the structured
   config envelope — each role is probed independently and wired to its own stage:

   ```js
   Workflow({
     scriptPath: '.../pr-review.js',
     args: {
       target: 'HEAD~3..HEAD',
       agentTypes: { review: 'reviewer', verify: 'verifier' },
     },
   })
   ```

   `pr-review` probes each requested type before its stage spawns any agent and degrades to
   the standard subagent — reported in the result's `probe` (review) / `verifierProbe`
   (verify) fields, never silently — when a type can't answer. `agentTypes.review` routes
   only the per-lens reviewers; `agentTypes.verify` routes only the adversarial-verification
   fan (`adversarialVerification`'s own `verifierType` option) — the synthesizer is never
   specialized by either knob.

3. **`verifier.md` and the `verify` role.** The structured `agentTypes.verify` knob is real
   and used by other compositions in this toolkit (`independent-analysis`,
   `cross-model-verify`) to route their adversarial-verification fan to a specialist or a
   cross-family bridge — and `pr-review` now wires it too (its Verify stage's own
   `adversarialVerification` call), symmetric with `agentTypes.review`. Use `verifier.md`
   wherever `adversarialVerification`'s own `verifierType` option is exposed (`pr-review`,
   `independent-analysis`, `cross-model-verify`, or a custom composition you author) — the
   same probe-then-degrade contract applies everywhere it's wired in.

## The trade-off these mitigate

Every agent a toolkit workflow spawns defaults to a leaf-fenced generic executor (no
`SendMessage`, no advertisement of who else is addressable) — that fence is the toolkit's
own baseline, not something these files add. What the fence gives you is a personality-less
worker: safe, but with no review lenses, no refute-first discipline, no model/effort tuned
for the role. `reviewer.md` / `verifier.md` keep that same safety property (still no
messaging surface) while adding the domain-specific behavior a generic leaf lacks.

## Related: `lean`, for pure-reasoning roles (not an example asset — ships as a plugin agent)

`reviewer.md` / `verifier.md` above address WHO reviews (a specialist persona); a
different, orthogonal knob addresses HOW MUCH each spawn costs. Every agent — including a
`leaf`-fenced one — is still injected with the full ambient session context (rules, memory
index, the whole skill/MCP listing) as text on every spawn; a role whose entire task is
already inline in its prompt (classify / vote / judge / score / dedup / synthesize; never
reads a file, runs a command, or calls a tool) gains nothing from that injection. The
toolkit ships `plugin/agents/lean.md` (an empty `tools` allowlist + `disallowedTools:
SendMessage`) plus `withLeanRouting` (`@workflow-toolbox/patterns`) to route just those
call sites through it — selectively, per call site, never blanket like the leaf fence. See
[`../../references/model-and-agent-routing.md`](../../references/model-and-agent-routing.md)'s
"Which agentType for which role" section for the full standard/leaf/lean/cross-family
picture, and `pr-review.workflow.ts`'s Synthesize stage for the reference wiring.

The residual case these files are the direct mitigation for: launching the workflow
in-session (rather than via a headless/server launch) from a conversation that itself has
other live agents addressable by name. Where that combination is a concern, either launch
headless instead, or wire these agent definitions in so the roles run under a fixed,
reviewed persona rather than the ambient default.

## See also

- [`../toolkit/pr-review.workflow.ts`](../toolkit/pr-review.workflow.ts) — the composition
  these agents route into (the `Probe` phase and the `agentTypes.review` / `agentTypes.verify`
  knobs).
- [`../../references/model-and-agent-routing.md`](../../references/model-and-agent-routing.md)
  — the full rules on model tiering, `agentType` routing, and the capability-fence
  mechanism these two files rely on.
