import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { spawningTestFiles } from './scripts/spawning-test-files.mjs'

const configuredMaxWorkers = process.env.WT_VITEST_MAX_WORKERS
  ? Number(process.env.WT_VITEST_MAX_WORKERS)
  : process.platform === 'darwin' ? 2 : undefined
if (configuredMaxWorkers !== undefined && (!Number.isInteger(configuredMaxWorkers) || configuredMaxWorkers < 1)) {
  throw new Error('WT_VITEST_MAX_WORKERS must be a positive integer')
}
const include = [
  'packages/*/test/**/*.test.ts',
  'packages/*/src/**/*.test.ts',
  'examples/test/**/*.test.ts',
  'scripts/test/**/*.test.ts',
]
const commonTestConfig = {
  reporters: ['default'],
  // macos-latest has three vCPUs. Two workers leave one core available for the runner agent
  // while preserving file parallelism; other hosts retain Vitest's default worker count.
  ...(configuredMaxWorkers === undefined ? {} : { maxWorkers: configuredMaxWorkers }),
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
  setupFiles: [
    './test-support/guard-journal-isolation.setup.ts',
    './test-support/child-process-coverage.setup.ts',
  ],
  globalSetup: ['./test-support/guard-journal-isolation.global-setup.ts'],
}

export default defineConfig({
  test: {
    // Real child processes share a small pool, so their timeout measures execution
    // rather than time queued behind the ordinary parallel population.
    projects: [
      {
        test: {
          ...commonTestConfig,
          name: 'parallel',
          include,
          exclude: spawningTestFiles,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...commonTestConfig,
          name: 'process-spawning',
          include: spawningTestFiles,
          maxWorkers: configuredMaxWorkers === undefined ? 2 : Math.min(2, configuredMaxWorkers),
          sequence: { groupOrder: 1 },
        },
      },
    ],
    coverage: {
      provider: 'custom',
      customProviderModule: './scripts/child-process-coverage-provider.mjs',
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
        // ratchet 2026-09-18: 0.3 points below the child-process-aware observed floor
        // (76.69 / 67.81 / 77.85 / 73.91). A threshold pinned at the exact floor fails on the first timed-out or
        // skipped test (one 30 s fs.watch timeout moved functions by 0.04 and branches by 0.01);
        // the margin absorbs one such flake, never a real regression, which lands whole points.
        // Real improvement is judged by scripts/quality.mjs against quality-baseline.json, not here.
        lines: 76.3,
        branches: 67.5,
        functions: 77.5,
        statements: 73.6,
      },
    },
  },
})
