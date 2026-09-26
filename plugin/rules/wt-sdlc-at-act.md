# wt-sdlc — at act

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
