---
'@workflow-toolbox/patterns': minor
---

`adversarialVerification` now cost-bounds an EXTERNAL cross-family verifier. When
`verifierType` routes to a registered external CLI (opencode / codex), the wrapper is a thin
RELAY whose own model does not drive verdict quality (the external CLI does), so the wrapper
model now defaults to `haiku` instead of `BEST_MODEL` — a self-answer failure is then ~10×
cheaper — and NO model-downgrade warning fires for that relay (the "quality is
model-sensitive" premise does not hold for a relay). A plain Claude verifier is unchanged
(BEST_MODEL default, downgrade warning on a weaker model), and a caller can still pin the
wrapper model explicitly.

It also emits ONE aggregated run-level `SELF-ANSWER TOLL` warning summarizing how many
external votes returned a verdict with no credited CLI invocation (confirmed self-answer vs
undetermined), how many were recovered on retry, and how many remain null — the control
surface for the budget the post-hoc provenance gate nullifies but cannot refund.
