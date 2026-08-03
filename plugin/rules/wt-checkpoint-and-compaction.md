# Checkpoint and compaction — measure before acting, never stop when auto-compaction is on

Long-running sessions — a wave of delegated work, a multi-step dev loop — eventually hit the
context window's ceiling. Two disciplines keep that transition safe: measure the real state
before reacting to it, and let automatic compaction do its job instead of second-guessing it.

## Measure, never guess

Never call the context "heavy" or "full", and never recommend clearing or compacting, based on
session length or a feeling. A long session can still carry a small live context, because
compaction and persisted results shrink what remains active. Measure first, using whatever
authoritative source your harness exposes (a live usage percentage, a status line, an ambient
per-turn estimate) — cite the number, not an impression.

An estimate derived from scanning the visible transcript can under-report when subagents or
heavy tool output interleave with it. Apply a plausibility check: usage should grow roughly
monotonically across a session; a reading that suddenly drops with no compaction in between is
unreliable — don't act on it, re-probe over the next few turns, and cross-check a second source
when one is available. Treat an implausibly low reading early in a session, after substantial
work has already happened, with the same suspicion.

## Checkpoint on a real trigger, not a feeling

Checkpoint — persist durable state (task tracker, memory/notes) — after every completed task; a
lightweight pass suffices when little changed. Run the full consolidation ritual once measured
usage crosses a threshold set with margin below your harness's actual compaction point — the
margin needs to cover the ritual's own time, any under-reporting in the measurement, and one
turn of overshoot.

Save as late as safely possible, not as a target to rush toward: continuous durable writes
during the work (committing increments, updating the tracker) are the real safety net, and the
threshold checkpoint is the final consolidation, not the only protection.

## A resource limit is a door, not a loss — do not stop short of it

Do not stop working early to avoid being cut off by a budget, a window, or a rate limit. When
the state is durable — a tracker, a working tree, commits, notes — **an interrupted arc
resumes**, while budget left unspent inside a window is **gone**: it does not carry over. So the
mistake is not starting something too large for what remains. The mistake is **stopping short of
the limit**.

The tell, and it is a sentence forming in your own reasoning: *"I won't start anything else,
there's only N% left."* At that exact moment the question is not *"can I finish?"* but **"is
there budget left to spend?"** If there is, work.

This holds for a single account and does not depend on having a spare one: spending down to the
limit shortly before a window resets, then resuming on the fresh window, comes to the same
thing. What makes the cut harmless is the DURABILITY OF THE WORK, never the availability of a
second budget.

Before crossing the door, run the full consolidation once — that is what makes the interruption
cost nothing, and it is the only thing that must happen first.

**What does not change**: a decision to stop, for any reason, is ANNOUNCED with its reason at
the moment it is taken. Taking it is legitimate; taking it silently is not — the person who
asked for the work discovers later that it did not happen, and cannot say whether they would
have agreed.

## ⚠ ANNOUNCING A STOP IS NOT A SUBSTITUTE FOR NOT STOPPING

The clause above is about HOW to stop. Read alone it is satisfiable **by stopping**, and that is
exactly how it gets misapplied: state a reason, feel compliant, stop. Measured on one autonomous
mandate: six stops in a single day, every one of them correctly announced, every one of them
against what the person waiting actually wanted. The announcement is a floor, never a licence.

**So these two conditions are named NON-reasons. Under an autonomous mandate they do not justify
stopping, however well the stop is announced:**

- **Budget remaining, however little.** Unspent budget inside a window is gone; an interrupted arc
  resumes. The question is never "can I finish this?" but **"is there budget left to spend?"** —
  and if there is, the answer is to work. Only genuine exhaustion is a real constraint, and even
  then it is a wait, not an ending.
- **A filling context window.** Where compaction is automatic it fires on its own and the work
  resumes, so nothing needs to be wound down ahead of it. ⚠ And do not invent a derived reason —
  *"there is not enough room left to verify what I would start"* is the shape this takes, and it is
  still a stop dressed as prudence. **Take smaller work, or work that needs no verification budget,
  and keep going.** The record is durable; that is what makes the interruption free.

**The tell, and it is a sentence forming in your own reasoning**: *"I'll stop here, because X"*
where X is a budget or a window. At that moment the announcement is already written and it is the
stop that is wrong, not its wording.

⚠ This does not silence real blockers. A decision only the other party can make, an access you do
not have, a service that is down — those are genuine, and the rule for them is unchanged: name the
cause, name the one action that clears it, and say what you did with the rest of the time. **The
distinction is whether the work is IMPOSSIBLE or merely CONSTRAINED. Constrained means continue.**

## Let automatic compaction run

When automatic compaction is enabled, never stop and ask to compact manually — keep working;
compaction fires on its own and the session resumes automatically afterward. Stop-and-ask only
when automatic compaction is disabled. Task size is not a reason to shrink or defer work near
the boundary: compaction fires at a safe point between steps, not mid-operation, and an
interrupted task resumes cleanly from the tracker, the notes, and the working tree.

## First turn after a compaction or resume

Ground the resume instruction before acting on it — a resumed session can carry a stale or
already-completed target. Verify that a named artifact still exists, and still means what the
summary says, against its real source (disk, API, git) before running anything against it.

Rule and instruction text loaded at session start is a snapshot: editing it mid-session doesn't
refresh what's already been injected into a running session. If a change must take effect
immediately, state it explicitly in the conversation instead of relying on the file edit alone.
