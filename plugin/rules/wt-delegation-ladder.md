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

⚠ **"Adopted" is a PRECONDITION, not an adjective — verify the type resolves BEFORE writing the
brief.** The pilot pair ships as `plugin/agent-templates/`, deliberately UNREGISTERED: the harness
does not honour `observer:` on a plugin-registered agent, so a registered pilot would run without
its watchdog, silently. A project that has not adopted them therefore has no `pilot` to spawn, and
nothing in this ladder says so — the spawn fails AFTER the expensive part, with a complete brief
already written. `install.mjs --set agents --install` adopts them with a version banner, so a later
`--check` reports staleness; a hand copy works and loses that.
⚠ Adoption is picked up within MINUTES, same session, no restart — measured. The "a new agent type
needs ~90 minutes or a restart" caution applies to a hand-written definition, not to an adoption.

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

## Briefing an executor (the split that makes delegation safe)

Arbiter designs, briefs, gates, reviews, commits. Executor implements. Structural decisions
(state-machine shape, API surface, seam boundaries, ownership, data-flow) stay with arbiter —
executor adjusts only within named seams. Open-ended "refactor this" = inadequate brief.

Strong brief states: invariants to preserve (tests/reasons), known traps, non-goals/scope
fences, required evidence format (exit codes + output tails), operating boundaries (no
commits/pushes, one working directory, sequential execution). Under-specification = extra
review rounds. Executor flags possible completeness gap ("every X must produce Y") → arbiter
requires the guard or proves case impossible — never files as harmless scope note.

State INVARIANT executor must reach, not mechanism you guessed reaches it. Prescribing *how*
caps executor at briefer's own knowledge of a layer executor actually reads. State what must be
TRUE, let executor find own route — different mechanism for same invariant = brief working,
not drift. Keep prescribing structure (shape, seams, ownership); stop prescribing technique.

⚠ A TASK'S REMAINING-WORK LEDGER IS A CLAIM ABOUT THE TREE — RE-DERIVE IT BEFORE BRIEFING FROM IT.
Multi-part task carries a running "N of M done, these remain" list, written by whoever last touched
it, from the commits they happened to read. Goes stale the instant a commit lands without a tracker
write. Nothing announces the drift: the ledger stays confident, specific, formatted exactly like a
verified fact — and AGE is a weak proxy, since same-day work can invalidate it.
Brief an executor from it and the work is already done. Executor is NOT the safeguard: told to fix a
defect, it has every reason to build a second mechanism beside the first, and a plausible one gates
green. Worst shape: it REWRITES what exists and silently drops hardening the original carried.
Before a remaining-work list becomes a brief, re-derive it from the tree — read the file at HEAD,
read the log for the paths involved. One command, seconds, and it answers the only question that
matters: is this still true?
⚠ Tell after the fact is FAVOURABLE: lane returns a clean tree, a suspiciously small diff, or reports
the work already satisfied. Reads as an easy task; it is the moment to re-derive, never to merge.
⚠ Such a run is not pure waste — say so: a lane that verifies rather than re-implements can prove an
EXISTING lock red, which nobody had. Report it as verification obtained, beside the brief defect.
⚠ VERIFY A CAPABILITY STILL EXISTS BEFORE BRIEFING AROUND IT. Brief gets checked against
the TASK — invariants right, fences right, definition of done quoted. Nobody checks it against the
PLATFORM: a capability that worked last week reads as furniture. A prescribed remedy can be
WITHDRAWN while the rule still names it, and the brief is then wrong BEFORE the executor reads it.
Covers a tool, a write path, an output channel, an agent type. Executor behaves correctly, cannot
comply, explains — one round trip bought for nothing, and the competence of both parties hides it.
Confirm at brief time; never infer from the rule that prescribes it.

MECHANICAL escalation trigger, never "use judgment": escalate after two failed attempts at same
fix, one repeated diagnosis, or ~15–20 min without narrowing problem. Judgment-based clause is
unenforceable, silently ignored — agent grinding a wrong hypothesis feels busy, not stuck, so
only a counting rule fires regardless.

Green report = EVIDENCE, not proof: rerun gates by exit code, read diff yourself before
committing. Release agent (shutdown request) only when arc complete. Terminated/quota-killed
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

## Paste the definition of done verbatim — a paraphrase can invert a criterion

A brief written from the briefer's reading of a task, not its text, can state the opposite of
one of its closure criteria. Executor has one authoritative source — the brief — so it obeys
correctly, gates green, lock proven red-then-green, report honest: a partial delivery that reads
complete, because the missed criterion was never in front of it.

