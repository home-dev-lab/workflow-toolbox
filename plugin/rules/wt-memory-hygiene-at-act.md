# Memory hygiene — at act

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
