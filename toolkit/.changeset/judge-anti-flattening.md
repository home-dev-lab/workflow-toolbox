---
"@workflow-toolbox/patterns": minor
---

`tournament` judges now score against an ANCHORED RUBRIC by default, and the pattern warns when the panel failed to discriminate.

Two measured failures motivate this, on two different model families. One external verifier lane FLATTENED severity — it folded the single correctness regression in a set into a generic presentation item. A second family was UNSTABLE rather than flat, scoring the identical defect HIGH on one run and MED on the next; a reader seeing only the second run would have triaged a security flaw as medium. Two families, two mechanisms, one axis missed — a limit of the ROLE, not of a model.

`judgeRubric` (default `true`) ships a described 0–10 scale in the judge schema, so a judge has something absolute to place its attempt against. Set `judgeRubric: false` for absolute scoring where a flat distribution is honest — a conformance score where everything may legitimately be a 10.

⚠ The rubric is deliberately ABSOLUTE, never comparative. The idea arrives from tree-of-thoughts implementations as a quota ("across K siblings, at most one earns the top band"), and that shape is unusable here: a judge in this pattern scores ONE attempt per call and never sees its siblings. An unenforceable comparative instruction is worse than none, because the model supplies an imagined comparison. Giving judges sibling visibility to enable the quota would pay for it with the panel's independence, which is the reason the panel exists.

Alongside it, a pure-data flattening detector: after the medians are tallied, a score spread below one rubric band across two or more ranked attempts emits a warning that the ranking is near-arbitrary. It never rewrites the ranking — a flat set can be honest — and it costs no extra agent call. This is the half that survives a prompt the model declines to follow: it measures whether discrimination actually happened instead of assuming the instruction worked.

`scoreAndRank` is deliberately NOT changed: its score is unbounded and its scale is caller-defined, so a fixed-band rubric would impose a scale the pattern refuses on purpose.
