// build-freshness.test.ts — rebuild-byte-identity gate over the committed debugger bins.
//
// integrity.test.ts guards toolkit/bin ↔ plugin/bin (the two copies agree), but nothing
// verified the committed bins are in sync with their TypeScript SOURCE. The
// `pnpm test && pnpm typecheck && pnpm lint` gate never runs `debugger:build`, so a change to
// stop-hook.ts / stop-state.ts / cli.ts (or anything they pull in) with NO rebuild leaves a
// STALE bundle — and every test, including stop-hook.integration.test.ts which drives the
// committed bundle, would pass against the OLD code. This closes that gap: every committed
// bin/*.mjs must rebuild byte-identically from source. Mirrors artifact-identity.test.ts.
//
// Two assertions, a true mirror of artifact-identity.test.ts: (1) SET-EQUALITY — the committed
// toolkit/bin/*.mjs set is exactly the rebuilt set (an extra file is an orphan left behind after a
// CLI is retired, since build.ts only writes, never prunes; a missing one is an unbuilt entry);
// (2) BYTE-IDENTITY — each committed bin equals its in-memory rebuild (catches source drift).
//
// Only toolkit/bin is enumerated: integrity.test.ts pins plugin/bin == toolkit/bin AND now derives
// its own bin list from the same DEBUGGER_ENTRIES, so both properties cover the shipped copy too.
//
// Remedy on failure: `pnpm debugger:build` (from toolkit/), then commit the regenerated bins.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { buildDebuggerBundles } from '../build-bundles.js'

const here = dirname(fileURLToPath(import.meta.url)) // packages/debugger/test
const toolkitRoot = join(here, '..', '..', '..') // toolkit
const BIN_DIR = join(toolkitRoot, 'bin')

describe('committed debugger bins — rebuild byte-identity', () => {
  it(
    'the committed bin/*.mjs set matches, and each is the byte-identical rebuild of its source',
    async () => {
      const bundles = await buildDebuggerBundles()
      // Guard against a vacuous pass if the entry list were ever emptied.
      expect(bundles.length).toBeGreaterThan(0)

      // Set-equality first: the committed bin/*.mjs set must be exactly the rebuilt set. An extra
      // committed .mjs is an orphan (a retired CLI whose bundle was never pruned); a missing one is
      // an unbuilt entry. Sorting makes the compare order-independent.
      const committedBins = readdirSync(BIN_DIR)
        .filter((f) => f.endsWith('.mjs'))
        .sort()
      const rebuiltBins = bundles.map((b) => b.out).sort()
      expect(
        committedBins,
        'bin/*.mjs set drifted from DEBUGGER_ENTRIES (orphan or missing bundle) — run `pnpm debugger:build`',
      ).toEqual(rebuiltBins)

      for (const { out, text } of bundles) {
        const committed = readFileSync(join(BIN_DIR, out), 'utf8')
        // Boolean compare on purpose — a string-diff over a bundled artifact is
        // noise; the remedy is a rebuild, not a manual edit.
        expect(
          committed === text,
          `${out} is stale — regenerate it with: pnpm debugger:build`,
        ).toBe(true)
      }
    },
    120_000,
  )
})
