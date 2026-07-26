# Task tracking — the tracker is the task source of truth (tasks ≠ knowledge)

Keep two stores distinct. TASKS (their status, priority, and full chronological history) live in
your task tracker — the card/ticket description holds the lean essentials, its comments hold the
rich detail. KNOWLEDGE (reusable facts, decisions, gotchas, runbooks, preferences) lives in your
memory/notes, not on the board. If you also keep a project pointer note, make it a thin pointer to
the card, not a parallel narrative — write the narrative to the CARD (one consolidated, deduped
comment), and preserve any human-authored comments.

A managed board keeps a small, fixed set of lists standing for lifecycle stages (e.g. Backlog,
Next, In Progress, Blocked, Done, plus a catch-all for descoped work) so "what's open" is a
mechanical query, not a per-card judgment call. Every card carries three label axes — priority,
type, and effort (e.g. P0–P2, feature/chore/bug/research, S/M/L) — because a card missing any of
the three can't be scheduled: the axes are what a queue is ordered by, not decoration. Trackers
without native dependency links need a written convention (e.g. `Depends-on: #<id>` in the
description) plus a mechanical check that only proposes or starts a card once all of its
dependencies are Done.

When a queue spans categories of work that trade off against each other (e.g. process/tooling
infrastructure vs. product features), state the category priority explicitly and apply it when
composing a batch — not case by case. Pick a rule (such as "drain the higher-priority category
before starting the other") and treat it as dynamic: a new higher-priority card joins the queue
and still goes first, even after the queue looked drained. A hard deadline on a specific card (a
service being retired, an expiring window) overrides the category order for that card alone —
name the deadline explicitly or it doesn't count. This is a policy each team sets for itself, not
a universal ordering.

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

Archive Done cards; never hard-delete them. A closed card is the durable record of how the work
actually went — a thin pointer note is not a substitute — so deleting it destroys that history.

If the tracker is unreachable, buffer task state in a local file under a dated "unsynced" section,
then fold it back into the board on the next session that can reach it — verifying each entry
landed before purging the buffer.
