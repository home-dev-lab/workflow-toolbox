#!/usr/bin/env node
// cli.ts — `dwt` command-line interface for @workflow-toolbox/build.
//
// In-repo this runs as TS via tsx (the pnpm scripts below). For npm consumers
// the published package exposes it as the `dwt` bin (compiled to dist/cli.js by
// tsup, which preserves this shebang and chmods the output) — see
// `publishConfig.bin`. The shebang is an inert comment under tsx, so the dev
// scripts keep working unchanged. Primary form, from the workspace root
// (toolkit/), where the default out-dir `workflows/` resolves correctly:
//   pnpm dwt:build <entry.ts> [--out-dir <dir>] [--minify]
//   pnpm dwt:check <file.js>
// Also supported: `pnpm dwt …` from this package, or `pnpm -F @workflow-toolbox/build
// dwt …` from the root (cwd is packages/build/ — paths need ../../).
//
// Structured as a thin exported main(argv) for testability plus an
// import.meta.url guard for direct invocation via:
//   pnpm exec tsx src/cli.ts build ...
//
// NOTE: The output filename is `<meta.name>.js` (not the entry filename).
// The Claude Code runtime registry is keyed by meta.name — using the source
// filename would cause a mismatch if the file is renamed.

import { parseArgs } from 'node:util'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleWorkflow } from './bundle.js'
import { lintWorkflowSource } from './lint.js'

// ---------------------------------------------------------------------------
// main — exported for tests; thin wrapper over the two subcommands
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const command = argv[0]

  if (command === 'build') {
    return runBuild(argv.slice(1))
  }
  if (command === 'check') {
    return runCheck(argv.slice(1))
  }

  // Unknown or missing command
  printUsage()
  throw new Error(`dwt: unknown command ${JSON.stringify(command ?? '(none)')} — see usage above`)
}

// ---------------------------------------------------------------------------
// runBuild — bundle an entry workflow file
// ---------------------------------------------------------------------------

async function runBuild(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'out-dir': { type: 'string', short: 'o' },
      minify: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  })

  const entry = positionals[0]
  if (entry === undefined || entry === '') {
    printUsage()
    throw new Error('dwt build: missing <entry.ts> positional argument')
  }

  // Resolve entry to absolute path so esbuild always gets an absolute path
  const absEntry = path.resolve(entry)

  // Default out-dir: 'workflows' relative to cwd
  const outDir = path.resolve(values['out-dir'] ?? 'workflows')

  // Bundle the workflow
  const result = await bundleWorkflow({ entry: absEntry, minify: values.minify })

  // Defense-in-depth lint: lintWorkflowSource on the emitted code.
  // This should never fire (bundleWorkflow already validates meta). If it does,
  // it means the emitter has a bug — surface it loudly before writing the file.
  const lint = lintWorkflowSource(result.code)
  if (lint.errors.length > 0) {
    throw new Error(
      `dwt build: emitted artifact has lint errors (this is a bundler bug — please report):\n`
      + lint.errors.map(e => `  ERROR: ${e}`).join('\n'),
    )
  }

  // Print any lint warnings (e.g. size warnings from the lint pass)
  for (const w of lint.warnings) {
    console.warn(`  warn: ${w}`)
  }
  // Print any bundler warnings (e.g. size-approaching-limit)
  for (const w of result.warnings) {
    console.warn(`  warn: ${w}`)
  }

  // mkdir -p outDir
  fs.mkdirSync(outDir, { recursive: true })

  // Write <outDir>/<meta.name>.js — OVERWRITES silently (rebuild-in-place is
  // the normal edit loop; built artifacts are derived files, never the source
  // of truth). meta.name is kebab-validated by defineWorkflow, so it cannot
  // contain path separators or `..` — no traversal via the filename.
  // Filename = meta.name (not entry filename) — the runtime registry is keyed
  // by meta.name; using the source filename would break on renames.
  const outFile = path.join(outDir, `${result.meta.name}.js`)
  fs.writeFileSync(outFile, result.code, 'utf8')

  console.log(`dwt build: wrote ${outFile} (${result.bytes} bytes)`)
}

// ---------------------------------------------------------------------------
// runCheck — lint an already-built .js artifact
// ---------------------------------------------------------------------------

async function runCheck(argv: string[]): Promise<void> {
  const file = argv[0]
  if (file === undefined || file === '') {
    printUsage()
    throw new Error('dwt check: missing <file.js> positional argument')
  }

  const absFile = path.resolve(file)
  const src = fs.readFileSync(absFile, 'utf8')
  const lint = lintWorkflowSource(src)

  for (const w of lint.warnings) {
    console.log(`  warn: ${w}`)
  }
  for (const e of lint.errors) {
    console.error(`  ERROR: ${e}`)
  }

  if (lint.errors.length > 0) {
    console.error(
      `dwt check: ${lint.errors.length} error(s), ${lint.warnings.length} warning(s) in ${absFile}`,
    )
    throw new Error(`dwt check: ${lint.errors.length} error(s) found — see above`)
  }

  // errors === 0 here, so "no issues" reduces to "no warnings"
  console.log(
    `dwt check: ok — ${lint.warnings.length === 0 ? 'no issues' : `${lint.warnings.length} warning(s)`} in ${absFile}`,
  )
}

// ---------------------------------------------------------------------------
// printUsage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
dwt — Workflow Toolbox build CLI

Usage (via pnpm scripts — no global dwt binary; run from the workspace root):
  pnpm dwt:build <entry.ts> [--out-dir <dir>] [--minify]
  pnpm dwt:check <file.js>

Commands:
  build   Bundle a TypeScript workflow entry file to a self-contained .js artifact.
          Output filename is <meta.name>.js in --out-dir (default: workflows/).
          An existing artifact with the same name is overwritten.
          The runtime registry is keyed by meta.name, NOT the filename.

  check   Lint an already-built workflow artifact with lintWorkflowSource.
          Exits 1 if any errors are found.

Options:
  --out-dir, -o  Output directory (default: workflows/ relative to cwd)
  --minify       Enable whitespace + syntax minification (never minifies identifiers)
`.trim())
}

// ---------------------------------------------------------------------------
// Entry point guard — run main() when invoked directly via tsx/node
// ---------------------------------------------------------------------------

// process.argv[1] can be a bin symlink (e.g. node_modules/.bin/dwt) while
// import.meta.url resolves to the module's realpath — so compare REALPATHS. A
// naive URL/path compare silently no-ops when invoked through the installed
// `dwt` bin symlink (argv[1] = the symlink, import.meta.url = its target). This
// guard must fire for `tsx src/cli.ts`, `node dist/cli.js`, AND the bin symlink.
const isMain = (() => {
  try {
    const argvPath = process.argv[1]
    if (!argvPath) return false
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(argvPath)
  } catch {
    return false
  }
})()

if (isMain) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    // Errors from subcommands are already printed; just set the exit code.
    const msg = err instanceof Error ? err.message : String(err)
    // Only print if the message doesn't look like something already printed
    if (!msg.startsWith('dwt ')) {
      console.error(msg)
    }
    process.exit(1)
  })
}