Mechanism is compression, not carelessness: a brief keeps what feels load-bearing while the main
mechanism occupies the mind; edge criteria — the legitimate empty, the zero result, the degraded
path — read as peripheral, get rewritten into a scope fence. Same sentence, sign flipped.

Quote the definition of done as an unedited block in the brief. Add invariants, traps and fences
freely; never rewrite the criteria themselves. A criterion genuinely not applying this round is
named NEXT TO the quoted text, so the deviation is visible instead of invisible by omission.

Neither the gates nor the executor's own report can catch this — both are honest about what they
knew. Only the arbiter's diff-read against the task holds both documents at once — a second,
independent reason that read stays unconditional even on a clean-reporting delivery.

## An example shown to illustrate a style is indistinguishable from one shown to use

A brief that demonstrates a register with a filler sentence gets that sentence pasted into the
artifact, verbatim, as real content — executor has one authoritative source, and a
concrete-looking string in it reads as material, not metaphor. Nothing in the phrasing says which.

Show the shape in a form that would be WRONG to paste: a real example already in the artifact, or
a description with no quotable sentence in it. Never a plausible-looking template. Tell: a brief
containing a sentence that could survive copy-paste into the deliverable unchanged.

## "Read-only" is an ALLOW-LIST, never a subtraction and never a sentence in a brief

Delegate whose output is KNOWLEDGE rather than a change — investigate, ground, survey, audit — the
read-only property is enforced by WHAT THE AGENT CAN CALL. A brief saying "do not modify anything"
is an instruction a model can silently ignore, and this one fails OUTWARD: damage lands in someone
else's tree.

**Withholding the obvious writing tools does NOT produce a read-only agent.** An agent carrying no
file-write, no editor and no shell still CARRIES an installed MCP server's file-writing,
code-executing, record-deleting and message-sending tools — and a delegate can demonstrably invoke
a tool from that listing. Subtraction cannot work here for a structural reason: **an enumeration of
forbidden tools cannot cover a surface that GROWS.** Every MCP server a user installs adds tools no
existing rule names.

⚠ State the evidence at its real strength, because the weaker claim is enough: what is OBSERVED is
the tool listing plus one proven invocation from it. That a write through such a tool COMPLETES is
an inference, not a measurement. The allow-list is the right shape either way — it closes the
capability without needing the hazard demonstrated first.

So state the INVARIANT and enforce it as a list of what the agent MAY call: *it holds nothing that
mutates anything outside its own context*. An allow-list closes tools nobody has installed yet;
a deny-list closes only the ones someone already thought of.

⚠ **An allow-list can deliver LESS than it declares, silently.** Measured on two definitions:
declared entries did not arrive, with no error. It errs SAFE — fewer tools, never more — so the
fence holds, but a role must not assume a declared capability is present. **Read the running
agent's ACTUAL surface; a declaration is not a manifest.**

⚠ A tool that executes or writes cannot be narrowed by wording. Granting one because the task needs
it once is granting it for every later turn — the question at spawn is not "will it need this
once?" but "is there any turn on which this is unsafe?".

⚠ **A newly written agent type may not be spawnable in the session that wrote it.** Measured twice,
an hour apart, on one harness: the spawn returned `Agent type not found`, and the list it printed
omitted a type added forty minutes earlier — so that list is not re-read on demand there. Other
setups may refresh it; treat this as a hazard to check, not a universal.
**Plan a purpose-built fenced type to be verified in a LATER session**, so the arc does not depend
on a refresh that may not come.

⚠ Invisible from the spawner's side: a delegate reporting findings looks identical whether it READ
them or produced them by ACTING. Only its transcript, or independent verification of its claims,
separates the two.

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

## Addressing a delegated agent — name vs raw id, and what breaks silently

Reaching/watching a delegated agent: two facts easy to get wrong — produces false "it's
dead"/"it's idle" instead of an error; harness stays quiet either way. Both come from exercising
the surface directly; undocumented, may change without notice — treat below as dated
measurement, not permanent contract.

**Addressing.** Short `name` = normal address, keeps working after agent's own turn ends —
messaging a completed agent's name resumes it from transcript. Raw id (`a<name>-<hash>` named,
`a<hex>` anonymous) = fallback: use only when agent has no name, or a newer one took same name
(latest wins). Both routes exercised end-to-end (delivered AND acted on), both worked — raw id
isn't the primary address.

