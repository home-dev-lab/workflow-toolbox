import { defineConfig } from 'tsup'

// Emits the published dist (ESM + .d.ts). The in-repo dev loop does NOT use this
// — it consumes the raw `./src/*.ts` via tsx/vitest (see the top-level `exports`).
// dist is selected at publish time only, via the `publishConfig` override.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'node20',
  tsconfig: 'tsconfig.build.json',
})
