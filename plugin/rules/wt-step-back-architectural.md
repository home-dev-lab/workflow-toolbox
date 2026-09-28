# Step back to the architectural root — and ground "it doesn't exist" before a workaround

Fix shared root, don't point-patch shared cause. Review findings (own fixes too) landing same
file/area/shape repeatedly = signal of shared architectural root. Stop, question the shape.
Trigger on: 2+ rounds same area; adding second patch to just-patched thing; fix that spawns next
finding. Right moment = FIRST sign, not five commits later.

Same trigger when the nominal cases already work and the next round only chases rare ones —
persistence past diminishing returns is the signal, not the effort spent so far.
Step back ≠ stop, ≠ ask. Re-examine the ROUTE itself before any further round: run two or three
independent analyses from different lenses (competing hypotheses, a structural or architectural
root cause, a simpler reformulated problem, cost of the remaining cases against their frequency);
write down the routes considered and the one kept, and why. Continuing is legitimate when the
analysis confirms the route. Escalate only when no route is found.

Persisting toward a GOAL ≠ persisting on a ROUTE. Worthwhile goal + feasibility unknown (undocumented
platform, SDK or harness behaviour nobody has proven) → enumerate the routes and TRY each with a
small test; never declare it impossible from documentation or priors alone. A route fails → one step
back (two if needed), re-approach from another side: a detour is persistence, not surrender.
Declare the goal out of reach only after every known route was tested and failed — name each route
and its evidence. The drift this rule stops is the opposite case: the goal is already met and the
same route keeps grinding rarer cases.
Goal fixed, means free — by its names:
- Monte Carlo tree search — cheap trial per branch, result propagated back up, budget shifted by
  yield (UCB) while still revisiting little-tried branches; a branch whose yield keeps falling
  loses the effort;
- backtracking search — dead end → back one step, then two; "no solution" only once every branch
  is explored;
- spike / tracer bullet — a small throwaway test answers what docs and priors cannot;
- conjecture and refutation (Popper) — a hypothesis is tested, never believed;
- pivot or persevere (Ries) — persevere on the vision, pivot on the strategy;
- commander's intent — the goal is imposed, the route is chosen on the ground;
- tenacious pursuit, flexible adjustment (Brandtstädter) — hold the goal while means remain,
  adjust it only once they are spent.

Recognise the drift by its names:
- escalation of commitment / sunk cost — continuing because of what is already spent;
- degenerating programme (Lakatos) — each round patches a rarer anomaly, nothing new is gained;
- Einstellung effect — the familiar method hides a simpler one in plain sight;
- diminishing returns (Pareto) — the last rare cases cost most of the effort;
- satisficing (Simon) — acceptance criterion met: stop optimising;
- kill criteria / stop-loss — the point of re-evaluation is set BEFORE starting, not felt during.
Lenses to step back with:
- multiple working hypotheses (Chamberlin; Platt's strong inference) — rival explanations, never one;
- Pólya — reformulate, solve a simpler neighbouring problem, work backwards;
- root cause (5 whys) — the structural cause, not the next symptom;
- explore vs exploit — when a route's yield drops, explore another.

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
