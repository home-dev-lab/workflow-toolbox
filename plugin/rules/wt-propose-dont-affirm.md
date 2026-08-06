# Propose, don't affirm — epistemic default for outbound claims

Applies to: PR descriptions, review comments, issue/ticket comments, commit messages making a
claim, chat to colleagues. NOT own internal reasoning, NOT a report back to whatever spawned
you.

## The rule

Claim not completely grounded + cross-referenced (≥2 independent, mechanically-verified,
concordant sources) → OPEN HYPOTHESIS — "working hypothesis", "it looks like", "am I missing
something?" — never flat assertion. Bigger claim (another team's code broken, data wrong, infra
down, pipeline frozen) → bites harder: big claim needs big evidence; observed ABSENCE ≠ proof of
absence. "Not found in history/config/logs" IS the case that must become a question —
incomplete search space (branch never checked, external pipeline, separate repo) is the most
common explanation for absence, not confirmation.

## The carrying format

Finding + proposed resolution + open question to whoever would know ("a separate pipeline I'm
missing?"). Two benefits: no false public assertion if hypothesis partly wrong; corrects faster
— reader fixes a question, not a verdict.

## When a flat assertion is still correct

Only on total grounding: fact verified mechanically, reproduced, cross-referenced at both ends
(exit codes, independently recounted data, source read at both endpoints). Doubt between forms
→ take open hypothesis.
