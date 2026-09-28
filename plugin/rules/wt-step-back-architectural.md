# Step back to the architectural root — and ground "it doesn't exist" before a workaround

Fix shared root, don't point-patch shared cause. Review findings (own fixes too) landing same
file/area/shape repeatedly = signal of shared architectural root. Stop, question the shape.
Trigger on: 2+ rounds same area; adding second patch to just-patched thing; fix that spawns next
finding. Right moment = FIRST sign, not five commits later.

Same trigger when the acceptance criterion is already met and the next round only chases rare
cases, or when two consecutive attempts on one route produced no new evidence. After each attempt:
"what do I know now that I did not know before?" — nothing = stagnation. An edit is not an attempt
unless it tests a different prediction. Route = causal hypothesis + intervention mechanism; three
implementations of one hypothesis are ONE route, a new route changes at least one of the two.

Step back ≠ stop, ≠ ask. Before touching the code again: restate facts / assumptions / unknowns;
list 2–3 materially distinct routes, at least one aimed at a structural cause, each with its
smallest discriminating test and what its result would teach; pick by information gained per cost,
never by what is already spent; write the chosen route's kill criterion BEFORE resuming. Record the
routes and the choice. Escalate only when no route is left.

Persist on the GOAL, not on the ROUTE. Worthwhile goal on an unproven platform (undocumented SDK or
harness behaviour) → try routes by small tests, never "impossible" from docs or priors. Route fails
→ back one step, two if needed, re-approach from another side. BLOCKED only when every materially
distinct route from the step-back was tested or ruled out by evidence: report route → experiment →
result → conclusion for each.

Names, to recognise it: sunk cost / escalation of commitment, degenerating programme (Lakatos),
Einstellung, diminishing returns, satisficing; goal fixed, means free — backtracking, Monte Carlo
tree search, spikes, conjecture and refutation, pivot or persevere, multiple working hypotheses.

For ANYTHING distributed — rule, script, hook, helper or other file — check for a shipped twin and
carry a needed fix there in the SAME pass, reading that twin for improvements to carry back.
"Does the distributed set already carry this?" is answered against the SOURCE at a named revision,
never an installed copy.

Survey before Nth copy (Rule of Three). Before writing a shape that exists elsewhere: grep/read,
count real occurrences codebase-wide, variants included. 1st time: write it. 2nd: duplicate. 3rd:
default = generalize. Only when instances share REASON TO CHANGE — same shape ≠ same concept.
Alike but different reasons to evolve → keep duplication (wrong abstraction couples unrelated
things, costly to undo), name in one line why coincidental. Abstract only for present concrete
consumers, never a speculative future one. Generalising? NAME the pattern you applied and why that
one — or say in one line why none fits. A generalisation with no named pattern cannot be reviewed:
the next reader cannot tell a deliberate choice from an accidental switch statement.

Ground premise before workaround. Before building around "doesn't exist" / "not possible": read
real source (or fan read-only agents for coverage) to confirm — confident architectural prior is
cheap to check, often wrong. Incremental fix can still ship; log the root for next pass.
