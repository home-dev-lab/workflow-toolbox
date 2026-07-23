# Task tracking — the tracker is the task source of truth (tasks ≠ knowledge)

Keep two stores distinct. TASKS (their status, priority, and full chronological history) live in
your task tracker — the card/ticket description holds the lean essentials, its comments hold the
rich detail. KNOWLEDGE (reusable facts, decisions, gotchas, runbooks, preferences) lives in your
memory/notes, not on the board. If you also keep a project pointer note, make it a thin pointer to
the card, not a parallel narrative — write the narrative to the CARD (one consolidated, deduped
comment), and preserve any human-authored comments.

Move cards AT the transition, in real time — not deferred to a checkpoint. The moment you pick a
card up, move it to In-Progress (before the first edit); the moment it meets its definition of
done, move it to Done; if it's blocked on an external trigger, move it to Blocked and name the
trigger. A card left in the backlog while its work is underway is a stale board a concurrent
session will misread. A multi-step card that's only partly done stays In-Progress (record the step
in a comment).

Card quality: a concise, action-oriented plain-text title; the substance in the description;
overflow in comments. When new history overlaps an existing bot comment, merge and dedupe into one
— never leave two comments saying the same thing.

Reversals reconcile at removal time. Recording "X was removed" in ONE place leaves every other card
and note still presenting X as live. A removal/rename card must name its blast radius (the items
that reference the retired concept) and sweep them: fix the open ones, and add a "superseded by
#<id>" pointer to the closed ones without rewriting their history.

If the tracker is unreachable, buffer task state in a local file under a dated "unsynced" section,
then fold it back into the board on the next session that can reach it — verifying each entry
landed before purging the buffer.
