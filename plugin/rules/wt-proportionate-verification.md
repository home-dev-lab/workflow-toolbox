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

This never licenses skipping verification: the gates (test / typecheck / lint by exit code) and
your own diff-read are unconditional. When unsure between two rungs, pick the higher one for
irreversible or outward-facing changes, the lower one otherwise.
