# Task tracking — the tracker is the task source of truth (tasks ≠ knowledge) — at act

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

Archive Done cards; never hard-delete. Closed card is durable record of how work went — thin
pointer note isn't a substitute — deleting it destroys that history.

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

Reversals reconcile at removal time. Recording "X was removed" in ONE place leaves every other
card, note still presenting X as live. Removal/rename card must name its blast radius (items
referencing retired concept), sweep them: fix open ones, add "superseded by #<id>" pointer to
closed ones without rewriting their history.
