This reference belongs to the delegation-chain skill. Its text moved here verbatim from that skill's SKILL.md, so every path and link in it means what it meant there: a link to another reference file resolves from the skill directory (the parent of this references/ folder), and a project or repository path keeps its own base.

## 4. Watchers and guards this plugin ships — and what each one does NOT see

Every entry below is real, shipped tooling — not a description of an intended design. Read the
"does NOT cover" column with the same weight as the "watches" column: a watcher's silence is
only informative within the scope it actually covers.

| Tool | Watches | Does NOT cover |
|---|---|---|
| `wt-skill-size-guard-hook.mjs` (PreToolUse on `Skill`, warn-only probation) | main-session invocations whose resolved `SKILL.md` exceeds 8000 characters (`WT_SKILL_SIZE_WARN_CHARS` overrides); names repeated compaction cost and `Read`/delegate alternatives | sub-agent calls, unresolved or custom-layout skills, supplementary references, token counts; internal errors fail open |
| the arc watcher (`--project`, `--reports`, `--stale`, `--poll`) | transcript/journal staleness against recorded spawns, correlating by identifier first and declared name as fallback | a spawn record with neither an identifier nor a name; an unrecognized flag now fails LOUD (non-zero exit, one line naming the flag, written to stdout — not stderr, so redirecting stderr away still shows it, but merging streams the other way loses it) rather than silently starting degraded |
| the liveness file (three-tier `agentId` cascade — Section 1) | idle-mid-mission vs. genuinely finished, per delegate, via `waitingOn`/`complete` fields the delegate itself updates | it is OPTIONAL coverage a short ordinary run can skip entirely, and nothing forces a delegate to keep it current — a file left at `waitingOn:"spawner"` after the answer already arrived misleads a reader exactly as much as one genuinely stuck there |
| the observer-pairing checker (`wt-check-observer-pairing.mjs`), fired automatically after every `Agent` spawn by a `PostToolUse` guard hook | whether a spawned agent's declared observer actually attached, keyed primarily on a harness-written ownership link between the two agents' own metadata, falling back to a declared `--name` | its fallback path requires a `--name` — an ANONYMOUS delegate (the exact shape a lane-delegating one must use, per Section 1) is unverifiable through the fallback; only the metadata-link path covers it |
| the lane probe (`--worktree`, repeatable; `--pattern`; `--archive`) | whether a named executor-lane process is CURRENTLY working inside a given worktree, resolved live from the OS process table, never by asking the delegate | one invocation is a single snapshot — a lane can start or stop between two sweeps unseen; a probe result MUST be archived to survive past the process it describes, or nothing later can distinguish "verified" from "claimed" |
| the card/pilot reconciler (`--cards`, `--session`, `--tolerance-min`) | cards claimed on the tracker vs. delegates actually alive in the spawn registry, matched by the card id appearing inside a spawn's own recorded purpose string | a brief that never names its card id anywhere in the spawn description is invisible to this match — the reconciler cannot discover a link the spawn itself never recorded |
| `Monitor` (deadlined, no ongoing model cost) | a named condition on files/state, fired as a discrete event | must be armed explicitly, by something that is already awake, before it exists at all — an unarmed watcher and a healthy silent one are indistinguishable from outside; arming it is not implied by anything in this document. It also EXPIRES: at most 30 minutes (10 in a `-p` run), with a notice to re-arm, so a watch expected to outlive that is a watch someone must renew — and a renewal nobody performs leaves exactly the indistinguishable silence this row warns about. Work that must be watched for longer belongs in a manifest-declared monitor, which the harness starts every session, or in a durable record. ⚠ An expiry that carried NO events is worth re-reading the filter for: a watch that never fired and a watch pointed at the wrong thing produce the same nothing |
| the idle-detection hook (fires on the harness's own teammate-idle event) | when one of the SESSION'S OWN first-level teammates goes idle | it covers first-level teammates only — a pilot's own sub-agent (a grandchild of the session that ultimately cares) is structurally invisible to it, however long it sits idle; coverage of deeper levels has to come from the intermediate agent's own contract (a hard cap, its own watcher), never from this hook |

### The composite reading

None of the tools above is a substitute for another — the arc watcher answers "is this
transcript stale", the lane probe answers "is a lane process live in this worktree right now",
the reconciler answers "does a claimed card have a living delegate behind it", and the liveness
file answers "does this specific delegate say it's mid-mission or done". A delegate can pass
every one of these checks individually and still be a delegate nobody is actually watching, if
the registry documenting which of these are ARMED for it is itself absent — that registry is
project- and machine-specific by nature (which watchers exist, on what schedule, for which
delegates) and does not belong in this document; consult whatever your environment brief names
as its watcher registry, and if none is named, treat coverage as UNKNOWN rather than assuming
either "watched" or "unwatched" from silence.
