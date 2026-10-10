# SDLC engineering protocol

This protocol binds whoever changes code: a main session working directly, a pilot, and an
executor. No session-mode exemption. Every non-trivial change has a tracker card before its
first edit; otherwise the work and its review are invisible.

Its act-bound half is `wt-sdlc-at-act.md`, loaded alongside this file or served on demand where
an engine is installed.

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

## Implement and verify

Run the applicable build, type, lint, format, test, integration, static-analysis, and end-to-end
checks. Record each by exit code. Never claim a check passed unless it ran; an unrunnable check
remains explicitly unresolved. Warnings introduced by the change are failures unless justified.

## Revise only blocking critic findings

Revise only for the blocking findings. Keep every previously accepted part unchanged. Do not
restart the plan from scratch. For each blocking finding, state what changed.

## E2E

Every brief carries the e2e in its definition of done. Every card where an end-to-end check is
possible gets one that runs against real data and real sources, is repeatable with a script or
written procedure, and has its output pasted verbatim into the report. A delivery without the
required output says `e2e not run` with a reason instead of being presented as ready.

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
