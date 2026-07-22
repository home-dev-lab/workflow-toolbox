# Changelog

All notable changes to `@workflow-toolbox/runtime` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.1] - 2026-07-21

### Added

- Observer-consumer brief auto-injection: when a workflow built with
  `@workflow-toolbox/build`'s `defineWorkflow` declares an inline `wt-comm` observer at
  launch, matched observed roles now receive a prompt section referencing the observer
  consumer teaching pack, so they know to consult delivered hints at natural boundaries.
- `PhaseDigest`/`TypedPhaseDigest` carry the caller's `phase` through to every emitted
  digest (previously only the emitting pattern's `stage` was guaranteed), giving a
  digest consumer a direct phase-resolution hint instead of relying solely on
  label-prefix matching.
- Digest vocabulary support for the `chunkedAnalysis` pattern's counts shape.

### Fixed

- `parseDigest` now drops a `counts` record containing a negative value instead of
  accepting it — every legitimate producer emits non-negative counts by construction, so
  a negative can only come from a corrupted or hand-edited journal line.

### Deprecated

- **0.2.0** (published 2026-07-21) shipped with a stale prebuilt `dist/` bundle that
  predated this version's source — notably missing the observer-consumer brief
  injection above. Deprecated on the registry; use 0.2.1.

Earlier releases predate this changelog.
