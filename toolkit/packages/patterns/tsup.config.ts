import { defineConfig } from 'tsup'

// Emits the published dist (ESM + .d.ts). `@workflow-toolbox/runtime` is a real
// dependency and stays external (tsup auto-externalizes `dependencies`), so the
// emitted .d.ts references it rather than inlining it. The in-repo dev loop
// consumes raw `./src/*.ts` (see the top-level `exports`); dist is publish-only.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  tsconfig: 'tsconfig.build.json',
})
