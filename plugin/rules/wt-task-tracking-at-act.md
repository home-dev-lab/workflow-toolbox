# Task tracking — the tracker is the task source of truth (tasks ≠ knowledge) — at act

Move cards AT the transition, in real time — not deferred to checkpoint. Pick card up → move to
In-Progress (before first edit); meets definition of done → move to Done; blocked on external
trigger → move to Blocked, name the trigger. Card left in backlog while its work is underway is
stale board a concurrent session will misread. Multi-step card only partly done stays
In-Progress (record step in comment).

Card quality: concise, action-oriented plain-text title; substance in description; overflow in
comments.

⚠ **CLOSING a card updates its DESCRIPTION, not only a comment.** The description is the surface a
reader — human or tool — sees BY DEFAULT; a comment is one extra call away. So a convention that
puts the durable outcome in comments leaves the STALE pre-work claim exactly where everyone looks
first, and a careful reader following that convention still gets it wrong. Where a description
records something believed and later disproved, mark it refuted with a pointer to whatever carries
the truth — never delete it silently.

⚠ **It fails in the EXPENSIVE direction: it under-reports completion.** Measured on one adopter's
51-card board — an independent fidelity check read descriptions, read zero comments, and reported
three shipped-and-merged features as never built. A reader of the open lists concludes almost
nothing remains; a reader of Done descriptions concludes almost nothing was finished. Two opposite
wrong answers from the same board.

⚠ And any machine-read field convention — a dependency line, a status block — is parsed from the
DESCRIPTION, so recording it in a comment makes it invisible to tooling while looking recorded.

New history overlaps existing bot comment → merge, dedupe into one — never leave two
comments saying same thing.

Reversals reconcile at removal time. Recording "X was removed" in ONE place leaves every other
card, note still presenting X as live. Removal/rename card must name its blast radius (items
referencing retired concept), sweep them: fix open ones, add "superseded by #<id>" pointer to
closed ones without rewriting their history.

Archive Done cards; never hard-delete. Closed card is durable record of how work went — thin
pointer note isn't a substitute — deleting it destroys that history.

Tracker unreachable? Buffer task state in local file under dated "unsynced" section, fold it
back into board on next session that can reach it — verify each entry landed before purging
buffer.
