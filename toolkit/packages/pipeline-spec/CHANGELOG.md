# Changelog

All notable changes to `@workflow-toolbox/pipeline-spec` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-07-22

### Added

- Declarative `loop` block: a pipeline spec can re-run its stage list until a
  done-condition, decided at each iteration boundary. `{ gate: true }` adds a human
  loop gate at every iteration boundary (on top of any `gateAfter` inside the body,
  which re-arms per iteration). Loops nest independently: a pipeline-stage inside a
  looped body mints a fresh child pipeline per iteration.

## [0.1.0] - 2026-07-12

Initial published release.
