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
    // Guard-hook tests spawn real plugin/bin/*guard*.mjs processes; without a redirect they
    // journal into the operator's own ~/.local/state/wt-guard-journal (card
    // 1836526445-journal-testpollution — measured 670 junk records from one `pnpm test` run).
    // setupFiles makes the redirect the DEFAULT for every worker (fixes the 17 test files that
    // never named WT_GUARD_JOURNAL_DIR); globalSetup makes a REGRESSION of that default
    // mechanically fail the suite instead of silently reintroducing the leak. See both files'
    // own headers for why this is two layers, not one.
    setupFiles: ['./test-support/guard-journal-isolation.setup.ts'],
    globalSetup: ['./test-support/guard-journal-isolation.global-setup.ts'],
  },
})
