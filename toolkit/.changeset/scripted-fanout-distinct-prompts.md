---
"@workflow-toolbox/pipeline-spec": minor
---

A scripted stage's `prompt` may now be authored as an ARRAY of `InputRef`s instead of one —
each element becomes its own concurrent call, resolved independently, so a review with several
lenses can express N *different* questions rather than N redundant copies of the same one.

The array's own length is the call count, so `calls` is a rejected combination alongside an
array `prompt` — the two must not be able to disagree about how many calls a stage issues.
Bounded by the same `MAX_SCRIPTED_STAGE_CALLS`, enforced at both the untrusted-JSON parse
boundary and `validateStageList` (an in-process caller that builds a spec directly still hits
the cap). A single `InputRef` `prompt` — the existing shape — is entirely unaffected: omitted
or scalar `calls` still fans N *identical* verdicts exactly as before, byte-for-byte.
