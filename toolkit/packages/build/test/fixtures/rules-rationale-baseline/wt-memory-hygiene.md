# Memory hygiene — keep the index light, the bodies rich, and rules pure

Persistent memory store — auto-loaded index + fact files it points to → these disciplines keep it
usable indefinitely, not bloating or silently losing facts.

- **Index line short — hook only.** Detail (dates, decisions, rationale) lives in the fact's
  body, never restated in the index line — index auto-loads every session, the one place to stay
  lean.
  ⚠ **One line per fact = FLAT-index shape, not universal.** Once a hub layer exists (below), a
  new fact's pointer goes wherever the placement test sends it — direct line, or a member line in
  a hub body. **Apply the test on EVERY write, not only during reorganisation**: treating
  direct-line as default rebuilds the flat index one fact at a time, silently undoing the hub
  layer while the store still looks organised.
  ⚠ **Under hubs, budget = LINE COUNT, not per-line width.** Width's a fair proxy for total size
  while flat; INVERTS under hubs — richer hooks on fewer lines = smaller index, not bigger.
  Measure what the harness actually truncates.
- **Never shrink a body to save space.** Only the index auto-loads — body size isn't the cost
  that matters, a fresh session must stand on the body alone. Shrink by archiving stale facts,
  short hooks — never gutting bodies.
- **⚠ Index has a CEILING, crossing it is SILENT.** Auto-loaded index truncated past a
  harness-set limit, no error: entries past the cut don't degrade/warn/visibly truncate — simply
  stop existing for every session loading it. Neither file nor session tells. Measured in one
  mature store: **217 entry lines**, roughly **17 tail entries** already invisible for an unknown
  period — found only because a hook warned on an unrelated write. **Failure has no symptom** —
  recall quietly worsens, nothing to investigate. Treat ceiling-approach as a defect, not
  untidiness — measure, don't estimate: a probe counting entries AND checking every disk fact
  still reachable makes it loud. (Exact limit = observation not documented — state the threshold
  applied.)
  ⚠ **Usually TWO independent ceilings — a healthy reading on one HIDES the other.** One bounds
  ENTRIES surviving truncation; another bounds total SIZE past which the file stops reading in
  full. Move OPPOSITE directions once a hub layer exists: hubs cut entry count while richening
  each surviving hook — a store sits under the entry ceiling, close to the size ceiling, at once.
  A probe measuring only one reports "fine" in that state — measure both, print both, name which
  limit each number compares against.
- **Archiving alone can't hold the ceiling — add an intermediate HUB layer.** Archiving scoped to
  closed work; in a mature store almost nothing qualifies: classified mechanically, one
  **218-entry** store held **92** reference facts, **91** feedback facts, **4** about the user,
  **3** archivable project notes. A rule whose only lever reaches 3 of 218 doesn't scale. Missing
  lever: group entries into thematic hub notes listing members as `- [[slug]] — <hook>`; index
  carries one line per hub plus entries staying directly visible. Recall costs one extra hop for
  the hub-fronted majority; index gains headroom without bound. **Hub layer is ADDITIVE** — no
  fact moved/edited/deleted, nothing unreachable. Keep archiving for closed work; stop treating
  it as the scaling mechanism.
- **The promotion test is the whole difficulty — over-compressing loses the ability to NOTICE.**
  An index reduced to hub names no longer tells a session a fact EXISTS — most of what an index
  is for. Criterion: *would a session need this fact on a turn not yet knowing the subject's
  involved?* User facts, standing behavioural instructions, know-before-you-act cautions earn a
  direct line; a topic gotcha looked up while already on-topic → a hub. ⚠ **Target = headroom,
  not minimalism** — one implementation over-compressed to hubs first pass, needed rebalancing.
  Name the count aimed for, leave room to grow.
- **A hub has a size past which it stops routing — split it.** Too many members = a second flat
  index one hop down: relocates the ceiling, doesn't remove it. Tooling carries the actual number
  (a threshold executing beats one to remember); shipped probe warns past roughly **45 members**.
  Crosses it → split along a real distinction between members, never in half by position —
  predicts nothing.
- **Hub declares member count → bump it in the SAME edit as the member.** Declared count = the
  only cross-check a store has against ITSELF: reachability answers "does every fact have a
  path", declared count answers "does this hub still describe its contents" — fail differently.
  Optional — a no-counts store isn't defective, gets no cross-check, silence = not measured,
  never verified — a stale declared count is worse than none: reads verified.
