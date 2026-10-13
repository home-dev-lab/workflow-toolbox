# Delegation ladder — routing at act

## Every delegation hop costs an envelope — depth and chatter multiply it

Delegation = model pass ingesting input + re-ingesting delegated output; cheap, never free.
Three multiplying axes:

- **Depth.** main → orchestrator → pilot → executor = three envelopes before code. No fourth
  level; apparent need means wrong decomposition, not wrong depth limit.
- **Chatter.** Live-delegate follow-up reloads whole context, re-runs envelope. Five incremental corrections
  ≈ five complete briefs. Second clarification to same delegate within minutes → incomplete first brief, not
  diligence. Fix brief; never stack messages.
- **Fan-out width.** Each agent pays envelope → independent reason never to add "one more
  reviewer to be safe".

Batch guidance into fewer complete messages; require every coordinator likewise. Per-step
instead of per-milestone reporting pays envelope to say nothing.

## Picking the tier and effort at each spawn

Compose pilot/orchestrator spawn (environment brief + model elevation) via
`workflow-toolbox:pilot-wave` skill.

Choose BOTH axes by task, never identity or whatever session happens to run:

- Model: top-judgment (rarest: arbitration/adversarial verification strong can't settle) ·
  strong (hard reasoning, architecture, quality verification) · workhorse (exploration, code
  mapping, implementation, targeted diff verification) · cheap (summarization, classification,
  trivial grep/listing). Code mapping: workhorse, never cheap; wrong map costs more than quota saved.
- Effort: low (mechanical/extraction) · medium (read-and-report, scoped audits) · high
  (implementation, code mapping, diff review, most verifiers) · xhigh (only genuinely-hard
  judgment). Pin BOTH at spawn: the Agent tool takes `model` and `effort` per call;
  they override an agent type's frontmatter, default only when omitted. Custom types for
  call-inexpressible settings (`tools` allow-list, system-prompt contract, observer pairing),
  never model/effort pin alone. Effort task-relative, never identity-/project-relative;
  unpinned inheritance = bug, not pin. No blanket user/project effort default;
  session dial governs arbiter's own reasoning only, never spawns.

Never blanket subagent-model env var: downgrades unpinned hard tasks; force switch overrides
even explicit model:. Agent reports model differing from pin → inspect settings `env` blocks.

CODE complexity triage = code-reading judgment, not cheap classification: deterministic signals
(diff size, files touched) FIRST, then ONE batched strong-tier triage call; verifiers static high floor.

Workhorse DOMINATED (higher unit cost, lower quality than stronger tier) → "workhorse = cheap"
fails; route role to cross-family lane, avoid dominated tier entirely. Strong for quality,
cheap for trivial work.

MECHANICAL escalation, never "use judgment": two failed attempts at same fix, one repeated
diagnosis, or ~15–20 min without narrowing problem. Judgment silently unenforceable: wrong-hypothesis
grinding feels busy, not stuck; counting fires regardless. Step-back (`wt-step-back-architectural.md`),
never to the owner: list routes, the current route included while its attempts still narrow the problem;
take best route or another tier. Retries normal; BLOCKED goes up only with no route left.

Green report = EVIDENCE, not proof: rerun gates by exit code, read diff yourself before committing.
Arc complete → LEAVE idle: costs nothing, no shutdown request needed. Shutdown ending SPAWNING
session NOT reproduced (0 of 8 delivered to finished in-process teammate, harness 2.1.276/2.1.284);
never cite as cause. Terminated/quota-killed agent resumes transcript on next message → try resume
before respawn. Never successor in same worktree before confirmed predecessor death: two writers
corrupt tree. Before assuming stuck, check git status/file mtimes/HEAD, never nudge blindly.

⚠ Silence ≠ death: legitimate waiting also writes nothing. RESPONSE discriminates, not duration.
Check-in states observation, asks; never asserts death, costing live agent a corrective turn.

Never poll completion through status/task lookup: display name not accepted id; absence proves
nothing. Wait for notification or arm own real-signal watcher (file changes, process state)
for independent wake-up.

## Four prohibitions that sharpen the ladder

1. **Executing a fully-specified design = executor-lane work, never inline on strong model.** 100%-specified,
   ratified design IDEAL for cheapest capable executor; "implement it inline" on strong tier
   remains deviation when design done. Pilot arbitrates/gates/reviews; executor codes.
2. **ONE full re-gate/delivery: integrating arbiter, real tree.** Implementer gates own worktree
   (definition of done); intermediate coordinator diff-reads + targeted checks, never extra
   independent full suite. Triple gate = full-price quality-theatre.
3. **Wrapper never pre-reads sources.** Pass paths/instructions; executor reads. Pre-reading
   spends coordinator budget duplicating executor, same leak as answering in its place.
4. **External-model wrapper never renders verdict itself.** Cross-family CLI/API wrapper can
   substitute answer invisibly in transcript. Each decorrelated verdict: check provenance
   against call's own execution evidence, never wrapper summary alone. Direct invocation
   recommended: own provenance. Prohibition targets substitution, never call directness.

## A mandate is re-issued, not assumed

Fixed-list coordinator stops at exhaustion, cannot pick up new work, must not invent scope.
At issuance deliberately choose: fixed list for bounded batch; open scope + mechanical,
fail-closed stop condition for mission absorbing new qualifying work, enabling re-scan after
each item without reissuance — not a list.

## A cost or routing directive with no report-time check does not apply

Every wave/card report names IMPLEMENTATION and REVIEW tier/lane separately: stated policy
("increments go through the cheaper lane by default") can be silently ignored under pressure,
surfacing only in later transcript read. Without report-time verification, agreement ≠ policy in force.

## Lane consent, not lane availability

No NAMED and CONSENTED lane → pilot splits heavy increment: own-tier design/plan/arbitration,
cheaper sub-agent implementation. Bridge available ≠ consent: account authorization ceiling,
project only narrows, never widens; refusal at either wins, default OFF.
