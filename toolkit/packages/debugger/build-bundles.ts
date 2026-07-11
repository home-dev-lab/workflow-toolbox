// Pure, side-effect-free bundling of the debugger's shipped node CLIs. The ship-time writer
// (build.ts) and the freshness gate (test/build-freshness.test.ts) BOTH call this, so the
// esbuild config lives in ONE place — a committed bin/*.mjs can't silently drift from source.
//
// absWorkingDir is pinned to toolkitRoot on purpose: esbuild writes module-path comments
// relative to its working directory, so left at the default (process cwd) the same entry built
// from two cwds emits different bytes (the vitest cwd ≠ `pnpm debugger:build`'s cwd), yielding a
// false freshness failure. toolkitRoot anchoring reproduces the committed bytes exactly (their
// comments are `// packages/debugger/src/…`, i.e. relative to toolkit/) AND makes the rebuild
// invocation-independent. Mirrors bundle.ts's fix for the workflow artifacts (ADR 0002).

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url)) // toolkit/packages/debugger
const toolkitRoot = join(here, '..', '..') // toolkit

// The single source of truth for what CLIs ship: each src entry → its emitted artifact name.
// `as const` freezes it (mirrors SANDBOX_GLOBAL_NAMES in build/src/bundle.ts) so no consumer can
// mutate the shared reference. BOTH test gates derive from it — build-freshness.test.ts (source
// drift) and integrity.test.ts (toolkit/bin ↔ plugin/bin twin) — so "single source of truth" is
// enforced, not just asserted: adding a CLI here wires up every gate with no parallel list to sync.
export const DEBUGGER_ENTRIES = [
  { entry: 'cli.ts', out: 'wt-debug.mjs' },
  { entry: 'stop-hook.ts', out: 'wt-stop-hook.mjs' },
  { entry: 'observe-cli.ts', out: 'wt-observe.mjs' },
] as const

export interface DebuggerBundle {
  /** Artifact filename, e.g. `wt-stop-hook.mjs`. */
  out: string
  /** The bundled, zero-dependency node ESM source. */
  text: string
}

/**
 * Bundle every debugger CLI in memory (no disk writes). Deterministic for a given esbuild
 * version + config + source — the property the freshness gate and the byte-identity twin rely on.
 */
export async function buildDebuggerBundles(): Promise<DebuggerBundle[]> {
  const bundles: DebuggerBundle[] = []
  for (const { entry, out } of DEBUGGER_ENTRIES) {
    const result = await build({
      entryPoints: [join(here, 'src', entry)],
      absWorkingDir: toolkitRoot,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'es2022',
      banner: { js: '#!/usr/bin/env node' },
      legalComments: 'none',
      write: false,
      logLevel: 'silent',
    })
    const output = result.outputFiles[0]
    if (!output) throw new Error(`debugger build: esbuild produced no output for ${entry}`)
    bundles.push({ out, text: output.text })
  }
  return bundles
}
