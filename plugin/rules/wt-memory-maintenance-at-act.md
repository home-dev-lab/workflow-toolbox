# Memory maintenance — at act

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
