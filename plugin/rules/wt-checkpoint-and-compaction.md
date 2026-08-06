# Checkpoint and compaction — measure before acting, never stop when auto-compaction is on

Long sessions — delegated waves, multi-step dev loops — eventually hit context ceiling. Two
disciplines keep transition safe: measure real state before reacting, let automatic compaction do
its job instead of second-guessing it.

## Measure, never guess

Never call context "heavy"/"full", never recommend clearing/compacting, on session length or
feeling. Long session can carry small live context — compaction + persisted results shrink what's
active. Measure first: whatever authoritative source the harness exposes (live usage %, status
line, ambient per-turn estimate) — cite the number, not an impression.

Transcript-scan estimate can under-report when subagents/heavy tool output interleave.
Plausibility check: usage grows roughly monotonically; a sudden drop with no compaction in
between is unreliable — don't act on it, re-probe next few turns, cross-check a second source.
Implausibly low reading early, after substantial work, same suspicion.

## Checkpoint on a real trigger, not a feeling

Checkpoint — persist durable state (tracker, memory/notes) — after every completed task; light
pass when little changed. Full consolidation ritual once measured usage crosses a threshold set
with margin below the harness's real compaction point — margin covers ritual time, under-
reporting, one turn overshoot.

Save as late as safely possible, not a target to rush toward: continuous durable writes during
work (committing increments, updating tracker) = real safety net; threshold checkpoint = final
consolidation, not the only protection.

## A resource limit is a door, not a loss — do not stop short of it

Don't stop early to avoid a budget/window/rate-limit cutoff. State durable — tracker, working
tree, commits, notes — **interrupted arc resumes**, budget unspent inside a window is **gone**:
doesn't carry over. Mistake isn't starting too large for what remains. Mistake = **stopping short
of the limit**.

The tell, sentence forming in your own reasoning: *"I won't start anything else, only N% left."*
At that moment question isn't *"can I finish?"* but **"is there budget left to spend?"** Yes →
work.

Holds for a single account, no spare needed: spending down to the limit before a window resets,
resuming fresh, same thing. Cut harmless because of DURABILITY OF THE WORK, never a second
budget's availability.

Before crossing the door, run full consolidation once — makes the interruption cost nothing, only
thing that must happen first.

**What doesn't change**: a stop decision, any reason, is ANNOUNCED with its reason at the moment
taken. Taking it legitimate; silently isn't — the person who asked discovers later it didn't
happen, can't say whether they'd have agreed.

## ⚠ ANNOUNCING A STOP IS NOT A SUBSTITUTE FOR NOT STOPPING

Clause above = HOW to stop. Alone it's satisfiable **by stopping** — exactly how misapplied:
state reason, feel compliant, stop. Measured on one autonomous mandate: six stops one day, all
correctly announced, all against what the person waiting wanted. Announcement = floor, never
licence.

**These two conditions = NON-reasons. Under an autonomous mandate, don't justify stopping,
however well announced:**

- **Budget remaining, however little.** Unspent budget gone; interrupted arc resumes. Never "can
  I finish this?" — **"is there budget left to spend?"** Yes → work. Only genuine exhaustion is
  real constraint, and even then a wait, not an ending.
- **A filling context window.** Automatic compaction fires on its own, work resumes — nothing to
  wind down. ⚠ Don't invent a derived reason — *"not enough room to verify what I'd start"* is
  the shape, still a stop dressed as prudence. **Take smaller work, or work needing no
  verification budget, keep going.** Record is durable; that's what makes interruption free.

**The tell**: *"I'll stop here, because X"* where X = budget or window. At that moment the
announcement is already written and it's the STOP that's wrong, not its wording.

⚠ Doesn't silence real blockers. Decision only the other party can make, an access you lack, a
service that's down — genuine, rule unchanged: name cause, name the ONE clearing action, say what
you did with the rest of the time. **Work IMPOSSIBLE vs merely CONSTRAINED. Constrained means
continue.**

## Let automatic compaction run

Automatic compaction enabled → never stop to ask compacting manually — keep working; fires on its
own, session resumes after. Stop-and-ask only when disabled. Task size isn't a reason to
shrink/defer near the boundary: fires at a safe point between steps, not mid-operation —
interrupted task resumes cleanly from tracker, notes, working tree.

## First turn after a compaction or resume

Ground the resume instruction before acting — resumed session can carry a stale or
already-completed target. Verify a named artifact still exists, still means what the summary
says, against its real source (disk, API, git) before running anything against it.

Rule/instruction text read from disk whenever session context is BUILT — at start, and again at
every compaction. Mid-session edits don't refresh an already-running context; next compaction
picks the change up.

Two consequences, second nobody watches:

- Session that just edited a rule can't verify it obeys until restart **or** compaction. "Needs a
  fresh session" too strong; compaction serves too.
- **Behaviour can change at a compaction boundary with nothing announcing it.** A rule edited
  earlier — this session or another sharing files — takes effect at next compaction, mid-work, no
  event marking the transition. Behaviour shifts for no traceable reason → check a compaction
  that reloaded changed rule text first.

Change must take effect immediately → state it explicitly in conversation, don't rely on the file
edit alone.