⚠ **Cross-restart revival by raw id is REPRODUCED, not a one-off — short name may still fail.**
After a full session restart (not just an agent completing its own turn), a previously-alive
agent addressed by short name has been seen to fail while the same agent's raw id succeeded —
and, corrected from an earlier draft calling this "a single unreproduced observation",
reproduced TWICE the same day, from a cold main session after a deliberate restart: a wave
orchestrator carrying ~290k tokens of context was revived by raw id with full mission scope,
open card ids, worktree state intact, then revived its own subordinate the same way with 178
prior messages intact. **Operative order: probe before re-spawning** — one `SendMessage` by raw
id costs nothing, reads both directions: substantive reply = context survived, routing failure
= fall back to fresh spawn. Re-spawning first, on the assumption a restart always kills a
delegate, throws away exactly the context this probe would have recovered.

**Raw id is recoverable even unrecorded**: `subagents/` directory's filenames
(`agent-<raw-id>.jsonl`) ARE the ids — a handover note should still carry it explicitly,
otherwise only route is that directory scan.

⚠ **TUI's silence is not evidence either way — never shows a resumed agent.** A revived agent —
alive, responsive, full prior context intact — does not appear anywhere in the interactive agent list, so
"nothing listed" is never proof it's gone; check by probing (above), never by reading the list.

⚠ **Honest scope**: what's reproduced = REACHABILITY-WITH-CONTEXT across a restart, on this
harness version, in cases actually observed. Treat as a probe worth running first, not as a
permanent guarantee — don't generalize into "a restart never loses an agent" any more than the
retired wording generalized the opposite.

## A delegated agent's transcript is a DIFFERENT file from the session's own

A freshness watcher armed on "the agent's transcript" is easy to point at the wrong file —
natural guess, the session's own conversation log, isn't it:

```
<projects-dir>/<session-id>.jsonl                              ← the SESSION's own conversation
<projects-dir>/<session-id>/subagents/agent-<raw-id>.jsonl      ← the DELEGATE's own transcript
```

⚠ **A watcher armed on the top-level file is a hollow guard.** Measures session's own writes,
not the delegate's — reports "active" as long as session keeps talking regardless of whether
delegate working, stuck, or gone; silence indistinguishable from a healthy delegate. Point any
freshness check at `subagents/agent-<raw-id>.jsonl`, confirm file exists before arming: absent
file = watcher never armed, not a quiet delegate.

**Side benefit**: filenames under `subagents/` ARE the raw ids (`agent-<raw-id>.jsonl`) —
dependency-free way to recover a delegate's raw id when name stops resolving, no dependency on
any optional hook or state directory being enabled.

## The naming/observer trade-off — state it, don't pick a side

Delegate definition declares a paired read-only observer → how it's spawned changes whether
observer attaches, on this same undocumented surface:

| Spawn shape | Observer attaches | Addressable by name | Addressable by raw id |
|---|---|---|---|
| anonymous (no `name`) | yes | no | yes (recover via `subagents/`) |
| `name` **+** an isolated worktree | yes | yes | yes |
| `name` alone | **no** (drops silently) | yes | yes |

Third row's drop is conditional: happens once session already has other addressable teammates
(team context initializes lazily) — very first named spawn can still land the observer even
without isolation. Don't reason whether condition holds for a given spawn; pick a shape safe
either way.

Real three-way trade-off, not a rule to prescribe once: anonymous keeps observer at cost of
name-based addressing (recoverable via raw id above); named-without-isolation risks losing
observer silently; named-plus-isolated keeps both — EXCEPT when delegate hands its own
increment to an external executor lane, because an isolated worktree with zero-diff at idle
gets reaped while lane still runs inside it, making that combination unusable for a
lane-delegating delegate specifically. State which shape a coordinator uses and why, rather
than defaulting to one without saying so.

## Pass LIVENESS_AGENT_ID to every delegate you spawn directly

Via `pilot-wave` or direct spawn of `pilot`/`pilot-orchestrator` — same discipline applies: a
delegate can't read its own raw agent id from inside itself, no environment variable carries
it. Never hand it over → its liveness file (arc watcher's third correlation input; see
"Liveness file" in `pilot.md`/`pilot-orchestrator.md`) degrades to a weaker key (declared name)
or, for an anonymous spawn, to `UNCORRELATABLE`. Anonymous isn't rare — it's the ONLY safe
shape for a delegate handing its increment to an external executor lane (see trade-off above),
exactly the population most likely to lose correlation.

`Agent` tool returns raw id only when spawn call RETURNS, after prompt already sent — id is
never a field inside the brief, it's a follow-up. Moment spawn call returns, before next
action, `SendMessage` the delegate one line:

```
LIVENESS_AGENT_ID: <raw id>
```

Do this for every direct spawn of a `pilot` or `pilot-orchestrator`, named or anonymous. Costs
one short message, closes the gap for exactly the delegates the mechanism most needs to cover.

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
