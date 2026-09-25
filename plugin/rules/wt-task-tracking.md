# Task tracking — the tracker is the task source of truth (tasks ≠ knowledge)

Keep two stores distinct. TASKS (status, priority, full chronological history) live in task
tracker — card/ticket description = lean essentials, comments = rich detail. KNOWLEDGE (reusable
facts, decisions, gotchas, runbooks, preferences) lives in memory/notes, not on board. Project
pointer note too? Make it thin pointer to card, not parallel narrative — write narrative to CARD
(one consolidated, deduped comment), preserve human-authored comments.

Managed board keeps small fixed set of lists for lifecycle stages (e.g. Backlog, Next, In
Progress, Blocked, Done, plus catch-all for descoped work) so "what's open" is mechanical query,
not per-card judgment call. Every card carries three label axes — priority, type, effort (e.g.
P0–P2, feature/chore/bug/research, S/M/L) — card missing any of three can't be scheduled: axes
are what queue is ordered by, not decoration. Trackers without native dependency links need
written convention (e.g. `Depends-on: #<id>` in description) plus mechanical check that only
proposes or starts a card once all dependencies Done.

That check covers one direction only: not starting too early. Says nothing about moment
dependency closes — nothing moves dependent out of Blocked on its own, card can sit there fully
unblocked, unnoticed. Closing a card sweeps cards naming it in a `Depends-on:` line, releases
ones with no remaining blocker — same discipline removal sweep below applies to retired concept,
applied here to satisfied dependency. Periodic sweep over whole Blocked list runs identical
check without waiting for closure to trigger it: resolve each blocked card's dependency ids,
read their list — deterministic check, not judgment call.

Sweep's output is candidate list, never verdict. Card can be legitimately blocked on something
no `Depends-on:` line expresses — external gate, locked credential, decision only a human can
make — so releasing every candidate on mechanical signal alone is wrong; read each one before
releasing. And card with no `Depends-on:` line at all isn't evidence of nothing to report: it's
sweep's largest blind spot, blocker lives in prose no check can confirm or refute — reporting
only parseable cards while staying silent about the rest reads as full coverage when it's not.

Queue spans categories trading off against each other (e.g. process/tooling infrastructure vs.
product features)? State category priority explicitly, apply it when composing a batch — not
case by case. Pick rule (e.g. "drain higher-priority category before starting the other"), treat
it as dynamic: new higher-priority card joins queue, still goes first, even after queue looked
drained. Hard deadline on specific card (service being retired, expiring window) overrides
category order for that card alone — name deadline explicitly or it doesn't count. Policy each
team sets for itself, not universal ordering.

The act-bound half of this rule is served on demand as `wt-task-tracking-at-act.md`.
