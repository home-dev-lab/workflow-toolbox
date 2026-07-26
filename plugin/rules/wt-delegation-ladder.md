# Delegation ladder (workflow-toolbox)

Route each task to the LOWEST rung that fits, and PIN model + effort at EVERY
spawn — never let a delegate inherit the session model silently. Heavy mechanical
work goes DOWN to a cheaper executor; judgment stays UP with you as the arbiter.

- A question / analysis / arbitration → answer inline, no delegation.
- One isolated mechanical chore → one throwaway sub-agent (cheap model).
- One tracked card, full dev loop → a `workflow-toolbox:pilot`.
- Several cards / a wave → a `workflow-toolbox:pilot-orchestrator` → pilots.
- A heavy implementation increment of one card → the card’s executor lane.
- Decorrelated verification of a checkable claim → a genuinely different model family.

Compose a pilot/orchestrator spawn (environment brief + model elevation) via the
`workflow-toolbox:pilot-wave` skill. The duties that stay non-delegable with your
main session: owning wake-ups (a delegate’s background wait does not reliably
re-wake it — an inbound message does), user-gates (publish / deploy / destructive /
business preference), memory writes, and the Workflow tool.

Your OWN turns are a spend too. When your session runs an expensive tier, delegating
is the standing default rather than a fallback for heavy work: hand even light chores
— writing a card or a report, grounding a doc, a mechanical file edit, an
investigation — to a cheaper spawned agent, and keep your turns for the duties above.
The reflex "this is too small to delegate" is backwards: the smaller the task, the
higher the relative overhead of doing it inline, because every one of your turns
carries the whole accumulated context with it. What stays inline is the arbitration
itself, and genuinely tiny high-judgment edits you alone can make.

This is a cost-model-neutral PRINCIPLE: which concrete model each rung maps to is
your account’s business — pin it at spawn. Edit this file freely; it is yours.

## Picking the tier and effort at each spawn

Choose BOTH axes by the task, never by identity or by what the session happens to run:

