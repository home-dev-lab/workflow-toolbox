import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// The svelte() plugin lets a *.test.ts import a .svelte file directly (compiled in SSR mode
// under Vitest's Node environment) — added for observe-ui's markdown-renderer security tests
// (card #1811902116185245578, increment 2), which render Markdown.svelte via `svelte/server`'s
// `render()` and assert on the produced HTML STRING (no jsdom / @testing-library — the repo had
// no prior component-test pattern to follow, and a source-string SSR check is enough to pin the
// zero-{@html} / neutralized-anchor/image invariants these tests exist to catch). A no-op for
// every other package here (it only transforms files it's given, i.e. *.svelte).
export default defineConfig({
  plugins: [svelte()],
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/*/server/**/*.test.ts',
      'examples/test/**/*.test.ts',
    ],
    // A few tests drive the real TypeScript compiler (ts.createProgram in
    // globals-typecheck, the `build --typecheck` path in cli-subcommands).
    // They take ~4s cold and spike past the 5s default under full-suite CPU
    // contention (WSL2 / CI), producing intermittent "Test timed out in 5000ms"
    // flakes. 20s gives comfortable margin while still bounding a true hang.
    testTimeout: 20_000,
  },
})
