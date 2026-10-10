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

In a main session, consult a large reference skill with `Read` on the needed section of its
`SKILL.md`, or delegate the work to a sub-agent: the harness re-injects every invoked skill's
body after each compaction.

## 1. The downward chain — how a delegate is spawned, and what each shape costs

Open [references/downward-chain.md](references/downward-chain.md) before choosing a spawn shape or correlating a delegate identity.

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
| A `Monitor` event (deadlined, zero ongoing model cost) | yes, for whoever is holding it | measured to re-invoke an idle session in the low tens of seconds after firing, with no user input; it must be armed by something already awake before it can fire, and every watch now EXPIRES — at most 30 minutes, 10 in a single-prompt `-p` run — with a notice telling the session to re-arm |
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

### Two things that reroute or hide the whole chain above

- **The user can talk directly to an in-flight delegate — a side channel invisible to whoever
  spawned it.** A message sent to a delegate mid-turn arrives exactly like an ordinary next
  instruction, and nothing about it distinguishes "the user" from "the spawner" from the
  delegate's own side. The spawner sees only the delegate's OUTPUTS (its results, its task
  notifications) — never its INPUTS. A delegate that seems to reopen a closed topic, change
  direction, or "disobey" a brief may simply be obeying six direct messages from the user that
  the spawner has no visibility into at all. Before diagnosing a delegate's behaviour as drift
  or disobedience from its outputs alone, read its own transcript for incoming messages — the
  correct diagnosis can be the opposite of what the outputs alone suggest.
- **`Workflow` is reachable ONLY by the main loop — never by a typed subagent, and only
  partially by an in-loop fork.** A typed subagent (even one with an unrestricted `tools: *`)
  does not have `Workflow` in its tool surface at all — it is absent from `ToolSearch` too, and
  an explicit `tools: Workflow` grant in a custom agent definition is silently IGNORED. Team
  membership strips `Workflow` even from an in-loop fork that would otherwise inherit it. A
  fork with no team CAN launch a run — it clones the full main-loop tool surface — but it
  never receives the completion notification: that routes to the PARENT session regardless of
  who launched the run. So the only entity that both launches and follows a `Workflow` run to
  completion is the main session itself; do not grant the tool to a subagent expecting it to
  work, and do not expect a fork's own launch to be the thing that wakes it back up.

### What this section does NOT cover

- Whether an `idle_notification`'s `idleReason` enumeration has grown additional values since
  last measured — treat the three named values as what has been observed, not a documented
  contract.

## 4. Watchers and guards this plugin ships — and what each one does NOT see

Open [references/watchers-and-guards.md](references/watchers-and-guards.md) before arming a watcher or inferring coverage from its silence.

## Composes with

The pilot and orchestrator agent definitions carry the operative, load-bearing text this
document explains (the liveness file schema, the escalation contract, the file-report
discipline) — this skill is the map across them, not a replacement for reading the definition
that actually governs a given arc.
