# Scale verification to the change's risk

<!-- embedded-copy:proportionate-verification-ladder:start -->
Verification is mandatory; how much of it you spin up scales with what changed. Gates
(test/typecheck/lint by exit code) and your own diff-read are unconditional at every rung — the
ladder only decides how many INDEPENDENT review agents the change buys. Match the shape to the
range:

- **Feature / production-logic range** (new behavior, larger diffs, or touches money · security
  · data-loss grade logic) → a full multi-lens adversarial review.
- **Follow-up range** (implementing an approving round's own findings, small diff, no new
  design) → ONE targeted diff-grounded verifier, or your own careful diff-read plus the gates.
  Not a fresh full fan-out.
- **Test-only / comment-only / docs-only range** → your diff-read plus the gates. No agents.
- **Batch, don't dribble:** review the CONSOLIDATED batch range once (base..head), never each
  micro-commit separately.

On any fan-out: pin an explicit cheap model for the bulk and reserve the strong model for
verifiers. If you must cut to a single verifier, cut the COUNT, not the model. The real
decorrelation lever is a genuinely different model family — or external evidence — never more
same-model agents: a same-model panel shares the author's own blind spots, so a clean "no
issues" from it is near-worthless, and that is the reason to reach cross-family, not a
stylistic preference. A cross-family verifier has no project context, so weight its findings by
type: high signal on checkable / reproducible-crash issues, low on "this convention is wrong".
It is input, never an autonomous verdict: you stay the arbiter, and a verdict that contradicts
your richer in-context read does not auto-win.

## Breadth is a second, independent axis

The ladder above scales verification to what the CHANGE introduces — that is DEPTH. It is
structurally blind to a different failure class: a defect already sitting elsewhere on the same
exposed surface (a rendered interface, an API shape, a CLI's output, a generated artifact — any
outward-facing result), because no assertion derived from a diff covers what nobody had a
hypothesis about. A scoped check finds only what it was pointed at, however deep it goes.

- Before presenting an exposed surface as ready, sweep the WHOLE surface once, the way its real
  consumer would encounter it — not only the assertions the diff suggested.
- Depth and breadth are independent: assess both, and neither substitutes for the other. A
  narrow, low-risk change can still land on a surface that deserves a full breadth sweep; a
  surface nobody else touches may need only the change's own depth once assessed.
- Handle a breadth finding like any other finding: fix it in scope, record what is not — never
  fold an out-of-scope find into a silent extra fix. A code fix earns a test that fails before
  the fix and passes after, like any other review finding.

This never licenses skipping verification: the gates (test / typecheck / lint by exit code) and
your own diff-read are unconditional on both axes. When unsure between two rungs, pick the higher
one for irreversible or outward-facing changes, the lower one otherwise.
<!-- embedded-copy:proportionate-verification-ladder:end -->

<!-- Embedded elsewhere in this plugin (delegated agents run with no ambient rules — only
     their own definition reaches them): plugin/agents/pilot.md and
     plugin/agents/pilot-orchestrator.md each carry a byte-identical copy of the block above,
     between the same `embedded-copy:proportionate-verification-ladder` markers. This file is
     the canonical source — if you edit the ladder, copy the exact text into those embedded
     copies too; never edit an embedded copy independently of this source. -->
