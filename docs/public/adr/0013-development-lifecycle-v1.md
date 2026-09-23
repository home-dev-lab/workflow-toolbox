# 13. The development lifecycle is the pilot's loop, made explicit

Date: 2026-09-18

## Status

Accepted

## Context

A card driven by a pilot already went through a recognisable cycle: understand the card, plan,
write a failing test, implement, run the gates, review, report. That cycle lived only in prose —
in the pilot agent's own definition, and in whatever a brief happened to restate. Three costs
followed from its being implicit.

**Nothing crossed a phase boundary as an artefact.** What the pilot knew at planning time — which
files it expected to touch, which callers were untested, which risk categories the card carried —
existed as reasoning inside one agent's context. When that context was compacted, or the card was
picked up a week later, or the increment was handed to an executor lane, the reasoning was gone
and the next actor re-derived it from the card's prose, differently.

**The choice of how much process to apply was a judgement made by whoever was cheapest.** A small
card and a card touching a published guard got whatever rigour the agent driving them decided on.
A model asked "is this a small change?" answers yes far more often than the diff supports, and the
answer is invisible afterwards: a card that skipped review looks exactly like a card that did not
need one.

**Loops had no written exit.** "Plan, then critique, then revise" has no natural end, and neither
does "fix the finding, re-run, review again". In practice they ended when the agent felt finished,
which is not a condition anyone can check, and a loop grinding on a wrong hypothesis feels busy
rather than stuck.

A survey of an external agent development workflow (Everything Claude Code, compared against our
loop in a separate piece of work) supplied the shape of the remedy but not its parts: its own
runner has since been decommissioned upstream, and its human-approval-per-plan step, its state
directory, its fixed reviewer fan-outs and its coverage threshold were all deliberately left
behind.

## Decision

**The lifecycle is the pilot's existing loop written down, not a new runner and not a second
tracker.** It adds no process layer above the pilot; it makes the loop's own steps nameable,
checkable and resumable. Four parts.

**1. Discovery is a phase of its own, before any plan, and its output is a block on the card.**
The block carries the expected impact, the seams touched, which callers are tested and which are
not, the risk categories present (money, security, data loss, public surface, guard,
availability), the proof expected — which gates, which end-to-end check — and the current phase
with its next step. It is rewritten at each phase exit. It is the artefact that crosses phases: a
lane brief and a lane report carry it verbatim, so an executor receives what the pilot concluded
rather than a paraphrase, and a card resumed after a compaction starts from the block rather than
from a re-reading.

**2. The LITE/FULL decision is mechanical first, and a judgement only for the remainder.**
Thresholds on the discovery block's own fields and on the card's labels decide it; any risk
category present forces FULL; unsure forces FULL. Only the genuinely ambiguous remainder goes to
one strong-tier call, briefed to round up. LITE skips the plan-and-critique cycle and goes
straight to the test-first loop; FULL runs the whole cycle. A model never decides LITE on its own,
because the failure is asymmetric: a LITE card that deserved FULL ships unreviewed, while a FULL
card that deserved LITE costs only time.

**3. Every loop has a mechanical exit condition.** Plan and critique use their bounded policy,
exiting when no blocking finding remains. Review returns blocking findings to the same TDD
implementer, which fixes red-first with targeted tests, typecheck, and lint before one full suite at
VERIFY. Review has no fixed round cap: it continues while blockers fall, and escalates when the same
anchored finding returns or the blocking count fails to drop for two consecutive rounds. Every review
finding carries a disposition before the card can close — fixed with a lock proven red, routed to a
card that exists and is named, or rejected with evidence. Non-convergence names every unresolved
finding and the fired signal; it never silently delivers, and a bare deferral is not a disposition.

**4. The dividing line to a full multi-agent workflow is the proportionate-verification ladder,
not a preference.** A feature, production logic, or anything touching money, security, data loss,
a public surface or a guard goes to the heavier verification; everything else is this cycle,
driven by a pilot that routes its own increments to cheaper executor lanes.

### What this distribution ships, and what it does not

This decision is recorded in the public repository because the cycle it describes is the one the
shipped `pilot` agent template runs. Two parts of it are shipped here:

- the **pilot templates** under `plugin/agent-templates/`, which carry the discovery block, the
  mechanical LITE/FULL routing and the written loop bounds;
- the **`wt-sdlc` rule** under `plugin/rules/`, which states the phase order and the disposition
  requirement for any session that adopts it, and which defers to a hooks plugin's routing where
  one is loaded.

**The mechanical ENFORCEMENT is not part of this distribution.** On the machine where this was
developed, a separate, private hooks plugin refuses a phase transition whose discovery block is
missing and refuses a commit whose gates have no record. Nothing in this repository depends on it,
and an adopter gets the cycle as a discipline their agents follow, not as a gate that stops them.
Saying so is part of the decision: a reader who assumes the shipped half refuses anything would be
trusting a guard that is not there.

## Consequences

The cycle costs less than a workflow run — there is no arbitration layer per card beyond the pilot
itself, and no heavy agent envelope per phase — while keeping the same evidence discipline: gates
read by exit code, every fix proven red before it is accepted as green, and the card as the source
of truth rather than a session's memory. Work branches by condition rather than by a fixed
sequence, and a card is resumable from its discovery block alone.

Two costs are real and accepted. The discovery block is written by the same actor that acts on it,
so it records what that actor believed, not an independent reading — it makes reasoning
checkable, never correct. And a mechanical LITE/FULL table will misclassify at the margins; it is
set to round up, which means some cards get more process than they needed, deliberately.

Three things were considered and refused: a dedicated runner process, on the ground that the
harness already runs agents and a second scheduler would need its own liveness story; a state
directory beside the repository, because the card and the working tree already hold the state and
a third copy drifts; and a human approval gate per plan, which the owner of this project
explicitly does not want — agreement on the shape at brainstorming time is the validation, and a
per-plan gate would make an autonomous night impossible.

Recorded work follows in separate increments: the disposition requirement enforced on the report
shape, and a per-language pack of on-demand rules, skills and agents, starting with TypeScript.
