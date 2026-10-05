This reference belongs to the workflow-debugger skill. Its text moved here verbatim from that skill's SKILL.md, so every path and link in it means what it meant there: a link to another reference file resolves from the skill directory (the parent of this references/ folder), and a project or repository path keeps its own base.

## Honesty about what is observed vs inferred

Both journal signals ARE observed in real journals on disk: agents DO end in
non-`done` states (`error`, plus `progress`/`start` frozen mid-flight on runs that
died), and `attempt > 1` DOES occur (StructuredOutput schema retries recorded in
real runs). They stay rare next to the healthy population — treat a classification
built on them as a strong hint and confirm against the agent's transcript. Budget
exhaustion stays an advisory text Finding (never a primary verdict, so a wording
miss costs nothing).

**A second schema failure shape is also observed** (live probe, CC 2.1.170): give an agent an
unsatisfiable schema and `attempt` still never goes above 1 — the runtime nudges the
SAME agent conversation to call StructuredOutput, and after 2 in-conversation nudges
the `agent()` call **throws** `agent({schema}): subagent completed without calling
StructuredOutput`, while the journal records the failing agent as `done`/`attempt: 1`.
The run therefore lands as a `script-throw`; the debugger matches that error signature
and attaches a **schema-hint** finding telling you to fix the schema and re-run — the
"done" agent's cache holds no usable result, so resuming buys nothing for that call.

