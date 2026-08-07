---
"@workflow-toolbox/pipeline-spec": minor
---

A pipeline stage can now be a scripted external-lane call, alongside ordinary `workflow` and
`pipeline` stages in the same stage list.

`StageSpecV2` gains a third mutually-exclusive kind, `scripted?: ScriptedStageSpec` — a `model`
identifier plus a `prompt` `InputRef`, resolved to a single string rather than an args record.
`validateStageList` now enforces "exactly one of `workflow`, `pipeline`, or `scripted`" (the error
message widened accordingly — any code matching its exact old two-way wording needs updating).

`INPUT_REF_SOURCES` gains a fourth source, `'artifactContent'`, resolving to the prior stage's
handoff artifact read off disk as text (as opposed to `'artifactPath'`, which resolves to the path
itself) — usable from an ordinary workflow stage's `input` too, not just a scripted stage's prompt.

The runtime side (the companion Workflow Observatory's pipeline runner) adapts a scripted stage to
the same `LaunchedStage` contract a workflow stage's launch already produces, so gate handling,
artifact extraction, and settlement treat a scripted stage exactly like a workflow stage.
