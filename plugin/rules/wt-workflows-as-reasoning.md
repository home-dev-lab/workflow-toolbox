# When to reach for a multi-agent fan-out on your own reasoning

A multi-agent fan-out (many fresh-context agents, or a workflow) can augment your reasoning —
but only sometimes. Fire it only when BOTH are high:

- impact (cost of being wrong): irreversible / outward-facing, touches money·security·data-loss,
  more than a few files or untested callers, about to claim "done", or the user pushed back.
  Never for trivial calls.
- opportunity (how much a fan-out reduces the error): HIGH for coverage / exhaustiveness gaps and
  for claims checkable against external ground truth (run the code, read the diff, CI, docs, web);
  QUASI-NULL for reasoning errors rooted in shared model priors — a same-model panel just re-runs
  your own blind spots, so a clean "no issues" there is near-worthless.

The only real decorrelation levers are EXTERNAL EVIDENCE and a GENUINELY DIFFERENT model family
— not more same-model agents. So: for a grounding/coverage gap, use the `deep-grounding` skill
(gather and verify evidence against the real sources first). For red-teaming a plan / claim /
design, use the `independent-analysis` skill. When decorrelation genuinely matters and a
cross-family model is available, route that one pass to it — as INPUT, filtered by finding type
(high on checkable issues, low on "this convention is wrong"), never an autonomous verdict.

Premise quality caps the result: give agents evidence access and OPEN option sets (not closed
menus that hand them your blind spot), frame neutrally, and require them to state what they
could NOT verify. The SOURCE LIST handed to the agents is itself a premise: for
enumeration/coverage tasks, give COMPLETE listings of the relevant directories or source
families and let agents pick within them — a hand-curated selection silently caps coverage at
what it happened to include. Pre-commit a one-line prediction before firing (theatre shows up
as unmet predictions). You stay the arbiter — a fan-out's verdict does not override your richer
in-context read, nor license skipping an escalation.

Watch the overturn rate informally: if fan-out runs never change a decision or retract a
claim, they are cost without behaviour change — stop firing them, or fix the framing.
