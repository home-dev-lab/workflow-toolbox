# wt-sdlc-at-act - rationale and field cases

The operative directive lives in `plugin/rules/wt-sdlc-at-act.md`.

## Real sources expose integration failures

Fixture-only checks can stay green while the delivered path misreads the host's actual files,
processes, state, or rendered interface. A repeatable check against those real sources distinguishes
unit-level confidence from evidence that the user-facing integration works.
