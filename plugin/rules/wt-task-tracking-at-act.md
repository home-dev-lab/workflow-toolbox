# Task tracking — the tracker is the task source of truth (tasks ≠ knowledge) — at act

Managed board keeps small fixed set of lists for lifecycle stages (e.g. Backlog, Next, In
Progress, Blocked, Done, plus catch-all for descoped work) so "what's open" is mechanical query,
not per-card judgment call. Every card carries three label axes — priority, type, effort (e.g.
P0–P2, feature/chore/bug/research, S/M/L) — card missing any of three can't be scheduled: axes
are what queue is ordered by, not decoration. Trackers without native dependency links need
written convention (e.g. `Depends-on: #<id>` in description) plus mechanical check that only
proposes or starts a card once all dependencies Done.

Card quality: concise action-oriented plain-text title; substance in description, overflow in comments.

⚠ **CLOSING a card updates its DESCRIPTION, not only a comment.** Humans/tools see description
BY DEFAULT; comments one call away. Comment-only outcome leaves STALE pre-work claim at first
read, misleading even careful convention-followers. Disproved description claim → mark refuted,
pointer to truth; never silently delete.

⚠ EXPENSIVE failure: under-reports completion. Open-list reader: almost nothing remains;
Done-description reader: almost nothing finished — same board, opposite wrong answers.

⚠ ANY machine-read field convention (e.g. dependency line, status block) is parsed from DESCRIPTION; comment looks recorded,
invisible to tooling.

New history overlaps bot comment → merge/dedupe into one; never duplicate same content.

Archive Done, never hard-delete: closed card = durable work history, thin pointer no substitute;
deletion destroys history.

The dependency-start check covers one direction only: not starting early; dependency closure
moves nothing from Blocked automatically → fully unblocked cards unnoticed. Closing card →
sweep cards naming it in `Depends-on:`, release those without remaining blockers (removal sweep
below applied to satisfied dependency). Periodically sweep whole Blocked list, without waiting
for closure: resolve each dependency id, read list — same deterministic check, not judgment.

Sweep = candidates, never verdict. Legitimate blockers beyond `Depends-on:` (external gate,
locked credential, human-only decision) → read each before release, never mechanical signal
alone. No `Depends-on:` ≠ nothing to report: largest blind spot, prose blockers no check
confirms/refutes. Only parseable cards reported, rest silent → false full coverage.

Reconcile reversals at removal time: one "X was removed" leaves other cards/notes calling X live.
Removal/rename card names blast radius (retired-concept references), sweeps: fix open items;
"superseded by #<id>" pointer on closed, no history rewrite.
