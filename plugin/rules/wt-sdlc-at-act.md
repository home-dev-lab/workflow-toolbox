# SDLC engineering protocol — at act

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
