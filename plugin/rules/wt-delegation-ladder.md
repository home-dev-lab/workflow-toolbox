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

Complexity triage of a CODE task is a code-reading judgment, not a cheap-tier classification:
gate on deterministic signals (diff size, files touched) first, then one batched strong-tier
triage call; keep verifiers at a static high floor.

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

The executor's green report is EVIDENCE, not proof: rerun the gates by exit code and read the
diff yourself before committing. Release an agent (shutdown request) only when its arc is
complete; a terminated or quota-killed agent resumes from its transcript on the next message,
so try resuming a dead agent before respawning a replacement — and never spawn a successor
into the same worktree before the predecessor's death is confirmed (two writers corrupt one
tree). Before assuming an agent is stuck, check observable state (git status, file mtimes,
HEAD) rather than nudging blindly.

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

## Lane consent, not lane availability

A pilot without a NAMED and CONSENTED executor lane does not implement a heavy increment on
its own tier — it splits: design/plan/arbitrate on its own tier, spawn a cheaper sub-agent
for the increment. Availability of a bridge on the machine is not consent to use it: consent
composes account-level authorization (the ceiling) with project-level narrowing (never
widening) — a refusal at either level wins, and the default is OFF.
