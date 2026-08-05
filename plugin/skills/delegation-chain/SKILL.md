---
name: delegation-chain
user-invocable: false
description: >-
  Load this BEFORE spawning a delegate, arming a watcher, or reasoning about what wakes a
  session. Consolidates the downward spawn chain (anonymous/named/isolated, and what each shape
  costs an observer or a worktree), the upward report chain (what actually reaches a spawner and
  what silently doesn't), who wakes whom (and what wakes nothing), and the watchers/guards this
  plugin ships with an explicit "does NOT cover" column for each. Not a task to run — a reference
  to consult before a delegation decision, so the same question isn't re-answered from scratch
  every time.
---

# delegation-chain — the full shape of a delegation, one document instead of five

This exists because the mechanism it documents is genuinely non-obvious, undocumented by the
harness itself, and easy to get wrong in a way that LOOKS successful. Getting any one part
wrong — the spawn shape, the report channel, the wake signal, or what a watcher actually sees —
produces a delegate that runs, writes something, and reports "done", while the work is lost, the
observer never attached, or nothing was ever watching in the first place. None of those failures
throw an error. They all look like success from one level up.

Read the section you need; the four sections compose into one loop (spawn → work → report →
wake), and the table at the end names which of the shipped watchers covers which part of it.

## 1. The downward chain — how a delegate is spawned, and what each shape costs

| Spawn shape | Named? | Observer attaches? | Worktree-cleaner risk | Good for |
|---|---|---|---|---|
| anonymous (no `name`) | no | yes | none (no dedicated worktree unless the delegate makes its own) | a delegate that hands its writes to an external executor lane |
| `name` **+** `isolation` | yes | yes | none | any delegate that must be addressable by name AND does not delegate its writes elsewhere |
| `name` alone (no `isolation`) | yes | **no — dropped silently** | n/a | avoid |
| installed via a PLUGIN (a namespaced type) | — | **no — pairing skipped silently, no warning** | n/a | never, if the observer matters — adopt an editable project copy instead |

Two mechanisms explain the middle two rows, and both are read from the harness, not guessed:

- **A named spawn with no `isolation`, once the session already has a team context, is routed
  down an in-process-teammate path that REBUILDS the agent definition instead of using it**: the
  observer pairing is never read, and a permission-mode fence the definition declared can be
  overwritten too. The condition is invisible at the moment you spawn — the identical call keeps
  everything intact in a headless run and silently drops it in an interactive one — so don't
  reason about whether it currently holds; treat the row as true unconditionally. `isolation`
  keeps the spawn on the normal path, which is why pairing `name` with `isolation` is safe again.
- **An isolated worktree is auto-cleaned when it is UNCHANGED at the moment the delegate goes
  idle.** A delegate that routes its implementation to an external executor lane has a
  ZERO-DIFF tree by construction at exactly that moment: its own writes are zero, the lane's
  writes have not landed yet. The reaper can remove the tree — directory, branch, and git
  metadata — WHILE THE LANE IS STILL WRITING INTO IT. This is why a lane-delegating delegate
  cannot safely use `name` + `isolation` even though that combination is otherwise the safest
  named shape: it needs its OWN hand-created worktree (outside harness-managed isolation)
  instead, passed to it as a path in its brief.

**The consequence that follows from both rows together**: a delegate that delegates its own
writes to an external lane is anonymous **by construction**, not by preference — every named
alternative either drops its observer or gets its tree reaped mid-write. Do not read "spawn
anonymously" as a stylistic default; read it as the only shape left once the lane-delegation
requirement is factored in.

### The identity problem this creates, and how it is resolved

An anonymous delegate cannot read its own raw agent id (no environment variable carries it), and
it has no declared name to fall back on either — so it has no identity a watcher can correlate it
against, from either end.

The resolution is a **three-tier cascade**, evaluated by the delegate itself in this order:

1. **An explicit `LIVENESS_AGENT_ID: <raw id>` line**, sent by the spawner as an IMMEDIATE
   FOLLOW-UP `SendMessage` right after the spawn call returns — never embedded in the composed
   brief text, because the raw id does not exist until the spawn call has already gone out with
   whatever prompt was written. A spawner following this discipline sends the id as a first
   message; a delegate that reaches its own intake step without having seen this line checks its
   inbox for it before falling back to tier 2 — its absence from the initial prompt does not mean
   it was never sent, only that it has not arrived yet.
2. **The delegate's own declared spawn name**, if it has one.
3. **Neither.** The delegate is UNCORRELATABLE — an explicit, named state, never a silent gap.

Every watcher keyed on identity (the arc watcher, the liveness file, the observer-pairing
checker) degrades along this same cascade, and a spawner that skips step 1's follow-up message
silently loses the strongest tier for every anonymous delegate it spawns — not only the
lane-delegating ones; singling out one spawn shape for the follow-up is how the discipline gets
forgotten on the rest.

### What this section does NOT cover

- Whether a NESTED worktree a delegate creates on top of its own isolation, or on top of its
  hand-created lane worktree, is itself subject to the same reaping condition — unverified; the
  measurement that established the reaping trap only exercised a top-level isolated tree.
- Whether the identity cascade's tier 1 survives a spawner that itself gets compacted between
  the spawn call returning and the follow-up message being sent — not exercised.

## 2. The upward chain — what actually reaches the spawner, and what silently doesn't

- **A delegate's plain text reaches nobody.** The harness's own tool description says so
  directly: a turn that ends in prose, however complete and correct, has communicated nothing.
  Only `SendMessage` or a file write leaves the delegate's transcript.
- **A session holds ONE implicit team.** A named delegate's FINAL message is routed by that
  team, and it resolves to the session ROOT — not to whichever intermediate agent actually
  spawned it — unless the delegate was explicitly told the spawner's name or raw id and
  addresses that identity directly. A pilot spawning its own executor, or an orchestrator
  spawning a pilot, is exactly this case: the grandchild's unaddressed report lands with the
  top-level session, not the one that asked for it.
- **This is not a function of task size.** A two-minute mechanical chore misroutes exactly like
  a multi-hour arc; there is no size threshold under which addressing can be skipped.
- **The remedy is the file-report contract, and it has two parts that must BOTH hold**:
  1. The delegate writes its full output to a file at a path the brief names.
  2. Its FINAL message is exactly one line — the file path and a verdict — with **nothing
     after it**. Not a summary, not "I already delivered my answer above", not a remark about
     lacking a tool. The harness delivers only the delegate's LAST message; any trailing
     commentary about the channel itself — even one accurate sentence explaining why the
     report is above — replaces the report as the thing that actually arrives.
- **A sub-agent's `Write` call is hard-refused when the target basename STARTS WITH**
  `report`, `summary`, `findings`, or `analysis` (case-insensitive) — a harness-level check, not
  a project convention, and it only applies to sub-agents (the main loop is unaffected). The
  match is anchored at the start: `report-x.md` is refused, `x-report.md` succeeds. A brief that
  names a `report-<id>.md` path leaves a capable delegate unable to comply — put the word at the
  END of the basename.
- **A delegate whose TYPE lacks BOTH `Write` and `SendMessage` has no route back at all**, and
  no wording in its brief can fix that — verify a type's tool list before writing a
  report-dependent brief for it, not after it reports and the report never arrives.

### What this section does NOT cover

- A delegate that writes its report file correctly and then keeps working afterward (fixing an
  unrelated issue, re-publishing the same report) — the file's appearance is not the delegate's
  termination signal (see Section 3); a spawner that acts on the file the moment it appears can
  still collide with a delegate that has not actually finished.
- Whether `Edit` (as opposed to `Write`) is subject to the same basename refusal — not verified.

## 3. Who wakes whom — and what wakes nothing at all

| Signal | Wakes a dormant delegate? | Notes |
|---|---|---|
| An inbound `SendMessage` addressed to the delegate | **yes, reliably** | the only signal that is reliable in every case, including a delegate that already finished its own turn — addressing it resumes it from its transcript |
| A `Monitor` event (persistent, zero ongoing cost) | yes, for whoever is holding it | measured to re-invoke an idle session in the low tens of seconds after firing, with no user input; it must be armed by something already awake before it can fire |
| The delegate's OWN `run_in_background` task completing | **no, not reliably** | open harness limitation; the session ROOT is reliably re-invoked by its own background tasks completing, but a nested sub-agent is not re-invoked by its own — this asymmetry is the single most common cause of a silently-stalled delegate |
| A task-completion notification | reaches the session ROOT | not necessarily the immediate spawner, for the same one-implicit-team reason as Section 2 |
| An `idle_notification` | carries only `{type, from, timestamp, idleReason}` | tells you WHO went idle, never WHY or WHAT it produced — treat repeated empty idle pings as "go read the real state", never as content |
| A file appearing on disk | wakes nobody by itself | it is legible only to something already polling for it; and its appearance is not the delegate's finish signal (Section 2) |

### What wakes NOTHING — named explicitly, because each looks like it should

- **A delegate waiting on children IT spawned itself.** Nobody above it has a signal to arm,
  because those are ITS children, not the spawner's — the spawner has no handle on when they
  finish. A delegate that judges its own input too large, sub-delegates, and then ends its turn
  waiting for its own sub-agents' reports is now dormant with nothing positioned to wake it.
- **An external executor-lane process (an `opencode`/`codex` CLI call) is not tracked as the
  delegate's CHILD by the harness at all.** "I'll be resumed when my lane call finishes" is not
  merely unreliable — it is false: the harness can report the delegate as having no live
  background children of its own while the lane process is demonstrably still running under it.
  The correct pattern is to block IN-TURN on the lane call (a foreground call, or a bounded poll
  loop the delegate stays awake through, under an explicit hard cap) — never to background it and
  wait to be re-invoked.
- **Polling a display name for task completion.** A lookup keyed on an agent's display name (as
  opposed to addressing it with `SendMessage`) returns "not found" and proves nothing either way
  — it is not a wake mechanism and not a liveness check.

