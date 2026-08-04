---
"@workflow-toolbox/patterns": minor
---

`tournament`'s `judgeRubric` is now **opt-in** (default `false`). It shipped default-ON one version earlier; this reverses that on evidence, not on caution.

It was benched against a corpus whose severities were fixed before any judge saw it, two passes per condition, judges called **directly** on a cross-family CLI so every cell's provenance is its own invocation. (An earlier attempt routed the judges through an agent wrapper and had to be discarded: only 9 of 20 transcripts contained a CLI invocation, while all 20 mentioned the model name — because that name came from the prompt.)

On the metric the rubric exists for — separating a security flaw from a cosmetic one:

| condition | security-vs-cosmetic gap | instability across passes |
|---|---|---|
| rubric | 4, 5 | **1** |
| bare | 7, 5 | 3 |

The rubric did not improve discrimination; it compressed it, being harsher on the correct-but-badly-named candidate (6/7 instead of 8) and slightly kinder to the actual flaw (2 instead of 1). What it clearly did improve is run-to-run **stability**.

Two failures motivated this work: a family that FLATTENED severity, and a family that was UNSTABLE across runs. The rubric answers the second and not the first. A default that changes behaviour for every caller needs positive evidence for its primary purpose, and has none — so it becomes a knob you turn on when run-to-run stability matters more than the sharpest possible ranking.

⚠ n=2 passes per condition. One flip moves the table; this is directional evidence, not a settled measurement, and the docstring says so where a caller will read it.

The flattening **detector** is unchanged and still on: it is mechanical, costs no agent call, and measures whether discrimination actually happened rather than assuming a prompt achieved it.
