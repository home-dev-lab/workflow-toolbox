---
"@workflow-toolbox/pipeline-spec": minor
---

Add `PipelineSpec.limits` (type `PipelineLimits`, optional): a per-spec override of `MAX_STAGES` (12) /
`MAX_PIPELINE_DEPTH` (8) / `MAX_LOOP_ITERATIONS` (10), each validated against a new documented absolute
ceiling (`MAX_STAGES_CEILING` 100, `MAX_PIPELINE_DEPTH_CEILING` 20, `MAX_LOOP_ITERATIONS_CEILING` 100) —
a hard literal in a published package was silently capping any spec author who legitimately needed more
than 12 stages, with no lever. The three existing constants keep their exact names and values as the
safe DEFAULTS; omitting `limits` behaves identically to today. `validateStageList` gains an optional
second `limits` parameter (backward compatible — existing single-argument call sites are unaffected);
`validatePipelineSpec` and `parsePipelineSpec` read the override straight off `spec.limits`, no signature
change. A nested `pipeline`-stage's child spec may set its own `limits` independently (no inheritance
from a parent spec, same posture as the existing `loop` field). Validation failure messages now NAME the
offending knob (`limits.maxStages`, `limits.maxPipelineDepth`, `limits.maxLoopIterations`).