### What this section does NOT cover

- Whether an `idle_notification`'s `idleReason` enumeration has grown additional values since
  last measured — treat the three named values as what has been observed, not a documented
  contract.

## 4. Watchers and guards this plugin ships — and what each one does NOT see

Every entry below is real, shipped tooling — not a description of an intended design. Read the
"does NOT cover" column with the same weight as the "watches" column: a watcher's silence is
only informative within the scope it actually covers.

| Tool | Watches | Does NOT cover |
|---|---|---|
| the arc watcher (`--project`, `--reports`, `--stale`, `--poll`) | transcript/journal staleness against recorded spawns, correlating by identifier first and declared name as fallback | a spawn record with neither an identifier nor a name; an unrecognized flag now fails LOUD (non-zero exit, one stderr-style line naming the flag) rather than silently starting degraded — verify this against the running copy before trusting an older description of it, since exactly this behavior is a documented case of drifting between what was written down and what the code does |
| the liveness file (three-tier `agentId` cascade — Section 1) | idle-mid-mission vs. genuinely finished, per delegate, via `waitingOn`/`complete` fields the delegate itself updates | it is OPTIONAL coverage a short ordinary run can skip entirely, and nothing forces a delegate to keep it current — a file left at `waitingOn:"spawner"` after the answer already arrived misleads a reader exactly as much as one genuinely stuck there |
| the observer-pairing checker (`wt-check-observer-pairing.mjs`), fired automatically after every `Agent` spawn by a `PostToolUse` guard hook | whether a spawned agent's declared observer actually attached, keyed primarily on a harness-written ownership link between the two agents' own metadata, falling back to a declared `--name` | its fallback path requires a `--name` — an ANONYMOUS delegate (the exact shape a lane-delegating one must use, per Section 1) is unverifiable through the fallback; only the metadata-link path covers it |
| the lane probe (`--worktree`, repeatable; `--pattern`; `--archive`) | whether a named executor-lane process is CURRENTLY working inside a given worktree, resolved live from the OS process table, never by asking the delegate | one invocation is a single snapshot — a lane can start or stop between two sweeps unseen; a probe result MUST be archived to survive past the process it describes, or nothing later can distinguish "verified" from "claimed" |
| the card/pilot reconciler (`--cards`, `--session`, `--tolerance-min`) | cards claimed on the tracker vs. delegates actually alive in the spawn registry, matched by the card id appearing inside a spawn's own recorded purpose string | a brief that never names its card id anywhere in the spawn description is invisible to this match — the reconciler cannot discover a link the spawn itself never recorded |
| `Monitor` (persistent, no ongoing model cost) | a named condition on files/state, fired as a discrete event | must be armed explicitly, by something that is already awake, before it exists at all — an unarmed watcher and a healthy silent one are indistinguishable from outside; arming it is not implied by anything in this document |

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

## Composes with

The pilot and orchestrator agent definitions carry the operative, load-bearing text this
document explains (the liveness file schema, the escalation contract, the file-report
discipline) — this skill is the map across them, not a replacement for reading the definition
that actually governs a given arc.
