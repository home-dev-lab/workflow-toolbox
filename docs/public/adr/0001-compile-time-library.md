# 1. Compile-time pattern library, not a runtime framework

Date: 2026-06-06

## Status

Accepted

## Context

The Dynamic Workflows sandbox bans `import`/`require` and all Node.js APIs.
`meta` must be the first statement of the script and a pure object literal.
Scripts are capped at 512 KB (the cap applies to the inline `script` parameter,
to `scriptPath` files — tool-layer rejection — and to `name` resolution by
*silent exclusion*: an oversized file is never registered, with no diagnostic).

A TypeScript library therefore cannot reach the runtime as an import. The only
bridge is a build artifact.

The alternative — staying with copy-paste templates in the authoring skill —
gives no type safety, no testable pattern logic, and no reuse guarantee: every
instantiation re-derives the pattern by hand, which is the exact failure mode
this toolkit exists to eliminate.

## Decision

The toolkit is **compile-time only**. Each workflow definition is a TypeScript
entry compiled by `workflow-toolbox build` (esbuild, `--format=iife --global-name=__wt`,
pinned `esbuild ~0.25.12` because the emitted shape is golden-tested) into one
self-contained `.js`:

1. `meta` is extracted at build time and **serialized** as the first statement
   (JSON-quoted keys are accepted by the runtime — verified live).
2. The bundled IIFE body follows.
3. A glue epilogue binds the ambient sandbox globals into a typed `rt` object
   and invokes `return await __wt.default.run(rt, args)` at top level.

The toolkit never reimplements anything the runtime owns: journal/resume,
concurrency caps, stall retries, budget enforcement, structured-output
validation, permission UI.

## Consequences

- Type safety, unit tests, and contracts live entirely at compile time; the
  runtime sandbox is untouched.
- The emitted artifact is plain readable JavaScript — what users review in
  permission dialogs and edit for `scriptPath` re-invocation. Build output
  defaults to unminified; `--minify` is an explicit escape hatch.
- Build output must be re-generated when sources change (see ADR
  [0002](0002-commit-built-artifacts.md) for why artifacts are committed).
- The emitter is itself linted: `workflow-toolbox build` runs the sandbox linter on its own
  output and refuses to write a non-conforming artifact.
