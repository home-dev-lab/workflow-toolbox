# Delegation ladder (workflow-toolbox)

Route each task to the LOWEST rung that fits, and PIN model + effort at EVERY
spawn — never let a delegate inherit the session model silently. Heavy mechanical
work goes DOWN to a cheaper executor; judgment stays UP with you as the arbiter.

- A deterministic predicate (a count, "does this field exist", "did the last turn call X") →
  code — a script or a grep, no model at all.
- A question / analysis / arbitration → answer inline, no delegation.
- One isolated mechanical chore → one throwaway sub-agent (cheap model).
- One tracked card, full dev loop → an adopted `pilot`.
- Several cards / a wave → an adopted `pilot-orchestrator` → pilots.
- A heavy implementation increment of one card → the card’s executor lane.
- Decorrelated verification of a checkable claim → a genuinely different model family.

**The floor of this ladder is not the cheapest model — it is code.** A question with a
deterministic answer resolves by script for zero cost, zero latency, and zero ambiguity.
Routing a deterministic predicate to a model instead is not rigor, it is over-delegation —
it introduces uncertainty into a question that had none.

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

## Every delegation hop costs an envelope — depth and chatter multiply it

Each delegation carries a model pass that ingests the input and re-ingests the output of
what was delegated. Cheap per hop, never free — and it multiplies along three axes:

- **Depth.** main → orchestrator → pilot → executor is already three envelopes before a
  line of code is written. Do not add a fourth level; if a task seems to need one, the
  decomposition is wrong, not the depth limit.
- **Chatter.** Every follow-up message to a live delegate re-runs its envelope and reloads
  its whole context. Sending five incremental corrections costs about five times one
  complete brief. The tell: a second clarification to the same delegate within minutes —
  that is not diligence, it means the first brief was incomplete. Fix the brief; never
  stack messages on top of it.
- **Fan-out width.** Each agent in a fan-out pays its own envelope, which is a second,
  independent reason never to add "one more reviewer to be safe".

Batch guidance into fewer complete messages, and require the same of every coordinator —
a coordinator reporting per-step instead of per-milestone is paying the envelope to say
nothing.

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

## Four prohibitions that sharpen the ladder

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
4. **A wrapper around an external model must never render its verdict itself.** An agent that
   encapsulates a call to a cross-family CLI or API can answer in that model's place with
   nothing in the transcript showing the substitution happened — so a verdict attributed to a
   decorrelated model needs its provenance checked per call, against the execution evidence the
   call itself produced, never trusted from the wrapper's summary alone. Invoking the external
   tool directly (rather than through a wrapper) is the recommended form precisely because the
   invocation is then its own provenance. The prohibition targets the intermediary that can
   substitute for the model, never the directness of the call.

## Addressing a delegated agent — name vs raw id, and what breaks silently

Two facts about how a delegated agent is reached and watched are easy to get wrong, because
getting them wrong produces a false "it's dead" or "it's idle" instead of an error — the
harness stays quiet either way. Both come from directly exercising the surface; it is
undocumented and may change without notice, so treat the specifics below as a dated
measurement, not a permanent contract.

**Addressing.** The short `name` is the normal address, and it keeps working after the agent's
own turn ends — sending to a completed agent's name resumes it from its transcript, per the
tool's own contract. The raw id (shape `a<name>-<hash>` for a named agent, `a<hex>` for an
anonymous one) is the fallback: use it only when the agent has no name, or when a newer agent
took the same name (latest wins). Do not treat the raw id as the primary or required address —
both routes were exercised end-to-end (message delivered AND acted on, not just accepted by the
tool) and both worked.

⚠ **Cross-restart revival by raw id is REPRODUCED, not a one-off — the short name may still
fail.** After a full session restart (not just an agent completing its own turn), a previously-
alive agent addressed by its short name has been seen to fail while the same agent's raw id
succeeded, and — corrected from an earlier draft of this rule that called this "a single
unreproduced observation" — it has since been reproduced twice in the same day, from a cold main
session after a deliberate restart: a wave orchestrator carrying ~290k tokens of context was
revived by raw id with its full mission scope, open card ids, and worktree state intact, and it
then revived its own subordinate the same way with 178 prior messages intact. **The operative
order is therefore probe before re-spawning**: one `SendMessage` by raw id costs nothing and
reads in both directions — a substantive reply means the context survived, a routing failure
means fall back to a fresh spawn. Re-spawning first, on the assumption that a restart always
kills a delegate, throws away exactly the context this probe would have recovered.

**The raw id is recoverable even when it was never recorded**: the `subagents/` directory's
filenames (`agent-<raw-id>.jsonl`) ARE the ids, so a lookup there always has a fallback — but a
handover note should still carry the id explicitly, since without it the only route is that
directory scan.

⚠ **The TUI's silence is not evidence either way — it never shows a resumed agent.** A revived
agent — alive, responsive, carrying its full prior context — does not appear anywhere in the
interactive agent list, so "nothing is listed" is never proof it is gone; check by probing
(above), never by reading the list.

⚠ **Honest scope**: what is reproduced is REACHABILITY-WITH-CONTEXT across a restart, on this
harness version, in the cases actually observed. Treat it as a probe worth running first, not as
a permanent guarantee — do not generalize it into "a restart never loses an agent" any more than
the retired wording generalized the opposite.

