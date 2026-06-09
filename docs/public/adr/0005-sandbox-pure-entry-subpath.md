# 5. Sandbox-pure entry subpath: `@workflow-toolbox/build/define`

Date: 2026-06-06

## Status

Accepted

## Context

Workflow entry files need `defineWorkflow`, which lives in `@workflow-toolbox/build`. But
the package root (`@workflow-toolbox/build`) also re-exports the bundler (`bundleWorkflow`,
the linter), which imports `node:vm`, `node:fs`, and esbuild. esbuild bundles
workflow entries as **platform-neutral** (the sandbox has no Node APIs), and
module resolution happens *before* tree-shaking — so an entry importing
`defineWorkflow` from the package root fails the build with a cryptic
`Could not resolve "node:vm"` error, even though nothing Node-flavored is
actually used.

This was discovered the first time real examples were built. Earlier test
fixtures masked the trap because they imported `define-workflow.ts` by
relative path.

## Decision

Add a sandbox-pure subpath export:

```jsonc
// @workflow-toolbox/build package.json
"exports": {
  ".":        { "import": "./src/index.ts" },          // CLI/bundler surface (Node-side)
  "./define": { "import": "./src/define-workflow.ts" } // entry surface (sandbox-pure)
}
```

Workflow entries MUST import from `@workflow-toolbox/build/define`, never from
`@workflow-toolbox/build`. Enforcement is layered:

1. Convention, documented in the toolkit README and the `@workflow-toolbox/build` index
   header.
2. A build-time pre-flight: `bundleWorkflow` reads the entry source and
   rejects any `from '@workflow-toolbox/build'` import with an actionable error that names
   the correct subpath (regression-tested via a negative fixture).

## Consequences

- The foot-gun is fenced at two layers; the failure message states the fix
  instead of surfacing esbuild internals.
- The package root remains the natural surface for Node-side tooling (the
  `dwt` CLI, tests, future SDK smoke runners).
- Anything exported from `./define` must stay transitively free of Node
  imports — it can only depend on `@workflow-toolbox/runtime` types.
