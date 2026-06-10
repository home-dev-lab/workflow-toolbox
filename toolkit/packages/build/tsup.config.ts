import { defineConfig } from 'tsup'

// Emits the published dist (ESM + .d.ts) for the three entry points:
//   - index           → the library surface
//   - define-workflow → the sandbox-pure `./define` subpath
//   - cli             → the `workflow-toolbox` command (shebang in cli.ts is auto-preserved
//                       and the output is chmod'd executable by tsup)
// `@workflow-toolbox/runtime` and `esbuild` are real dependencies and stay
// external (tsup auto-externalizes `dependencies`). The in-repo dev loop runs
// the TS sources via tsx/vitest (see the top-level `exports`); dist is selected
// at publish time only, through the `publishConfig` override.
export default defineConfig({
  entry: ['src/index.ts', 'src/define-workflow.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  tsconfig: 'tsconfig.build.json',
})