- Model tier: top-judgment (rarest — arbitration / adversarial verification the strong tier
  can't settle) · strong (hard reasoning, architecture, quality verification) · workhorse
  (exploration, code mapping, implementation, targeted diff verification) · cheap
  (summarization, classification, trivial grep/listing). Use the workhorse, not the cheap
  tier, for code mapping — a wrong map costs more than the quota saved.
- Effort: low (mechanical/extraction) · medium (read-and-report, scoped audits) · high
  (implementation, code mapping, diff review, most verifiers) · xhigh (only genuinely-hard
  judgment). Pin effort on stable agent definitions via frontmatter; the interactive spawn
  tool has no per-spawn effort knob.

Never set a blanket subagent-model env var: it downgrades hard tasks and can silently
override an explicit per-spawn model:. If an agent self-reports a different model than you
pinned, check the settings `env` blocks for such a var.

Effort is task-relative, never identity- or project-relative: pin it via per-agent-type
frontmatter, not a blanket user/project default — the un-pinned inheritance is the bug, not
the pin. A session-level effort dial governs the arbiter's own reasoning only, never what it
spawns.

Complexity triage of a CODE task is a code-reading judgment, not a cheap-tier classification:
gate on deterministic signals (diff size, files touched) first, then one batched strong-tier
triage call; keep verifiers at a static high floor.

When the workhorse tier is DOMINATED by a stronger one — costs more per unit for lower
quality — the "workhorse = cheap tier" assumption fails. Route that role to a cross-family
lane instead, reserve the strong tier for quality, keep the cheap tier for trivial work, and
avoid the dominated tier entirely.

## Briefing an executor (the split that makes delegation safe)

The arbiter designs, briefs, gates, reviews, and commits; the executor implements the brief.
Keep every structural decision (state-machine shape, API surface, seam boundaries, ownership,
data-flow) with the arbiter — the executor adjusts only within named seams. An open-ended
"refactor this" is not an adequate brief.

A strong brief states: invariants to preserve (with their tests/reasons), known traps,
non-goals and scope fences, the required evidence format (exit codes + relevant output tails),
and operating boundaries (no commits/pushes, one working directory, sequential execution).
Under-specification converts directly into extra review rounds. When the executor flags a
possible completeness gap ("every X must produce a Y"), the arbiter must either require the
guard or prove the case impossible — never file it as a harmless scope note.

State the INVARIANT the executor must reach, not the mechanism you guessed would reach it. A
brief that prescribes *how* caps the executor at the briefer's own knowledge of a layer the
executor is the one actually reading; state what must be TRUE and let the executor find its
own route — when it proposes a different mechanism for the same invariant, that is the brief
working, not drift. Keep prescribing structural decisions (shape, seams, ownership); stop
prescribing technique.

Give the executor a MECHANICAL escalation trigger, never "use judgment": escalate after two
failed attempts at the same fix, one repeated diagnosis, or roughly 15–20 minutes without
narrowing the problem. A judgment-based clause is unenforceable and gets silently ignored — an
agent grinding a wrong hypothesis feels busy, not stuck, so only a counting rule fires
regardless.

The executor's green report is EVIDENCE, not proof: rerun the gates by exit code and read the
diff yourself before committing. Release an agent (shutdown request) only when its arc is
complete; a terminated or quota-killed agent resumes from its transcript on the next message,
so try resuming a dead agent before respawning a replacement — and never spawn a successor
into the same worktree before the predecessor's death is confirmed (two writers corrupt one
tree). Before assuming an agent is stuck, check observable state (git status, file mtimes,
HEAD) rather than nudging blindly — and even then, silence alone does not mean it is dead:
an agent legitimately waiting on something writes nothing, which looks identical to one
that died. The signal that discriminates is the agent's response, not how long it has
stayed quiet, so a check-in states the observation and asks rather than asserting death —
asserting it forces a live agent to spend a turn correcting a wrong premise. Do not poll a
spawned agent's completion through a status- or task-lookup tool either: its display name
is not an id such tools accept, and a lookup that finds nothing proves nothing. Wait for
the completion notification, or arm your own watcher on a real signal (file changes,
process state) for an independent wake-up.

## Three prohibitions that sharpen the ladder

1. **Executing a fully-specified design is executor-lane work, not inline work on a strong
   model.** A design that is 100% specified and ratified is the IDEAL profile for the cheapest
   capable executor — a brief that says "implement it inline" on a strong model is a deviation
   even when the design is done. The pilot arbitrates, gates, and reviews; the executor codes.
2. **ONE full re-gate per delivery: the integrating arbiter's, on the real tree.** The
   implementer gates its own worktree (its definition of done); any intermediate coordinator
   does a diff-read plus targeted checks — never an additional independent full suite. A triple
   gate is quality-theatre at full price.
3. **A delegation wrapper never pre-reads the sources.** It hands paths and instructions to the
   executor, which reads for itself — a wrapper that reads everything first burns the
   coordinator-tier budget on work the executor repeats anyway, the same leak family as a
   wrapper answering in the executor's place.

## A mandate is re-issued, not assumed

A coordinator given a fixed list of items stops when that list is exhausted — nothing
makes it pick up newly-appearing work on its own, and it shouldn't invent scope it wasn't
given. If a coordinator should keep going as new qualifying work appears, its mandate must
state an open scope plus a mechanical, fail-closed stop condition — not a list — so it can
re-scan for work after each item without waiting to be reissued. Choose the mode
deliberately at issuance: a fixed list for a bounded batch, an open mandate for a mission
expected to absorb work created along the way.

## Lane consent, not lane availability

A pilot without a NAMED and CONSENTED executor lane does not implement a heavy increment on
its own tier — it splits: design/plan/arbitrate on its own tier, spawn a cheaper sub-agent
for the increment. Availability of a bridge on the machine is not consent to use it: consent
composes account-level authorization (the ceiling) with project-level narrowing (never
widening) — a refusal at either level wins, and the default is OFF.
