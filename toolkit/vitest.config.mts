import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'examples/test/**/*.test.ts',
      'scripts/test/**/*.test.ts',
    ],
    // A few tests drive the real TypeScript compiler (ts.createProgram in
    // globals-typecheck, the `build --typecheck` path in cli-subcommands).
    // They take ~4s cold and spike past the 5s default under full-suite CPU
    // contention (WSL2 / CI), producing intermittent "Test timed out in 5000ms"
    // flakes. 20s gives comfortable margin while still bounding a true hang.
    testTimeout: 20_000,
  },
})
