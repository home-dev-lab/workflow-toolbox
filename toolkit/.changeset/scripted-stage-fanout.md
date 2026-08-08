---
"@workflow-toolbox/pipeline-spec": minor
---

`ScriptedStageSpec` gains an optional `calls` field: how many concurrent external-lane calls a
scripted stage issues, all resolving the same prompt, before the stage settles. Omitted or `1` is
the exact single-call behavior this package already shipped, byte-for-byte unchanged. A value
outside `[1, MAX_SCRIPTED_STAGE_CALLS]` (the new exported constant, 8) is a rejected spec at
author time, never silently clamped or truncated.

This lets a scripted stage express N independent verdicts from one authoring surface — redundant
review passes or N-of-M voting — rather than only a single sequential call. It does not add
per-call distinct prompts or structured output; those stay separate, later pieces.
