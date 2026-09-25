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

Your OWN turns are a spend too. Session runs expensive tier → delegating is standing default,
not a fallback for heavy work only: hand even light chores — card/report writing, doc
grounding, mechanical file edit, investigation — to cheaper spawned agent, keep your turns for
duties above. Reflex "too small to delegate" is backwards: smaller task = higher relative
overhead inline — every turn carries the whole accumulated context. Stays inline: arbitration
itself, tiny high-judgment edits only you can make.

Cost-model-neutral PRINCIPLE: which concrete model each rung maps to is your account's
business — pin at spawn. Edit this file freely; it's yours.

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

## Every delegation hop costs an envelope — depth and chatter multiply it

Delegation = model pass ingesting input + re-ingesting output of what was delegated. Cheap per
hop, never free — multiplies along three axes:

- **Depth.** main → orchestrator → pilot → executor = three envelopes before a line of code is
  written. Don't add a fourth level; a task seeming to need one means decomposition is wrong,
  not depth limit.
- **Chatter.** Every follow-up message to a live delegate re-runs its envelope, reloads whole
  context. Five incremental corrections ≈ five complete briefs. Tell: second clarification to
  same delegate within minutes — not diligence, means first brief was incomplete. Fix brief;
  never stack messages on top.
- **Fan-out width.** Each agent in a fan-out pays its own envelope — second, independent reason
  never to add "one more reviewer to be safe".

Batch guidance into fewer complete messages; require same of every coordinator — reporting
per-step instead of per-milestone pays the envelope to say nothing.

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

## Picking the tier and effort at each spawn

Choose BOTH axes by task, never by identity or what session happens to run:

- Model tier: top-judgment (rarest — arbitration/adversarial verification strong tier can't
  settle) · strong (hard reasoning, architecture, quality verification) · workhorse
  (exploration, code mapping, implementation, targeted diff verification) · cheap
  (summarization, classification, trivial grep/listing). Use workhorse, not cheap tier, for
  code mapping — a wrong map costs more than the quota saved.
- Effort: low (mechanical/extraction) · medium (read-and-report, scoped audits) · high
  (implementation, code mapping, diff review, most verifiers) · xhigh (only genuinely-hard
  judgment). Pin effort on stable agent definitions via frontmatter — interactive spawn tool
  has no per-spawn effort knob.

Never set a blanket subagent-model env var: downgrades hard tasks, can silently override an
explicit per-spawn model:. Agent self-reports a different model than pinned → check settings
`env` blocks for such a var.

Effort is task-relative, never identity-/project-relative: pin via per-agent-type frontmatter,
not blanket user/project default — un-pinned inheritance is the bug, not the pin. Session-level
effort dial governs arbiter's own reasoning only, never what it spawns.

Complexity triage of a CODE task = code-reading judgment, not cheap-tier classification: gate
on deterministic signals (diff size, files touched) first, then one batched strong-tier triage
call; keep verifiers at a static high floor.

Workhorse tier DOMINATED by a stronger one — costs more per unit for lower quality —
"workhorse = cheap tier" assumption fails. Route that role to a cross-family lane instead,
reserve strong tier for quality, keep cheap tier for trivial work, avoid dominated tier
entirely.

## Four prohibitions that sharpen the ladder

1. **Executing a fully-specified design = executor-lane work, not inline on a strong model.**
   100%-specified, ratified design = IDEAL profile for the cheapest capable executor — a brief
   saying "implement it inline" on a strong model is a deviation even when design is done.
   Pilot arbitrates, gates, reviews; executor codes.
2. **ONE full re-gate per delivery: integrating arbiter's, on the real tree.** Implementer gates
   own worktree (its definition of done); intermediate coordinator does diff-read + targeted
   checks — never an additional independent full suite. Triple gate = quality-theatre at full
   price.
3. **A delegation wrapper never pre-reads sources.** Hands paths/instructions to executor,
   which reads for itself — a wrapper reading everything first burns coordinator-tier budget on
   work executor repeats anyway, same leak family as a wrapper answering in executor's place.
4. **A wrapper around an external model must never render its verdict itself.** An agent
   encapsulating a call to a cross-family CLI/API can answer in that model's place with nothing
   in the transcript showing the substitution happened — a verdict attributed to a decorrelated
   model needs provenance checked per call, against execution evidence the call itself
   produced, never trusted from wrapper's summary alone. Invoking the external tool directly
   (not through a wrapper) is recommended precisely because invocation is then its own
   provenance. Prohibition targets the intermediary substituting for the model, never the
   directness of the call.

## A mandate is re-issued, not assumed

A coordinator given a fixed list of items stops when list exhausted — nothing makes it pick up
newly-appearing work on its own, and it shouldn't invent scope it wasn't given. Coordinator
keeping going as new qualifying work appears → mandate must state an open scope plus a
mechanical, fail-closed stop condition — not a list — so it can re-scan for work after each
item without waiting to be reissued. Choose mode deliberately at issuance: fixed list for a
bounded batch, open mandate for a mission expected to absorb work created along the way.

## A cost or routing directive with no report-time check does not apply

Stating a delegation/cost policy ("increments go through the cheaper lane by default") ≠ it
being followed — a coordinator can silently ignore it under real pressure, nothing surfaces the
gap until someone reads a transcript after the fact. So: every wave/card report names which
tier/lane carried the IMPLEMENTATION and which the REVIEW, separately. A policy not verifiable
at report time is not in force, however much everyone agreed with it in principle.

## Lane consent, not lane availability

A pilot without a NAMED and CONSENTED executor lane doesn't implement a heavy increment on its
own tier — it splits: design/plan/arbitrate on own tier, spawn a cheaper sub-agent for the
increment. Availability of a bridge on the machine is NOT consent to use it: consent composes
account-level authorization (the ceiling) with project-level narrowing (never widening) — a
refusal at either level wins, and default is OFF.

The act-bound half of this rule is served on demand as `wt-delegation-ladder-at-act.md`.
