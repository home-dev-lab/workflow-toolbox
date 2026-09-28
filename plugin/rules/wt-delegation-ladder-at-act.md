# Delegation ladder (workflow-toolbox) — at act

⚠ **"Adopted" is a PRECONDITION, not an adjective — verify the type resolves BEFORE writing the
brief.** The pilot pair ships as `plugin/agent-templates/`, deliberately UNREGISTERED: the harness
does not honour `observer:` on a plugin-registered agent, so a registered pilot would run without
its watchdog, silently. A project that has not adopted them therefore has no `pilot` to spawn, and
nothing in this ladder says so — the spawn fails AFTER the expensive part, with a complete brief
already written. `install.mjs --set agents --install` adopts them with a version banner, so a later
`--check` reports staleness; a hand copy works and loses that.
⚠ Adopted and newly written agent types can appear in the same session, without a restart; allow
for a short delay under load and re-probe if a newly added type does not resolve at first.

## Briefing an executor (the split that makes delegation safe)

Arbiter designs, briefs, gates, reviews, commits. Executor implements. Structural decisions
(state-machine shape, API surface, seam boundaries, ownership, data-flow) stay with arbiter —
executor adjusts only within named seams. Open-ended "refactor this" = inadequate brief.

Strong brief states: invariants to preserve (tests/reasons), known traps, non-goals/scope
fences, required evidence format (exit codes + output tails), operating boundaries (no
commits/pushes, one working directory, sequential execution). Under-specification = extra
review rounds. Executor flags possible completeness gap ("every X must produce Y") → arbiter
requires the guard or proves case impossible — never files as harmless scope note.

Every hand-written executor-lane brief requires `## Lessons for the memory` in its report, with
`None.` legitimate, alongside gate evidence. At that lane's integration, harvest that one report;
never defer reports into an end-of-run pile.

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
the tool listing, one proven invocation from it, and — measured since — a file WRITTEN to disk by a
built-in "read-only" agent type through an installed server's shell tool, read back by the
spawning session. The allow-list is the right shape either way — it closes the capability without
needing the hazard demonstrated first.

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

⚠ **A newly written agent type may become spawnable in the same session**, immediately or after
a few minutes under load, without a restart. **Re-probe after a refusal rather than declaring
the type unavailable**; if needed now, arrange to verify it when it resolves.

⚠ Invisible from the spawner's side: a delegate reporting findings looks identical whether it READ
them or produced them by ACTING. Only its transcript, or independent verification of its claims,
separates the two.
