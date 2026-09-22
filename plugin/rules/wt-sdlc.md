# SDLC engineering protocol

This protocol binds whoever changes code: a main session working directly, a pilot, and an
executor. No session-mode exemption. Every non-trivial change has a tracker card before its
first edit; otherwise the work and its review are invisible.

**UNDERSTAND → PLAN → TASK → TEST → IMPLEMENT → VERIFY → INDEPENDENT REVIEW → INDEPENDENT
REFUTATION → IMPLEMENTER DECISION → REVERIFY → E2E → REPORT.**

Where the lifecycle hooks are loaded, follow their LITE/FULL routing, phase gate, bounded
cycles, per-finding dispositions, and exit-code gates. Where they are not loaded, apply the
same shape by hand. Do not restate or weaken a mechanical check.

## Understand before coding

Inspect the real code, tests, configuration, conventions, and documentation first. Name the
affected components, dependencies, compatibility constraints, edge cases, failure modes, and
security or performance implications. Derive ambiguity from existing behavior and tests; do
not invent answers the repository can provide.

## Compatibility context

Name real consumers where they exist: released users, external services, published APIs,
deployed systems, downstream repositories, or persisted data. Where none exist, choose the
cleanest correct design. Do not retain a shim or legacy API merely because it exists.

## Plan, task, and test

Before non-trivial coding, state the problem, expected behavior, affected areas, strategy,
tests, validation, and risks. Break work into dependency-ordered tasks; mark each complete only
after its own verification passes.

Use red, green, refactor where practical. A bug fix carries a regression test that fails before
the fix and passes after it. When strict TDD is impractical, tests still accompany the change;
do not retrofit a superficial test merely to satisfy the protocol.

## Revise only blocking critic findings

Revise only for the blocking findings. Keep every previously accepted part unchanged. Do not
restart the plan from scratch. For each blocking finding, state what changed.

## Implement and verify

Make the simplest correct change using the project's conventions. Do not add unrelated changes,
duplication, or abstractions that the problem does not require.

Run the applicable build, type, lint, format, test, integration, static-analysis, and end-to-end
checks. Record each by exit code. Never claim a check passed unless it ran; an unrunnable check
remains explicitly unresolved. Warnings introduced by the change are failures unless justified.

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

Observe an assumption about the host before building anything on it; treat the observation as
evidence, not the assumption as a premise. A delivery without the required output says `e2e not
run` with a reason instead of being presented as ready.

Rationale and field cases: `docs/wt/wt-sdlc.md` §Real sources expose integration failures.

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

## Proportionality

| Change range | Required judgment shape |
| --- | --- |
| Feature, production logic, or high risk | Full five-lens review plus independent refuter |
| Follow-up implementing an approved finding | One targeted independent verifier, or the arbiter's diff-read plus gates, stated explicitly |
| Test-only or docs-only | Diff-read plus gates; no agents |

Classify mechanically, not by feel: the lightweight range requires at most three files, at most
one hundred lines, no untested caller, and no risk category. Otherwise use the higher range.

## Final report

Write one final report, not a running dump. Where wired, `wt-report-findings-check.mjs` checks
these five sections: **Implemented** (what and why), **Verification** (each executed check and
outcome), **Independent Review** (lenses, confirmed and refuted findings), **Decisions**
(fixed, partially addressed, rejected with justification, or routed to a named card), and **Remaining Risks** (unverified or
uncertain). Do not claim completion while omitting a failed or unexecuted mandatory check.