- **A RETRACTION declares itself in one shape, or no check finds it.** A note kept only so old
  references resolve has one job: lead reader from old name to current truth. A retraction whose
  forward pointer doesn't resolve fails that job, nothing says so. Measured across two
  independent stores before writing this: **34 texts** carried a retraction word, only **8**
  whole-note. Rest: section-level retractions inside live notes, incidental prose ("closed as
  superseded"), index mentions. Two languages, one with no English keyword at all; three
  locations; targets sometimes a file path, a ticket id, a prose mechanism. **A detector built on
  any one shape covers half the real cases, reports clean** — convention must exist before the
  check means anything.
  Shape: blockquote atop the retracted note, carrying keyword, date, target. ⚠ **Distinguish
  NOTE from SECTION retraction** — different objects, not two intensities of one; conflate →
  check fires on live notes. Accept a link, a path, OR plain description as target: content
  sometimes moves somewhere not a note, forcing a link would make a false one.
  ⚠ Check only covers retractions written AFTER convention adopted. Pre-existing ones visible
  only if rewritten — content work; saying so stops a clean run reading as coverage.

- **Archive closed items by moving, never deleting.** Work finished, no active follow-up → move
  its note out of the live index into archive, drop pointer — inbound refs still resolve on
  demand. Move, don't delete: deleting destroys the only record.
  ⚠ **Drop the pointer from wherever it LIVES**, usually not the index under a hub layer: a
  direct index line, OR a member line in a hub body. Trap: a targeted index deletion **succeeds
  while deleting nothing** — archived note stays listed in its hub, pointing at a moved file.
  Locate the pointer, delete it, re-run the reachability check below.
- **Writes are concurrency-unsafe by default — treat the store as shared.** Re-read the target
  file before editing, apply a line/file-level delta rather than overwrite a stale copy, whenever
  >1 session could touch the store.
- **Route a behavior-changing correction to a RULE, same pass as recording it.** A fact parked
  only in a note body may never reload — only the index line auto-loads, body's recall-on-demand.
  A correction changing behavior every session belongs in whatever the setup auto-loads (rule,
  standing instruction), written when recorded, not left for a later maybe-promote.
  Facts/gotchas/references: fine recall-on-demand; a crisp-trigger procedure = a skill/macro
  candidate instead — description-matching is probabilistic, unfit for an always-apply
  correction.
- **A rule is a pure directive.** State the operative principle and invariant making it right —
  no narrative, incident stories, dated banners. Rationale/field cases → a note, short pointer;
  guidance changes → rewrite the rule in place, don't stack a chronicle.
- **An UNREACHABLE fact doesn't exist.** Periodically verify pairing mechanically, both
  directions: every disk fact file REACHABLE from the index; every index/hub reference resolves
  to an existing file. A deliberate de-indexing — a retraction kept only so old references
  resolve — fine, reads intentional; else an orphan to place, merge, or archive.
  ⚠ **Reachable, not "has an index line".** Once a hub layer exists, most facts deliberately have
  no index line of their own — a one-line-per-file check reports the CORRECT state as broken, a
  trusting reader "repairs" the store by restoring exactly the flat index the hub layer existed
  to escape. Follow the hop: reachable if the index names it, or a note it names lists it.
  ⚠ **The count isn't the check.** A shrinking index is only good news if nothing fell out —
  losing a fact produces precisely the number aimed for. Assert both emptiness conditions —
  nothing unreachable, nothing dangling — never the total.
- **One lesson, one operative home — record deliberate omissions.** Several facts describe one
  lesson → keep exactly one operative, others point at it. Not adding a fact because covered
  elsewhere → say so, and where — else a later pass rediscovers it with no home, creates a
  drifting second copy.
- **Promoting a note into an auto-loaded rule has two constraints.** First: a broad rule stays
  free of narrow specifics (paths, names, tokens) making sense only in one project/setup — those
  stay local, in a project-scoped file the broad rule points to. Second: an auto-loaded rule
  fires only where loaded — after promoting, confirm it reaches every scope meant, don't assume
  one copy covers all. >1 config dir (personal/work) → a rule written into one doesn't propagate
  to others by itself — copy/link into every directory it should govern; "written" and "in force
  everywhere" are two separate facts to verify. A corrected rule doesn't refresh an
  already-running context — but IS reloaded whenever REBUILT: a restart **and** a compaction. A
  session that wrote the change can't verify obeying it until one occurs; "needs a fresh session"
  too strong. ⚠ Scope carefully: covers rule/instruction TEXT. Whether the agent-definition list
  refreshes on the same event is separate — treat session-start-only until measured, since a
  newly-written agent type's been observed unspawnable in the session that created it. Must take
  effect immediately → state so in conversation, don't rely on the file edit alone. Leave the
  source note as rationale, pointing at the rule as operative.

Keeps the index small, the store honest, regardless of pass frequency.
