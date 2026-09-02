# When to reach for a multi-agent fan-out on your own reasoning

Multi-agent fan-out (many fresh-context agents, or a workflow) can augment your reasoning — but
only sometimes. Fire it only when BOTH are high:

- impact (cost of being wrong): irreversible / outward-facing, touches money·security·data-loss,
  more than a few files or untested callers, about to claim "done", or user pushed back. Never
  for trivial calls.
- opportunity (how much a fan-out reduces the error): HIGH for coverage / exhaustiveness gaps,
  and for claims checkable against external ground truth (run the code, read the diff, CI, docs,
  web); QUASI-NULL for reasoning errors rooted in shared model priors — a same-model panel just
  re-runs your own blind spots, so a clean "no issues" there is near-worthless.

Adding agents does not add independence. What decorrelates, in descending order of value:
EXTERNAL EVIDENCE and mechanical ground truth first — they REPLACE judgment rather than
corroborate it; then METHOD diversity — same question reached by genuinely different routes,
static vs dynamic vs property vs differential; then independent hypotheses, distinct information,
distinct lenses; and only then a different MODEL FAMILY, one axis among these rather than the
master lever. Shapes below map onto that ordering — full list and evidence in
`wt-proportionate-verification.md`.

So: grounding/coverage gap → `deep-grounding` skill (gather and verify evidence against real
sources first). Red-teaming a plan / claim / design → `independent-analysis` skill. Decorrelation
genuinely matters and a cross-family model is available → route that one pass to it, as INPUT,
filtered by finding type (high on checkable issues, low on "this convention is wrong"), never an
autonomous verdict.

⚠ **Collect verdicts in parallel and in isolation — never as a debate.** Once one agent reads
another's answer the independence is spent, and inter-agent sycophancy then collapses the panel
onto a premature consensus that scores WORSE than a single agent (arXiv:2509.23055). Aggregate
mechanically, let the arbiter resolve the disagreement — the disagreement is the product.

Premise quality caps the result: give agents evidence access and OPEN option sets, not closed
menus that hand them your blind spot; frame neutrally; require them to state what they could NOT
verify. The SOURCE LIST handed to the agents is itself a premise: for enumeration/coverage tasks
give COMPLETE listings of the relevant directories or source families and let agents pick within
them — a hand-curated selection silently caps coverage at what it happened to include. Pre-commit
a one-line prediction before firing: theatre shows up as unmet predictions. You stay the
arbiter — a fan-out's verdict does not override your richer in-context read, nor license skipping
an escalation.

Watch the overturn rate informally: fan-out runs that never change a decision or retract a claim
are cost without behaviour change — stop firing them, or fix the framing.
