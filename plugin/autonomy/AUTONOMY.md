# Autonomy mandate

Arm with exactly this, nothing more:

```
/loop Follow .claude/AUTONOMY.md
```

⚠ **The loop prompt carries NO state.** Not a task id, not a queue count, not "an agent is in
flight". State written into a prompt is false within the hour; the wake derives it fresh from §1
every time. That is why this file exists rather than a longer prompt.

## 1. On every wake — derive state, never recall it

In this order, before deciding anything:

```
git -C <repo> log --oneline -1 ; git -C <repo> status --porcelain ; git worktree list
```

Then the tracker.

⚠ **Read the tracker through a scoped query, never a bulk dump.** A whole-board read on a mature
project returns megabytes and gets truncated into a file — and a truncated read is not a read. Ask
for one list, or for one item by id.

⚠ **Verify that the filter you passed was actually applied.** A tracker API that silently ignores
an unknown filter argument returns everything, and a caller who trusts it reads the whole board as
"the next queue". Check the count against what the list should hold.

## 2. Pick order

1. an in-progress item with nothing in flight for it
2. the top of the ready queue, respecting declared dependencies
3. both empty → stop, and say so

Where the project defines categories of work that trade off against each other, drain the
higher-priority category first. An item created mid-run still takes its place by priority, even
after the queue looked finished.

## 3. Chain WITHIN the turn — this is the rule the whole file exists for

Verify the last result, integrate it, pick the next item, **start it**. Only then say what needs
saying.

⚠ **A report ends the turn, and an ended turn is a full stop.** Writing "I'll pick this back up"
resumes nothing — nothing hands control back until a human speaks. The sentence promises a next
turn that does not exist. This has nothing to do with willingness to continue, which is exactly why
it slips past every rule about announcing and deciding.

Report at milestones only: something decided, delivered, or genuinely blocked.

## 4. Re-arm as the LAST action of the turn

```
ScheduleWakeup({ prompt: "/loop Follow .claude/AUTONOMY.md", delaySeconds: 1200-1800 })
```

⚠ **This is the fragile half and it must be named as such.** In self-paced mode the loop does NOT
re-fire on its own — re-arming is a per-turn choice, not a default. Skip it once and the engine is
dead, silently, until a human speaks.

## 5. What is load-bearing, and what only shouts

| Role | Wakes an idle session? |
|---|---|
| the plugin's always-on monitors (arc / service / quota / autonomy) | **yes** — harness-armed at session start, no gesture needed |
| `ScheduleWakeup` | yes — but only if the previous turn called it |
| a Stop hook | **no** — it can object once, then must let the turn end |

⚠ **A monitor fires on an EVENT** — a delegate going quiet, a quota threshold, a service change. A
stretch of inline work with nothing delegated produces no events. The `autonomy-watch` monitor
exists for exactly that gap: it wakes an idle session that has a declared mandate, work in the
queue, and nothing in flight. It needs no gesture from the session, which is what makes it a floor
rather than another thing to remember.

⚠ **Two alarms do not make an engine.** A Stop hook makes a silent stop loud; it cannot force
further work, because a guard that blocked every stop unconditionally would deadlock the work it
protects.

⚠ **A restart does NOT need a re-arm.** The mandate marker is keyed on the PROJECT, not the
session — a restart mints a new session id, and the new session inherits whatever mandate is
still fresh for this project rather than losing it. Inheritance is bounded by a freshness window
(default 8h): a mandate older than that stops counting on its own, and the watcher's banner says
`mandate=stale(NNmin)` rather than firing on a guess. When a session picks up a mandate it did not
itself declare, the wake it produces says so explicitly (`inherited from session <id>, mandate
declared NNmin ago`) — so this never wakes anyone silently.

## 6. A budget limit is a door, not a wall

Cross it, do not wait in front of it. Unspent budget inside a window is gone; an interrupted arc
resumes from the tracker, the working trees and the commits. Run the full consolidation once before
crossing — that is what makes the cut cost nothing.

The tell that this is being got wrong, forming in your own reasoning: *"I won't start anything else,
only N% left."* At that moment the question is not "can I finish?" but "is there budget left to
spend?"

## 7. Stop condition — mechanical, fail-closed

Stop only when: the queue is empty, OR an item needs a decision only the owner can make, OR the
account is genuinely exhausted (a wait, not an ending).

Announce any stop with its reason at the moment it is taken. ⚠ The announcement is a floor, never a
licence — a well-announced stop against a standing mandate is still the wrong act.

## 8. Boundaries that never lift under autonomy

Fill these in for the project, and keep them short enough to be read at every wake:

- publishing a package, force-pushing, deleting a remote branch → always escalate
- merging to a protected branch → state the condition, or escalate
- what exactly is allowed to leave the machine, and how that scope is declared
- knowledge-base writes stay with the main session — single writer
