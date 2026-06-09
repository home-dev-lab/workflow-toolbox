// Bundles the debugger's shipped node CLIs into self-contained, zero-dependency node ESM
// artifacts, each written byte-identically to BOTH toolkit/bin/ (source of truth) and
// plugin/bin/ (what ships). Run by hand at ship time — `pnpm debugger:build`. The
// byte-identity between the two locations is enforced by a test.
//
// Two entries:
//   cli.ts       → dwt-debug.mjs       — the `dwt:debug` diagnose CLI.
//   stop-hook.ts → dwt-stop-hook.mjs   — the plugin's Stop hook (auto-surfaces the audit report).
//
// Unlike `dwt:build` (which emits an IIFE for the Workflow SANDBOX), this targets a plain
// node CLI: platform:node, format:esm, a cosmetic shebang. Both use only node builtins
// (fs/os/path/process), so each bundle pulls in zero npm deps and is deterministic.

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url)) // toolkit/packages/debugger
const toolkitRoot = join(here, '..', '..') // toolkit
const repoRoot = join(toolkitRoot, '..') // repo root

const entries = [
  { entry: 'cli.ts', out: 'dwt-debug.mjs' },
  { entry: 'stop-hook.ts', out: 'dwt-stop-hook.mjs' },
]

for (const { entry, out } of entries) {
  const result = await build({
    entryPoints: [join(here, 'src', entry)],
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
  const text = output.text

  const targets = [join(toolkitRoot, 'bin', out), join(repoRoot, 'plugin', 'bin', out)]
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text)
    process.stdout.write(`[debugger:build] wrote ${target} (${text.length} bytes)\n`)
  }
}
