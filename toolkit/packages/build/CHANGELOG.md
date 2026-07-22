# Changelog

All notable changes to `@workflow-toolbox/build` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.1] - 2026-07-21

### Added

- `defineWorkflow` now wires observer-consumer brief auto-injection: when a launch
  declares an inline `wt-comm` observer, the matched observed roles' prompts are
  suffixed with a reference to the consumer teaching pack (paired with the
  `@workflow-toolbox/runtime` change of the same name).
- `workflow-toolbox scaffold capabilities <spec.json>` — emit a workflow-owned
  `<name>.capabilities.json` sidecar of abstract capability needs, in parity with
  `scaffold observer`.
- `workflow-toolbox scaffold observer <spec.json>` — emit a validated
  `<name>.observer.json` observer definition from an authoring-time spec.
- Declarative `loop` block support in pipeline bundling (`bundlePipeline` / the
  `workflow-toolbox pipeline` CLI): a pipeline spec can re-run its stage list until a
  done-condition, with an optional human gate at each iteration boundary. The
  `@workflow-toolbox/pipeline-spec` types for it are bundled into this package's dist.

### Changed

- Declares `typescript` as an **optional** peerDependency, range `>=5 <7`. The
  `--typecheck` integration loads the consumer's own installed `typescript`; TypeScript 7's
  native-rewrite API breaks it, so the range pins to the proven 5.9/6.x line.
- The scaffold CLI subcommands' write-out path is consolidated into one shared
  per-mode helper, shared with the dev-tree scaffold entry point — no behavior
  change, byte-identical output.

### Deprecated

- **0.3.0** (published 2026-07-21) shipped with a stale prebuilt `dist/` bundle that
  predated this version's source — notably missing the observer-consumer brief
  injection above. Deprecated on the registry; use 0.3.1.

Earlier releases predate this changelog.