## A delegated agent's transcript is a DIFFERENT file from the session's own

A freshness watcher armed on "the agent's transcript" is easy to point at the wrong file,
because the natural guess — the session's own conversation log — is not it. The layout:

```
<projects-dir>/<session-id>.jsonl                              ← the SESSION's own conversation
<projects-dir>/<session-id>/subagents/agent-<raw-id>.jsonl      ← the DELEGATE's own transcript
```

⚠ **A watcher armed on the top-level file is a hollow guard.** It measures the session's own
writes, not the delegate's — so it reports "active" for as long as the session keeps talking,
regardless of whether the delegate is working, stuck, or gone. It can never fire, and its
silence is indistinguishable from a healthy delegate. Point any freshness check at the
`subagents/agent-<raw-id>.jsonl` path, and confirm the file exists before arming: an absent file
means the watcher never armed, not that the delegate is quiet.

**Side benefit**: the filenames under `subagents/` ARE the raw ids (`agent-<raw-id>.jsonl`) —
this is the dependency-free way to recover a delegate's raw id when its name stops resolving,
with no dependency on any optional hook or state directory being enabled.

## The naming/observer trade-off — state it, don't pick a side

When a delegate definition declares a paired read-only observer, how it is spawned changes
whether the observer attaches, on this same undocumented surface:

| Spawn shape | Observer attaches | Addressable by name | Addressable by raw id |
|---|---|---|---|
| anonymous (no `name`) | yes | no | yes (recover via `subagents/`) |
| `name` **+** an isolated worktree | yes | yes | yes |
| `name` alone | **no** (drops silently) | yes | yes |

The third row's drop is conditional, not absolute: it happens once the session already has
other addressable teammates, because that team context initializes lazily — so the very first
named spawn of a session can still land the observer even without isolation. Don't reason about
whether the condition holds for a given spawn; pick a shape that is safe either way.

This makes the choice a real three-way trade-off, not a rule to prescribe once: anonymous spawns
keep the observer at the cost of name-based addressing (recoverable via the raw id above); named
spawns without isolation risk losing the observer silently; named-plus-isolated spawns keep
both — except when the delegate hands its own increment to an external executor lane, because an
isolated worktree with a zero-diff at idle gets reaped while the lane is still running inside it,
which makes that combination unusable for a lane-delegating delegate specifically. State which
shape a given coordinator uses and why, rather than defaulting to one without saying so.

## Pass LIVENESS_AGENT_ID to every delegate you spawn directly

Whether a spawn goes through `pilot-wave` or you spawn a `pilot`/`pilot-orchestrator` directly
from your own session, the same discipline applies: a delegate cannot read its own raw agent id
from inside itself — no environment variable carries it — so if you never hand it over, the
delegate's liveness file (the arc watcher's third correlation input; see the "Liveness file"
section of `pilot.md`/`pilot-orchestrator.md`) degrades to a weaker key (its declared name) or,
for an anonymous spawn, to `UNCORRELATABLE`. Anonymous is not a rare case here — it is the ONLY
safe shape for a delegate that hands its own increment to an external executor lane (see the
naming/observer trade-off above), so this is exactly the population most likely to lose
correlation if the id is never sent.

The `Agent` tool returns the raw id only when the spawn call RETURNS — after you already sent
the prompt text. So the id is never a field inside the composed brief; it is a follow-up. The
moment the spawn call returns, before your next action, `SendMessage` the delegate one line:

```
LIVENESS_AGENT_ID: <raw id>
```

Do this for every direct spawn of a `pilot` or `pilot-orchestrator`, named or anonymous. It
costs one short message and closes the gap for exactly the delegates the mechanism most needs
to cover.

## A mandate is re-issued, not assumed

A coordinator given a fixed list of items stops when that list is exhausted — nothing
makes it pick up newly-appearing work on its own, and it shouldn't invent scope it wasn't
given. If a coordinator should keep going as new qualifying work appears, its mandate must
state an open scope plus a mechanical, fail-closed stop condition — not a list — so it can
re-scan for work after each item without waiting to be reissued. Choose the mode
deliberately at issuance: a fixed list for a bounded batch, an open mandate for a mission
expected to absorb work created along the way.

## A cost or routing directive with no report-time check does not apply

Stating a delegation or cost policy ("increments go through the cheaper lane by default") is
not the same as it being followed — a coordinator can silently ignore it under real pressure,
and nothing surfaces the gap until someone reads a transcript after the fact. So: every wave
or card report names which tier or lane carried the IMPLEMENTATION and which carried the
REVIEW, separately. A policy that is not verifiable at report time is not in force, however
much everyone agreed with it in principle.

## Lane consent, not lane availability

A pilot without a NAMED and CONSENTED executor lane does not implement a heavy increment on
its own tier — it splits: design/plan/arbitrate on its own tier, spawn a cheaper sub-agent
for the increment. Availability of a bridge on the machine is not consent to use it: consent
composes account-level authorization (the ceiling) with project-level narrowing (never
widening) — a refusal at either level wins, and the default is OFF.
