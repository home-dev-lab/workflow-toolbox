# Scale verification to the change's risk

Verification is mandatory; how much of it you spin up scales with what changed. Match the shape
to the range:

- New behavior / production-critical logic (money, security, data-loss, or a large diff) → a
  full multi-lens adversarial review.
- A follow-up range implementing an approving round's own findings (small diff, no new design) →
  ONE targeted diff-grounded verifier, or your own careful diff-read plus the gates. Not a fresh
  full fan-out.
- Test-only / comment-only / docs-only → your diff-read plus the gates. No agents.
- Review the CONSOLIDATED batch range once (base..head), never each micro-commit separately.

On any fan-out: pin an explicit cheap model for the bulk and reserve the strong model for
verifiers. If you must cut to a single verifier, cut the COUNT, not the model — and prefer a
genuinely different model family for that one verifier (decorrelated priors are the point). A
cross-family verifier has no project context, so weight its findings by type: high signal on
checkable / reproducible-crash issues, low on "this convention is wrong". It is input, never an
autonomous verdict.

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
