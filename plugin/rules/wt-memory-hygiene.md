# Memory hygiene — keep the index light, the bodies rich, and rules pure

If you keep a persistent memory or notes store — an auto-loaded index plus individual fact
files it points to — these disciplines keep it usable indefinitely instead of degrading into
either bloat or silent loss.

- **Keep the index line short — one line per fact, hook only.** Detail (dates, decisions,
  rationale) lives in the fact's own body, never restated in the index line. The index is what
  loads automatically every session; its cost is lines × length, so this is the one place to
  keep lean.
- **Never shrink a fact's body to save space.** Only the index is auto-loaded, so the body's
  size is not the cost that matters — a fresh session must be able to stand on the body alone.
  Shrink the index by archiving stale facts and keeping hooks short, never by gutting bodies.
- **Archive closed items by moving them, never by deleting.** When a tracked piece of work is
  finished and has no active follow-up, move its note out of the live index into an archive
  location and drop its index line — inbound references still resolve there on demand. Move,
  don't delete: deleting destroys the only record.
- **Writes are concurrency-unsafe by default — treat the store as shared.** Re-read the target
  file immediately before editing it, and apply a line-level or file-level delta rather than
  overwriting from a stale in-context copy, whenever more than one session could touch the same
  store.
- **Route a behavior-changing correction to a RULE, in the same pass as recording it.** A fact
  parked only in a note body may never be reloaded, because only the index line is auto-loaded
  and the body is recall-on-demand — a correction that should change behavior every session
  belongs in whatever mechanism your setup auto-loads (a rule, a standing instruction), written
  at the same time the fact is recorded, not left for a later pass to maybe promote. Facts,
  gotchas, and references are fine to leave recall-on-demand; a procedure with a crisp, reliable
  trigger is a candidate for a skill or macro instead — description-matching activation is
  probabilistic and unfit for a correction that must always apply.
- **A rule is a pure directive.** State the operative principle and the invariant that makes it
  right — no experiential narrative, no incident stories, no dated change banners. Rationale and
  field cases belong in a note, referenced by a short pointer; when a rule's guidance changes,
  rewrite the rule in place rather than stacking a chronicle on top of it.
- **An unindexed fact does not exist.** Periodically verify the pairing mechanically: every fact
  file on disk has a matching index line, and every index line resolves to a file that exists. A
  deliberate de-indexing — a retraction kept only so old references still resolve — is fine and
  should read as intentional; anything else is an orphan to index, merge, or archive.
- **One lesson, one operative home — and record the deliberate omissions.** When several facts
  could describe the same lesson, keep exactly one as the operative copy and have the others
  point at it. When you decide not to add a fact because the lesson is already covered
  elsewhere, say so and where — otherwise a later pass rediscovers the lesson with no obvious
  home and creates a second copy that quietly drifts from the first.
- **Promoting a note into an auto-loaded rule has two constraints.** First, a rule meant to
  apply broadly must stay free of narrow specifics (paths, names, one-off tokens) that only make
  sense in a single project or setup — those stay local, in a project-scoped file the broad rule
  can point to. Second, an auto-loaded rule only fires where it's actually loaded — after
  promoting, make sure it reaches every scope it's meant to cover instead of assuming one copy
  covers all of them. If your setup keeps more than one configuration directory (for example,
  separate personal and work profiles), a rule written into one does not propagate to the
  others by itself — copy or link it into every directory it should govern, and treat "the rule
  is written" and "the rule is in force everywhere it should be" as two separate facts to
  verify, not one. Leave the source note in place afterward as rationale, pointing at the
  rule as the operative version.

This keeps the index small and the store honest regardless of how often a dedicated
consolidation pass runs.
