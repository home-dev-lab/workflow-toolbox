# Changelog

All notable changes to `@workflow-toolbox/patterns` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.7.1] - 2026-07-21

### Added

- `chunkedAnalysis` — a new pattern: deterministic chunked map-analyze + synthesis over a
  large input, sized by `maxChars`.
- Per-invocation `stageKey` salting plus shared stage/label constants, so repeated calls
  to the same pattern within one run stay distinguishable in the digest/journal.
- Per-task worker-effort auto-selection (a three-tier form) for fan-out patterns.
- `untrusted()` / `renderSourceRefs()` prompt-fencing helpers, extracted for reuse across
  patterns that interpolate external content into a prompt.
- `workflow-toolbox:lean` agentType support for pure-reasoning fan-out roles (classify,
  vote/judge, score, dedup, synthesize) that never need a tool — strips the ambient
  tool/skill/MCP injection every default subagent otherwise pays for.
- A provenance gate on `adversarialVerification`'s externally-sourced verifier votes
  (a cross-family verifier's vote must carry provenance to count).
- Deterministic structured-output salvage: an agent that exhausts its StructuredOutput
  retries now gets diagnostics and a repair pass instead of silently degrading to `null`
  — including the no-StructuredOutput-tool-offered case, not just the null-degrade case.
- `TypedPhaseDigest`/digest emission now carries the caller's `phase` through (paired
  with the `@workflow-toolbox/runtime` change of the same name).

### Changed

- **Breaking:** `cacheWarm` now defaults to `true` (previously opt-in) — fan-out patterns
  stagger their first calls by default to reduce cold-cache thundering-herd latency; pass
  `cacheWarm: false` to opt back out.
- Toolkit-spawned leaf agents deny `SendMessage` by default (`workflow-toolbox:leaf`), so
  a fresh-context task executor has no inter-agent channel unless explicitly opted in.

### Fixed

- The lean/leaf agentType probe now uses a local prompt instead of one that demanded an
  external CLI, which had made every lean-routing probe fail on a machine without that
  CLI installed.
- Leaf-fence hardening: the probe now honors `perAgent` overrides and fails open loudly
  rather than silently.
- Bundle-review hardening: tournament salvage wiring, triage hardening, and a loud
  (rather than silent) degrade when the working directory can't be determined.
- A review-round fix set: numeric `stageKey` reservation, the canonical key-rule made
  consistent with its documentation, and a missed digest skip on the Fix path.

### Deprecated

- **0.7.0** (published 2026-07-21) shipped with a stale prebuilt `dist/` bundle that
  predated this version's source — notably missing the provenance gate above. Deprecated
  on the registry; use 0.7.1.

Earlier releases predate this changelog.
