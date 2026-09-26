# Delegation ladder (workflow-toolbox)

Route task to LOWEST rung fitting. PIN model+effort at EVERY spawn — never let delegate inherit
session model silently. Heavy mechanical work → cheaper executor; judgment stays with you as
arbiter.

- Deterministic predicate (count, "field exist?", "did last turn call X") → code — script/grep,
  no model.
- Question / analysis / arbitration → answer inline, no delegation.
- One mechanical chore → throwaway sub-agent (cheap model).
- One tracked card, full dev loop → adopted `pilot`.
- Several cards / a wave → adopted `pilot-orchestrator` → pilots.
- Heavy implementation increment of one card → card's executor lane.
- Decorrelated verification of checkable claim → different model family.

**Floor of ladder ≠ cheapest model — it's code.** Deterministic-answer question → script: zero
cost, zero latency, zero ambiguity. Routing a deterministic predicate to a model instead isn't
rigor — it's over-delegation, introducing uncertainty into a question that had none.

Compose pilot/orchestrator spawn (environment brief + model elevation) via
`workflow-toolbox:pilot-wave` skill. Non-delegable duties: owning wake-ups (delegate's
background wait doesn't reliably re-wake it — inbound message does), user-gates (publish /
deploy / destructive / business preference), memory writes, Workflow tool.

Your OWN turns are a spend too. Session runs expensive tier → delegating is standing default,
not a fallback for heavy work only: hand even light chores — card/report writing, doc
grounding, mechanical file edit, investigation — to cheaper spawned agent, keep your turns for
duties above. Reflex "too small to delegate" is backwards: smaller task = higher relative
overhead inline — every turn carries the whole accumulated context. Stays inline: arbitration
itself, tiny high-judgment edits only you can make.

Cost-model-neutral PRINCIPLE: which concrete model each rung maps to is your account's
business — pin at spawn. Edit this file freely; it's yours.

Escalate inline diagnosis after two failed attempts at the same fix, one repeated diagnosis, or
~15–20 min without narrowing the problem.
Every wave/card report names the tier or lane carrying IMPLEMENTATION and the tier or lane carrying
REVIEW separately.

## When this policy meets a contradicting instruction, fix the SCOPE — never arbitrate by force

A session can carry, alongside this ladder, some other standing instruction that appears to
forbid a tool this ladder routes to (an agent-spawn tool, a fan-out mechanism, anything named
generically enough to look like it covers both). Measured on one machine: two sessions read the
same pair of texts the same day and landed on opposite behavior — one stopped delegating
entirely, the other did delegable work inline on its own expensive tier — neither announced the
choice, because nothing said which text should yield.

**The question in that moment is never "which instruction is stronger."** It's that **one of the
two has an unwritten scope**, and finding it is the cheap, correct move — arbitrating by force
(strength, recency, specificity-by-feel) skips that step and picks a reading silently, almost
always the one that disables the most machinery.

The move: read what the competing instruction actually names. A prohibition is usually aimed at
one class of thing — an EXPENSIVE, AUTONOMOUS fan-out (a swarm, a multi-agent workflow run, a
deep-research sweep) — not at the ordinary, cheap sub-agent spawn this ladder is built from. If
the competing text's own wording, read narrowly, does not name the ordinary case, it doesn't
reach it — and reading it as if it did makes the entire ladder in this file (the single chore,
the card pilot, the wave orchestrator) dead letter, which no text ever asked for.

State the scope you land on, once, rather than silently picking a reading: name the competing
instruction (without quoting a source you cannot see the origin of — a rule with untraceable
provenance is not evidence it applies broadly) and say explicitly which class it covers and which
it doesn't. That one sentence is what turns a silent, diverging arbitration into a recorded,
checkable decision.

### What an envelope is made of — and why delegating is cheaper at the SAME tier

The bill is **number of model calls × size of the re-read**. The overwhelming majority of the
tokens billed on a turn are the conversation being re-ingested; what the session writes is
negligible beside it. Both factors are yours to move, and the second is the one most often
treated as fixed:

- **A tool round IS a model call.** Five separate searches cost five full re-reads of the whole
  conversation; the same five issued in one message cost one. Batching independent commands is a
  multiple-fold saving on that step, not tidiness.
- **The same tool round costs far less in a fresh context than in a loaded one** — a large enough
  gap that delegating is cheaper than working inline EVEN WHEN the delegate is the same tier doing
  the same work. "Too small to delegate" is backwards: the smaller the task, the higher the share
  of its cost that is the re-read it triggers.
- **A watcher wake on an idle session is a real, billed model call**, paid as a full re-read, and
  on a long-idle session as a context rebuild. Keep watchers that wake for a REASON; a periodic
  tick that wakes to find nothing pays the envelope to say nothing, exactly like a per-step
  report. Event-driven, fewer wakes — never quieter wakes, since a watcher that goes silent to be
  polite is indistinguishable from one that died.

⚠ State the ratios you measure on your own setup rather than assuming these hold; what is
structural is the SHAPE — calls times re-read — not any particular multiple.

## A fence justified by a live condition carries its expiry — and something must RE-READ it

A brief, a rule or a card fences something off because a condition holds NOW: another writer is in
that directory, a proof is missing, a version is unpublished. That condition ends. **Nothing
re-checks the fence.**

The cost is invisible from both sides. Whoever obeys a stale fence reports work correctly blocked
and names the fence as the trigger; whoever set it reads a well-formed refusal. Both are right, and
the work stopped for nothing.

So name the EXPIRY IN the fence, never the fence alone: *"until the compression pass finishes"* is
checkable by the reader, *"don't touch Y"* is forever.

⚠ **Writing the expiry is only half — an expiry nobody re-reads is inert.** A stale fence reads
exactly like a live one: same text, and no way for a reader to tell which. The cheap remedies:

- name the fence's condition where whatever SATISFIES it gets recorded, so closing the work and
  lifting the fence are one act rather than two;
- when a fence quotes a state, quote the SOURCE that decides it, so a reader checks in one command
  instead of trusting the sentence;
- finding a fence whose condition appears met and that is NOT yours: report it with the evidence
  and state what you could not resolve, rather than lifting it. A fence's wording and the evidence
  offered against it often name subtly different objects, and its author is who knows which was
  meant.

⚠ Lifting for ONE case is not lifting: generalise the lift in the same act, or say plainly that it
still stands elsewhere.

⚠ A prohibition that never came from the live condition SURVIVES the lift. Say which, explicitly —
lifting a fence must not read as lifting everything near it.

Its act-bound half is `wt-delegation-ladder-at-act.md`, loaded alongside this file or served on
demand where an engine is installed.
