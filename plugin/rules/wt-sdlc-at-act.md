# wt-sdlc — at act

## Plan, task, and test

Before non-trivial coding, state the problem, expected behavior, affected areas, strategy,
tests, validation, and risks. Break work into dependency-ordered tasks; mark each complete only
after its own verification passes.

Use red, green, refactor where practical. A bug fix carries a regression test that fails before
the fix and passes after it. When strict TDD is impractical, tests still accompany the change;
do not retrofit a superficial test merely to satisfy the protocol.

## Implement and verify

Make the simplest correct change using the project's conventions. Do not add unrelated changes,
duplication, or abstractions that the problem does not require.

Tests cover relevant happy paths, branches, boundaries, invalid input, expected failures, and
regressions. A coverage number without a measuring gate is not evidence. For affected
user-facing flows, exercise the real UI end to end: primary flow, validation errors, navigation,
state, negative cases, and touched existing scenarios.

## E2E

Every brief carries the e2e in its definition of done. Every card where an end-to-end check is
possible gets one that:

- Runs against real data and real sources, not fixtures.
- Is repeatable with a script, or with a written procedure when no tool can drive the host.
- Has its output pasted verbatim into the report.

An agent or skill shipped to act on another project is e2e'd from that project's own session:
deploy it to the copy that project runs, then have that session invoke it. A run driven from the
builder's session proves the tool, not the agent; the builder never applies the agent's output to
the other project itself.

Observe an assumption about the host before building anything on it; treat the observation as
evidence, not the assumption as a premise.

## Independent review and refutation

**implementer → independent reviewer(s) → independent refuter → implementer.** The implementer
does not review itself; a reviewer does not refute itself. Use genuinely separate lanes where
available, and give reviewers sufficient evidence without supplying the desired conclusion.

After verification is green, reviewers make concrete claims: what, where, why it matters,
evidence, and remedy. No finding is legitimate. Apply these lenses:

- **A Correctness:** behavior, missing cases, races, errors, data corruption, contracts, and regressions.
- **B Testing:** proof quality, negative paths, assertions, mocks, and missing edges.
- **C Maintainability:** complexity, duplication, naming, abstractions, and coupling.
- **D Architecture:** structural changes only; boundaries, dependency direction, ownership, contracts, and proportionality.
- **E Security/robustness:** where applicable; trust boundaries, validation, authorization, secrets, injection, exposure, privilege, and denial of service.

An independent refuter tries to disprove every claim. Classify it with evidence as **Confirmed**,
**Likely valid**, **Uncertain**, **Refuted**, or **Not actionable**. Challenge unsupported
assumptions, hypothetical compatibility concerns without consumers, unnecessary abstractions,
style presented as correctness, and findings already covered by a test. The goal is confidence in
what survives, not defeating the reviewer.

Consolidate claim, evidence, refuter verdict, severity, confidence, and action; merge duplicates
but retain real disagreement. The implementer decides per finding: **fix**, **partially address**,
**reject with justification**, or **route** immediately to a card created now and named in the report
with its L4 reason. Never defer: a bare deferral is not a disposition.

Review-driven changes invalidate prior verification. Re-run focused and affected tests, relevant
integration checks, build, types, lint, affected end-to-end checks, and another review round when
the change is substantial enough.
