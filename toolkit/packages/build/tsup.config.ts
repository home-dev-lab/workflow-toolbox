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
// KNOWN GAP (I5, not fixed here — no current gate covers it): tsup's JS bundling already
// inlines every devDependency's CODE (verified by cli-bundle-smoke.test.ts) — but the separate
// .d.ts bundling step (rollup-plugin-dts) does NOT inline @workflow-toolbox/pipeline-spec's
// TYPES the same way; dist/index.d.ts still emits a bare
// `import { PipelineSpec } from '@workflow-toolbox/pipeline-spec'`, unresolvable for a real npm
// consumer (pipeline-spec is never published). Tried `dts: { resolve: true }` and two targeted
// forms (string, RegExp) — none inlined it, likely because pipeline-spec ships its TYPES as
// plain .ts source (package.json `"types": "./src/index.ts"`, no real .d.ts) rather than a
// pre-compiled declaration file rollup-plugin-dts's resolver expects. definePipeline is the
// FIRST public export whose type originates from a private devDependency, so this is the first
// time the gap matters (WorkflowMeta/BundleResult/etc. never referenced one). Only bites at an
// ACTUAL `npm publish` of @workflow-toolbox/build (out of scope here — no publish this
// increment); flagged for arbitration: publish pipeline-spec as a real 4th package (build's
// own dependency, matching @workflow-toolbox/runtime's treatment), or find a working
// dts-inlining mechanism (@microsoft/api-extractor's --experimental-dts, or pre-building
// pipeline-spec's own .d.ts via tsc first).
export default defineConfig({
  entry: ['src/index.ts', 'src/define-workflow.ts', 'src/define-pipeline.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  tsconfig: 'tsconfig.build.json',
})
