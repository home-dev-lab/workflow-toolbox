---
"@workflow-toolbox/pipeline-spec": minor
---

A scripted stage may now declare an optional `resultShape` — an expected JSON result shape
(`{ fields: Record<string, ScriptedResultFieldType> }`, field types restricted to
`SCRIPTED_RESULT_FIELD_TYPES`). The external lane is a CLI with no tool-call/schema protocol
to lean on, so compliance is REQUESTED via a prompt-convention instruction
(`describeScriptedResultShape`) and CHECKED after the fact against the raw response text
(`checkScriptedResult`) — never assumed. A conforming response reaches the consumer as
`{ok:true, data}`; a non-conforming one (the COMMON case — a model answering in prose despite
being asked for JSON) is visibly marked `{ok:false, reason}`, never silently coerced and never
a fabricated value that could be misread as a real verdict.

`resultShape` applies UNIFORMLY to every call a stage issues, whichever fan shape is in play —
`calls`, a distinct-prompt `prompt` array, or a single call — one shape, N independently-checked
attempts, never a per-call shape. Omitted: today's exact behaviour, byte-for-byte — no prompt
suffix, no `structured` field on any result.
