# Step back to the architectural root — and ground "it doesn't exist" before a workaround

Fix shared root, don't point-patch shared cause. Review findings (own fixes too) landing same
file/area/shape repeatedly = signal of shared architectural root. Stop, question the shape.
Trigger on: 2+ rounds same area; adding second patch to just-patched thing; fix that spawns next
finding. Right moment = FIRST sign, not five commits later.

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
