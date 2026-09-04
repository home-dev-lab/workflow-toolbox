import { defineConfig } from 'tsup'

// Emits the published dist (ESM + .d.ts) for the four entry points:
//   - index           → the library surface
//   - define-workflow → the sandbox-pure `./define` subpath
//   - define-pipeline → the `./define-pipeline` subpath (I5) — NOT sandbox-pure (a pipeline
//                       spec is never bundled into a Workflow-sandbox artifact), but still a
//                       SEPARATE entry from root `.`: importing root pulls in bundle.ts +
//                       bundle-pipeline.ts's node:vm/node:path/esbuild imports, which
//                       `workflow-toolbox pipeline --typecheck`'s whole-program tsc pass would
//                       then also need Node types for — this subpath keeps a pipeline entry's
//                       typecheck graph limited to definePipeline + pipeline-spec (zero Node
//                       deps), exactly like `./define` does for workflow entries.
//   - cli             → the `workflow-toolbox` command (shebang in cli.ts is auto-preserved
//                       and the output is chmod'd executable by tsup)
// `@workflow-toolbox/runtime` and `esbuild` are real dependencies and stay
// external (tsup auto-externalizes `dependencies`). The in-repo dev loop runs
// the TS sources via tsx/vitest (see the top-level `exports`); dist is selected
// at publish time only, through the `publishConfig` override.
//
// RESOLVED 2026-08-18 (was: KNOWN GAP I5). The gap this block described — dist/index.d.ts
// emitting a bare `import { PipelineSpec } from '@workflow-toolbox/pipeline-spec'`, unresolvable
// for an npm consumer — is fixed, and the premise it rested on had retired: pipeline-spec is
// PUBLISHED (0.1.0, 0.2.0) and ships a real dist/index.d.ts declaring the type. It is now a
// runtime `dependency`, so tsup externalizes it and a consumer resolves it from the registry.
// @workflow-toolbox/patterns had the same defect one layer down — a bare import surviving in
// dist/cli.js — and is declared for the same reason.
//
// ⚠ The old text said `dts: { resolve: true }` had been tried and failed. That remains true and is
// now moot: nothing needs inlining once the package is a real dependency.
//
// ⚠ THE LESSON, kept because it cost an afternoon: this comment was accurate when written and
// asserted a retired fact afterwards. `cli-bundle-smoke.test.ts` encoded the same stale premise in
// its own title, went red on the CORRECT fix, and the fix was reverted on its verdict. A test is a
// claim about the world made when it was written. Its list is now DERIVED — anything not declared
// as a runtime dependency must be inlined — so it cannot rot the same way again.
//
// ⚠ The criterion is the DEPENDENCY EDGE, not the registry: @workflow-toolbox/std is published and
// must still be inlined here, because build does not depend on it and a consumer therefore has none.

export default defineConfig({
  entry: ['src/index.ts', 'src/define-workflow.ts', 'src/define-pipeline.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  tsconfig: 'tsconfig.build.json',
})
