# 4. Explicit runtime parameter (`rt`), not ambient globals

Date: 2026-06-06

## Status

Accepted

## Context

Inside the sandbox, the runtime surface is ambient: `agent()`, `parallel()`,
`pipeline()`, `phase()`, `log()`, `budget`, `workflow()`, `args` are globals.
Pattern functions that read those ambients directly would be untestable
outside the sandbox and would couple every source file to an unstable,
largely undocumented surface.

## Decision

Every pattern and composition takes the runtime as an explicit first
parameter: `rt: WorkflowRuntime`. The ambient globals are bound into `rt`
exactly once, in the glue epilogue that `dwt build` emits around the bundle.

Two supporting choices:

- `@dwt/runtime` is the **only** package that names the sandbox surface
  (typings + `FakeRuntime`). If a Claude Code update changes the surface,
  exactly one package changes.
- The ambient declarations (`globals.d.ts`) live at the package root,
  *outside* `src/`, so the packages' own compilation never sees them — an
  accidental bare `agent(...)` call in library code is a type error, not a
  latent sandbox dependency.

## Consequences

- Patterns are pure functions, fully unit-testable against `FakeRuntime`
  (scripted deterministic agents; assertions on spawned-agent counts, phases,
  envelope stats, null handling).
- The unstable runtime surface is firewalled behind one package, re-verified
  on Claude Code upgrades.
- Mild verbosity (`rt.` prefix everywhere) — accepted as the price of
  explicit-over-magic.
