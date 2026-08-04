---
"@workflow-toolbox/patterns": minor
---

`scoreAndRank` now warns when every scored item received the identical combined score.

Same hazard `tournament` gained a detector for: a scorer that fails to discriminate makes the ranking arbitrary, so the cutoff below it cuts on original order rather than merit — and nothing in the result says so.

The test is deliberately weaker than `tournament`'s, and the reason is structural rather than an oversight. `tournament` scores on a fixed 0–10 scale, so "spread below one rubric band" is meaningful there. Here `score` is **unbounded** and its scale belongs to the caller, because `combine` is arbitrary — a fixed threshold would impose a scale the pattern refuses on purpose and would fire constantly on any caller whose natural range is small. Strict equality is the only statement that needs no units. It under-detects (a near-flat set slips through), which is the right trade for a check that must never cry on a legitimate scale.

It warns and changes nothing: identical scores can be honest, and the cutoff stays the caller's to define.
