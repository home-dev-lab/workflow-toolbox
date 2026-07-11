// Writes the debugger's shipped node CLIs to disk, byte-identically, to BOTH toolkit/bin/
// (source of truth) and plugin/bin/ (what ships). Run by hand at ship time — `pnpm debugger:build`.
//
//   cli.ts       → wt-debug.mjs       — the `wt:debug` diagnose CLI.
//   stop-hook.ts → wt-stop-hook.mjs   — the plugin's Stop hook (auto-surfaces the audit report).
//
// The bundling itself lives in build-bundles.ts (side-effect-free, shared with the freshness
// gate); this file is ONLY the writer. Two independent gates protect the committed bins:
//   - integrity.test.ts     — toolkit/bin ↔ plugin/bin are byte-identical.
//   - build-freshness.test.ts — the committed bins are in sync with their TypeScript source.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

import { buildDebuggerBundles } from './build-bundles.js'

const here = dirname(fileURLToPath(import.meta.url)) // toolkit/packages/debugger
const toolkitRoot = join(here, '..', '..') // toolkit
const repoRoot = join(toolkitRoot, '..') // repo root

for (const { out, text } of await buildDebuggerBundles()) {
  const targets = [join(toolkitRoot, 'bin', out), join(repoRoot, 'plugin', 'bin', out)]
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
    process.stdout.write(`[debugger:build] wrote ${target} (${text.length} bytes)\n`)
  }
}
