import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const skillFenceTest = 'packages/build/test/opencode-skill-fence.integration.test.ts'
const include = [
  'packages/*/test/**/*.test.ts',
  'packages/*/src/**/*.test.ts',
  'examples/test/**/*.test.ts',
  'scripts/test/**/*.test.ts',
]
const commonTestConfig = {
  reporters: ['default'],
  // A few tests drive the real TypeScript compiler (ts.createProgram in
  // globals-typecheck, the `build --typecheck` path in cli-subcommands).
  // They take ~4s cold and spike past the 5s default under full-suite CPU
  // contention (WSL2 / CI), producing intermittent "Test timed out in 5000ms"
  // flakes. 20s gives comfortable margin while still bounding a true hang.
  testTimeout: 20_000,
  hookTimeout: 15_000,
  teardownTimeout: 15_000,
  // Guard-hook tests spawn real plugin/bin/*guard*.mjs processes; without a redirect they
  // journal into the operator's own ~/.local/state/wt-guard-journal (card
  // 1836526445-journal-testpollution — measured 670 junk records from one `pnpm test` run).
  // setupFiles makes the redirect the DEFAULT for every worker (fixes the 17 test files that
  // never named WT_GUARD_JOURNAL_DIR); globalSetup makes a REGRESSION of that default
  // mechanically fail the suite instead of silently reintroducing the leak. See both files'
  // own headers for why this is two layers, not one.
  setupFiles: ['./test-support/guard-journal-isolation.setup.ts'],
  globalSetup: ['./test-support/guard-journal-isolation.global-setup.ts'],
}

export default defineConfig({
  test: {
    // These cold-cache tests spawn real opencode processes. Keep them in the
    // ordinary gate, but start them only after the parallel files have drained.
    projects: [
      {
        test: {
          ...commonTestConfig,
          name: 'parallel',
          include,
          exclude: [skillFenceTest],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...commonTestConfig,
          name: 'skill-fence',
          include: [skillFenceTest],
          sequence: { groupOrder: 1 },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      allowExternal: true,
      reportOnFailure: true,
      reporter: ['text', 'json-summary'],
      reportsDirectory: '.lane/coverage',
      include: ['packages/*/src/**/*.ts', resolve(import.meta.dirname, '../plugin/bin/**/*.mjs')],
      exclude: [
        '**/*.test.ts',
        '**/test/**',
        '**/fixtures/**',
        '**/dist/**',
        '../plugin/bin/**/*fixture*',
      ],
      thresholds: {
        // ratchet 2026-09-17: one-hundredth below the observed floor across repeated runs;
        // process-isolated coverage varied by up to 0.02 points on the unchanged tree.
        lines: 41.99,
        branches: 40.11,
        functions: 44.47,
        statements: 40.61,
      },
    },
  },
})
