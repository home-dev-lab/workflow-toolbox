# Delegation ladder — routing at act

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

MECHANICAL escalation trigger, never "use judgment": escalate after two failed attempts at same
fix, one repeated diagnosis, or ~15–20 min without narrowing problem. Judgment-based clause is
unenforceable, silently ignored — agent grinding a wrong hypothesis feels busy, not stuck, so
only a counting rule fires regardless.

Green report = EVIDENCE, not proof: rerun gates by exit code, read diff yourself before
committing. Arc complete → LEAVE the agent idle; do not send it a shutdown request. ⚠ Observed twice out of twice on one
harness version: a shutdown request accepted by an in-process sub-agent was followed within seconds by the
end of the SPAWNING session itself (unproven as a cause — no counter-example sought); an idle agent costs nothing. Terminated/quota-killed
agent resumes from transcript on next message — try resuming before respawning; never spawn a
successor into same worktree before predecessor's death confirmed (two writers corrupt one
tree). Before assuming agent stuck, check observable state (git status, file mtimes, HEAD)
rather than nudging blindly.

⚠ But silence alone ≠ agent dead: a legitimately-waiting agent writes nothing, identical to one
that died. Signal that discriminates = agent's RESPONSE, not how long it stayed quiet —
check-in states observation, asks, rather than asserting death; asserting it forces a live
agent to spend a turn correcting a wrong premise.

Don't poll completion through a status/task-lookup tool: display name isn't an id such tools
accept, a lookup finding nothing proves nothing. Wait for completion notification, or arm own
watcher on a real signal (file changes, process state) for independent wake-up.

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
