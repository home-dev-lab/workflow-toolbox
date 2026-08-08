---
"@workflow-toolbox/pipeline-spec": patch
---

Correct the rationale documented on `MAX_SCRIPTED_STAGE_CALLS`. No behaviour change: the cap is
still 8 and an out-of-range value is still rejected rather than clamped.

The previous comment justified the cap as protecting a constraint that is "external and fixed".
That contradicted this project's own operational notes, which record the external concurrency
wall as MOVING with the subscribed plan — so a reader comparing the two texts could not tell
which was true, and an adopter on a larger plan would read the frozen cap as a claim about their
machine's capacity.

The cap and the runtime wall are two different concerns, and the comment now says so: the
runtime wall belongs to the lane guard's tunable parameter, which bounds concurrent external
processes on one machine; this cap is an authoring-time sanity bound on a single stage of a
PORTABLE spec, which is why it must not depend on the reader's environment — the same JSON
would otherwise be valid on one machine and invalid on another.
