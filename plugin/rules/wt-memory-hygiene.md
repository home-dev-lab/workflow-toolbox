# Memory hygiene — keep the index light, the bodies rich, and rules pure

If you keep a persistent memory or notes store — an auto-loaded index plus individual fact
files it points to — these disciplines keep it usable indefinitely instead of degrading into
either bloat or silent loss.

- **Keep the index line short — hook only.** Detail (dates, decisions, rationale) lives in the
  fact's own body, never restated in the index line. The index is what loads automatically every
  session, so this is the one place to keep lean.
  ⚠ **One line per fact is the FLAT-index shape, not a universal one.** Once a hub layer exists
  (see below), a new fact's pointer goes wherever the placement test sends it — a direct line, or a
  member line inside a hub body. **Apply that test on EVERY write, not only during a
  reorganisation**: treating the direct line as the default rebuilds the flat index one fact at a
  time, silently undoing the hub layer while the store still looks organised.
  ⚠ **Under hubs, the budget is the LINE COUNT, not per-line width.** Width is a fair proxy for
  total size while the index is flat; it INVERTS under hubs, because richer hooks on far fewer lines
  make a smaller index, not a bigger one. Measure what the harness actually truncates.
- **Never shrink a fact's body to save space.** Only the index is auto-loaded, so the body's
  size is not the cost that matters — a fresh session must be able to stand on the body alone.
  Shrink the index by archiving stale facts and keeping hooks short, never by gutting bodies.
- **⚠ The index has a CEILING, and crossing it is SILENT.** An auto-loaded index is truncated
  past a limit the harness sets, with no error: entries past the cut do not degrade, warn, or
  visibly truncate — they simply stop existing for every session that loads it. Neither the file
  nor the session can tell. Measured in one mature store: 217 entry lines, so roughly 17 tail
  entries had already been invisible for an unknown period, found only because a hook happened to
  warn on an unrelated write. **This failure has no symptom** — recall quietly gets worse with no
  event to investigate. Treat approaching the ceiling as a defect, not untidiness, and measure it
  rather than estimating: a probe that counts entry lines AND checks every fact on disk is still
  reachable makes it loud. (The exact limit is an observation, not a documented number — state
  which threshold you applied whenever you report on it.)
- **Archiving alone cannot hold the ceiling — add an intermediate HUB layer.** Archiving is
  scoped to closed work, and in a mature store almost nothing qualifies: classified mechanically,
  one 218-entry store held 92 reference facts, 91 feedback facts, 4 about the user, and **3**
  archivable project notes. A rule whose only lever reaches 3 entries out of 218 does not scale.
  The missing lever: group entries into thematic hub notes whose bodies list their members as
  `- [[slug]] — <hook>`; the index then carries one line per hub plus the entries that must stay
  directly visible. Recall costs one extra hop for the hub-fronted majority; the index gains
  headroom without bound. **The hub layer is ADDITIVE** — no fact is moved, edited, or deleted,
  so nothing becomes unreachable. Keep archiving for closed project work; just stop treating it
  as the scaling mechanism.
- **The promotion test is the whole difficulty — over-compressing loses the ability to NOTICE.**
  An index reduced to a list of hub names no longer tells a session that a fact EXISTS, which is
  most of what an index is for. The operative criterion: *would a session need this fact on a turn
  where it does not yet know the subject is involved?* Facts about the user, standing behavioural
  instructions, and know-before-you-act cautions earn a direct line; a topic-bound gotcha someone
  looks up while already on the topic belongs in a hub. ⚠ **The target is headroom, not
  minimalism** — one implementation over-compressed to hubs only on its first pass and had to be
  rebalanced. Name the count you are aiming for, and leave room to grow into.
- **A hub has a size past which it stops routing — split it.** A hub with too many members is a
  second flat index one hop down: it relocates the ceiling instead of removing it. Tooling that
  measures this should carry the actual number (a threshold that executes beats one that must be
  remembered), and the shipped probe here warns past roughly **45 members**; the discipline the
  number serves is what belongs in this rule. When a hub crosses it, split it along a real
  distinction between its members — never in half by position, which produces two hubs neither of
  whose names predicts what is inside.
- **If a hub declares how many members it has, bump that count in the SAME edit as the member.**
  A declared count is the only cross-check a store has against ITSELF: reachability answers "does
  every fact have a path", the declared count answers "does this hub still describe what it
  actually contains", and they fail differently. The convention is optional — a store that
  declares no counts is not defective and nothing should report it as such; it also gets no
  cross-check, and that silence means not measured, never verified — but a count that is declared
  and stale is worse than none, because it reads as verified.
- **A RETRACTION declares itself in one shape, or no check can ever find it.** A note kept only so
  old references still resolve has exactly one job: lead a reader from the old name to the current
  truth. A retraction whose forward pointer does not resolve fails that job completely, and nothing
  says so.
  Measured across two independent stores before writing this: 34 texts carried a retraction word,
  and only 8 were whole-note retractions. The rest were section-level retractions inside live notes,
  incidental prose ("closed as superseded"), and index mentions. Two languages, one of them with no
  English keyword at all; three locations; and targets that were sometimes a file path, sometimes a
  ticket id, sometimes a mechanism described in prose. **A detector built on any one of those shapes
  would have covered half the real cases and reported clean** — so the convention has to exist
  before the check can mean anything.
  The shape: a blockquote at the top of the retracted note, carrying the keyword, the date, and the
  target. ⚠ **Distinguish a NOTE retraction from a SECTION retraction** — they are different objects,
  not two intensities of one, and conflating them makes a check fire on live notes. And accept a
  target that is a link, a path, OR a plain description: content sometimes moves somewhere that is
  not a note, and forcing a link would make people write a false one.
  ⚠ A check can only cover retractions written AFTER the convention is adopted. Pre-existing ones
  become visible only if someone rewrites them — that is content work, and saying so is what stops
  a clean run from reading as coverage.

- **Archive closed items by moving them, never by deleting.** When a tracked piece of work is
  finished and has no active follow-up, move its note out of the live index into an archive
  location and drop its pointer — inbound references still resolve there on demand. Move,
  don't delete: deleting destroys the only record.
  ⚠ **Drop the pointer from wherever it LIVES**, which under a hub layer is usually not the index:
  a direct index line, OR a member line inside a hub body. The trap is that a targeted deletion
  aimed at the index **succeeds while deleting nothing** — the archived note stays listed in its
  hub, now pointing at a file that has moved. Locate the pointer first, then delete that exact
  line, then re-run the reachability check below.
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
- **An UNREACHABLE fact does not exist.** Periodically verify the pairing mechanically, in both
  directions: every fact file on disk is REACHABLE from the index, and every reference the index
  and its hubs contain resolves to a file that exists. A deliberate de-indexing — a retraction kept
  only so old references still resolve — is fine and should read as intentional; anything else is
  an orphan to place, merge, or archive.
  ⚠ **Reachable, not "has an index line".** Once a hub layer exists, most facts deliberately have
  no index line of their own — a check written as one-line-per-file then reports the CORRECT state
  as broken, and a reader who trusts it "repairs" the store by restoring exactly the flat index the
  hub layer existed to escape. Follow the hop: a fact is reachable if the index names it, or if a
  note the index names lists it.
  ⚠ **The count is not the check.** A shrinking index is only good news if nothing fell out of it,
  and losing a fact produces precisely the number you were aiming for. Assert the two emptiness
  conditions — nothing unreachable, nothing dangling — never the total alone.
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
