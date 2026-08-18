---
"@workflow-toolbox/pipeline-spec": major
---

Remove the `scripted` pipeline stage from `@workflow-toolbox/pipeline-spec`.

`StageSpecV2` now allows only `workflow` or `pipeline`, and authored or parsed specs using
`scripted` are rejected. The scripted-stage-only exports are removed too:
`ScriptedStageSpec`, `PromptPart`, `ComposedPrompt`, `MAX_SCRIPTED_STAGE_CALLS`,
`SCRIPTED_RESULT_FIELD_TYPES`, `ScriptedResultFieldType`, `ScriptedResultShape`,
`ScriptedResultCheck`, `describeScriptedResultShape`, and `checkScriptedResult`.
