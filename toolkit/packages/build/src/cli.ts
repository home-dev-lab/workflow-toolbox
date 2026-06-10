#!/usr/bin/env node
// cli.ts — `workflow-toolbox` command-line interface for @workflow-toolbox/build.
//
// In-repo this runs as TS via tsx (the pnpm scripts below). For npm consumers
// the published package exposes it as the `workflow-toolbox` bin (compiled to dist/cli.js by
// tsup, which preserves this shebang and chmods the output) — see
// `publishConfig.bin`. The shebang is an inert comment under tsx, so the dev
// scripts keep working unchanged. Primary form, from the workspace root
// (toolkit/), where the default out-dir `workflows/` resolves correctly:
//   pnpm wt:build <entry.ts> [--out-dir <dir>] [--minify]
//   pnpm wt:check <file.js>
// Also supported: `pnpm wt …` from this package, or `pnpm -F @workflow-toolbox/build
// wt …` from the root (cwd is packages/build/ — paths need ../../).
//
// Structured as a thin exported main(argv) for testability plus an
// import.meta.url guard for direct invocation via:
//   pnpm exec tsx src/cli.ts build ...
//
// NOTE: The output filename is `<meta.name>.js` (not the entry filename).
// The Claude Code runtime registry is keyed by meta.name — using the source
// filename would cause a mismatch if the file is renamed.

import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundleWorkflow } from './bundle.js'
import { lintWorkflowSource } from './lint.js'
// The packages below are PRIVATE workspace devDependencies: tsup inlines them
// into dist/cli.js (verified — no bare imports survive in the bundle), so the
// published package stays self-contained without publishing them to npm.
import { scaffoldWorkflow, MINIMAL_TSCONFIG } from '@workflow-toolbox/scaffold'
import {
  parseJournal,
  agentEvents,
  diagnoseRun,
  formatDiagnosis,
  buildAuditReport,
  formatAuditReportMarkdown,
} from '@workflow-toolbox/debugger'
import {
  findJournal,
  journalLookupErrorMessage,
  projectDirFor,
  transcriptDirFor,
} from '@workflow-toolbox/debugger/source'
import { loadSpec } from '@workflow-toolbox/scaffold/spec-io'
import { resolveLogDir, writeAuditFolder, scanTranscripts } from '@workflow-toolbox/debugger/audit-folder'
import { parseDebugArgs, parseReportArgs } from '@workflow-toolbox/debugger/cli-args'

// ---------------------------------------------------------------------------
// main — exported for tests; thin wrapper over the subcommands
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const command = argv[0]

  if (command === 'build') {
    return runBuild(argv.slice(1))
  }
  if (command === 'check') {
    return runCheck(argv.slice(1))
  }
  if (command === 'scaffold') {
    return runScaffold(argv.slice(1))
  }
  if (command === 'debug') {
    return runDebug(argv.slice(1))
  }
  if (command === 'report') {
    return runReport(argv.slice(1))
  }

  // Unknown or missing command
  printUsage()
  throw new Error(`workflow-toolbox: unknown command ${JSON.stringify(command ?? '(none)')} — see usage above`)
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
      typecheck: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  })

  const entry = positionals[0]
  if (entry === undefined || entry === '') {
    printUsage()
    throw new Error('workflow-toolbox build: missing <entry.ts> positional argument')
  }

  // Resolve entry to absolute path so esbuild always gets an absolute path
  const absEntry = path.resolve(entry)

  // Default out-dir: 'workflows' relative to cwd
  const outDir = path.resolve(values['out-dir'] ?? 'workflows')

  // Optional typecheck BEFORE bundling: esbuild strips types without checking,
  // so a plausible-but-wrong option name ships happily and fails at runtime in
  // the sandbox — far from the source. Runs the CONSUMER's typescript.
  if (values.typecheck) {
    await typecheckEntry(absEntry)
  }

  // Bundle the workflow
  const result = await bundleWorkflow({ entry: absEntry, minify: values.minify })

  // Defense-in-depth lint: lintWorkflowSource on the emitted code.
  // This should never fire (bundleWorkflow already validates meta). If it does,
  // it means the emitter has a bug — surface it loudly before writing the file.
  const lint = lintWorkflowSource(result.code)
  if (lint.errors.length > 0) {
    throw new Error(
      `workflow-toolbox build: emitted artifact has lint errors (this is a bundler bug — please report):\n`
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

  console.log(`workflow-toolbox build: wrote ${outFile} (${result.bytes} bytes)`)
}

// ---------------------------------------------------------------------------
// typecheckEntry — `workflow-toolbox build --typecheck` support
// ---------------------------------------------------------------------------

async function typecheckEntry(absEntry: string): Promise<void> {
  // Resolve the CONSUMER's typescript from the entry's directory (NEVER a
  // bundled copy — versions must match the consumer's own toolchain).
  let tsPath: string
  try {
    const req = createRequire(path.join(path.dirname(absEntry), 'package.json'))
    tsPath = req.resolve('typescript')
  } catch {
    console.warn(
      'workflow-toolbox build: --typecheck skipped — typescript is not installed in this project.\n' +
        '  Install it to enable the check: pnpm add -D typescript',
    )
    return
  }

  type TsModule = typeof import('typescript')
  const tsImport = (await import(pathToFileURL(tsPath).href)) as { default?: TsModule }
  const ts = tsImport.default ?? (tsImport as unknown as TsModule)

  // Prefer the consumer's own tsconfig (nearest to the entry); fall back to the
  // SAME minimal options `workflow-toolbox scaffold` emits (single source — MINIMAL_TSCONFIG).
  // noEmit is always forced — this is a CHECK.
  const configPath = ts.findConfigFile(path.dirname(absEntry), ts.sys.fileExists)
  let options: import('typescript').CompilerOptions = {
    ...ts.convertCompilerOptionsFromJson(MINIMAL_TSCONFIG.compilerOptions, path.dirname(absEntry))
      .options,
    noEmit: true,
  }
  if (configPath !== undefined) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile)
    if (read.config !== undefined) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath))
      // configFilePath anchors typeRoots/types resolution to the tsconfig's own
      // directory (without it, `"types": ["node"]` resolves from process.cwd()).
      options = { ...parsed.options, noEmit: true, configFilePath: configPath }
    }
  }

  const program = ts.createProgram([absEntry], options)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length > 0) {
    const host: import('typescript').FormatDiagnosticsHost = {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (f) => f,
      getNewLine: () => '\n',
    }
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host))
    throw new Error(
      `workflow-toolbox build: typecheck failed with ${diagnostics.length} error(s) — artifact NOT written`,
    )
  }
}

// ---------------------------------------------------------------------------
// runScaffold — emit a .workflow.ts skeleton from a JSON spec
// ---------------------------------------------------------------------------

async function runScaffold(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'out-dir': { type: 'string', short: 'o' },
      stdout: { type: 'boolean', default: false },
      force: { type: 'boolean', short: 'f', default: false },
      'no-tsconfig': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  })

  const specPath = positionals[0]
  if (specPath === undefined || specPath === '') {
    printUsage()
    throw new Error('workflow-toolbox scaffold: missing <spec.json> positional argument')
  }

  const spec = loadSpec(specPath)
  const source = scaffoldWorkflow(spec)

  if (values.stdout) {
    process.stdout.write(source)
    return
  }

  const outDir = path.resolve(values['out-dir'] ?? '.')
  const outFile = path.join(outDir, `${spec.meta.name}.workflow.ts`)
  if (fs.existsSync(outFile) && !values.force) {
    throw new Error(`workflow-toolbox scaffold: refusing to overwrite ${outFile} — pass --force to replace it`)
  }
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(outFile, source, 'utf8')
  console.log(`workflow-toolbox scaffold: wrote ${outFile}`)

  // Emit a minimal tsconfig.json ONLY when the target dir has none (never
  // overwrites; --no-tsconfig opts out) so --typecheck and editor type hints
  // work in a fresh consumer project.
  const tsconfigPath = path.join(outDir, 'tsconfig.json')
  if (!values['no-tsconfig'] && !fs.existsSync(tsconfigPath)) {
    fs.writeFileSync(tsconfigPath, JSON.stringify(MINIMAL_TSCONFIG, null, 2) + '\n', 'utf8')
    console.log(`workflow-toolbox scaffold: wrote ${tsconfigPath} (none existed — pass --no-tsconfig to skip)`)
  }

  const rel = path.relative(process.cwd(), outFile)
  console.log(`  next: npx workflow-toolbox build ${rel.startsWith('..') ? outFile : rel} --typecheck`)
}

// ---------------------------------------------------------------------------
// runDebug / runReport — published forms of the debugger CLIs.
// Thin orchestration over the same cores the plugin's bundled bins use; the
// argv parsers are SHARED (cli-args.ts), so flag behavior cannot drift. The
// ~40-line orchestration itself is consciously duplicated from the debugger's
// cli.ts/report-cli.ts, whose `process.exit(main())` entry style cannot be
// imported without executing it.
// ---------------------------------------------------------------------------

/** Shared resolve→print→parse front half of `workflow-toolbox debug` and `workflow-toolbox report`. */
function resolveJournalOrThrow(
  tool: string,
  runId: string | null,
  project: string | undefined,
): { resolved: NonNullable<ReturnType<typeof findJournal>>; journal: NonNullable<ReturnType<typeof parseJournal>> } {
  const opts = project !== undefined ? { project } : {}
  const resolved = findJournal(runId, opts)
  if (!resolved) {
    throw new Error(journalLookupErrorMessage(tool, runId, opts))
  }
  console.error(`[project dir: ${projectDirFor(resolved.path)}]`)
  const journal = parseJournal(resolved.text)
  if (!journal) {
    throw new Error(`${tool}: ${resolved.path} is not a readable workflow journal`)
  }
  return { resolved, journal }
}

async function runDebug(argv: string[]): Promise<void> {
  const { runId, json, project, help, error } = parseDebugArgs(argv)
  if (help) {
    printUsage()
    return
  }
  if (error) throw new Error(`workflow-toolbox debug: ${error}`)

  const { resolved, journal } = resolveJournalOrThrow('workflow-toolbox debug', runId, project)

  const diagnosis = diagnoseRun(journal)
  if (json) {
    process.stdout.write(
      JSON.stringify(
        { ...diagnosis, journalPath: resolved.path, sessionId: resolved.sessionId },
        null,
        2,
      ) + '\n',
    )
  } else {
    process.stdout.write(
      formatDiagnosis(diagnosis, {
        journalPath: resolved.path,
        sessionId: resolved.sessionId,
        ...(project !== undefined && { project }),
      }) + '\n',
    )
  }
}

async function runReport(argv: string[]): Promise<void> {
  const { runId, project, out, quiet, help, error } = parseReportArgs(argv)
  if (help) {
    printUsage()
    return
  }
  if (error) throw new Error(`workflow-toolbox report: ${error}`)

  const { resolved, journal } = resolveJournalOrThrow('workflow-toolbox report', runId, project)

  const tdir = transcriptDirFor(resolved.path, resolved.runId)
  const agentIds = agentEvents(journal)
    .map((a) => a.agentId)
    .filter((id): id is string => typeof id === 'string')
  const { presentTranscripts, transcriptSources, usageByAgent } = scanTranscripts(tdir, agentIds, {
    withUsage: true,
  })

  const report = buildAuditReport(journal, { presentTranscripts, usageByAgent })
  const markdown = formatAuditReportMarkdown(report, { journalPath: resolved.path })

  if (!quiet) process.stdout.write(markdown)

  const logDir = resolveLogDir(process.env, out)
  if (logDir) {
    const result = writeAuditFolder({
      baseDir: logDir.baseDir,
      runId: resolved.runId,
      markdown,
      journalText: resolved.text,
      transcriptSources,
    })
    if (result.written) {
      console.error(`[report] wrote audit folder ${result.dir} (${result.files?.length ?? 0} file(s))`)
    } else {
      throw new Error(`workflow-toolbox report: audit folder NOT written: ${result.reason ?? 'unknown error'}`)
    }
  } else if (quiet) {
    throw new Error(
      'workflow-toolbox report: nothing emitted — --quiet was set but no audit folder is configured ' +
        '(set --out <dir> or $DWT_WORKFLOW_LOG_DIR)',
    )
  }
}

// ---------------------------------------------------------------------------
// runCheck — lint an already-built .js artifact
// ---------------------------------------------------------------------------

async function runCheck(argv: string[]): Promise<void> {
  const file = argv[0]
  if (file === undefined || file === '') {
    printUsage()
    throw new Error('workflow-toolbox check: missing <file.js> positional argument')
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
      `workflow-toolbox check: ${lint.errors.length} error(s), ${lint.warnings.length} warning(s) in ${absFile}`,
    )
    throw new Error(`workflow-toolbox check: ${lint.errors.length} error(s) found — see above`)
  }

  // errors === 0 here, so "no issues" reduces to "no warnings"
  console.log(
    `workflow-toolbox check: ok — ${lint.warnings.length === 0 ? 'no issues' : `${lint.warnings.length} warning(s)`} in ${absFile}`,
  )
}

// ---------------------------------------------------------------------------
// printUsage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
workflow-toolbox — Workflow Toolbox CLI

Usage (npm consumers: npx workflow-toolbox …  or  pnpm exec workflow-toolbox …; in this repo: pnpm wt:* scripts):
  workflow-toolbox scaffold <spec.json> [--out-dir <dir>] [--stdout] [--force] [--no-tsconfig]
  workflow-toolbox build <entry.ts> [--out-dir <dir>] [--minify] [--typecheck]
  workflow-toolbox check <file.js>
  workflow-toolbox debug [runId|latest|<journal-path>] [--json] [--project <slug>]
  workflow-toolbox report [runId|latest|<journal-path>] [--project <slug>] [--out <dir>] [--quiet]

Commands:
  scaffold  Emit a build-clean <name>.workflow.ts skeleton from a JSON spec
            ({ "meta": { "name", "description" }, "steps": [{ "pattern", "phase" }] }).
            Also writes a minimal tsconfig.json when the target dir has none
            (--no-tsconfig to skip; an existing tsconfig is never touched).

  build     Bundle a TypeScript workflow entry file to a self-contained .js artifact.
            Output filename is <meta.name>.js in --out-dir (default: workflows/).
            An existing artifact with the same name is overwritten.
            The runtime registry is keyed by meta.name, NOT the filename.

  check     Lint an already-built workflow artifact with lintWorkflowSource.
            Exits 1 if any errors are found.

  debug     Diagnose a Workflow run from its on-disk journal (post-mortem only:
            the journal materializes at run completion).

  report    Produce the cost + traceability audit report for a run; --out <dir>
            (or $DWT_WORKFLOW_LOG_DIR) also writes the audit folder.

Options:
  --out-dir, -o  Output directory (build: default workflows/; scaffold: default .)
  --minify       Enable whitespace + syntax minification (never minifies identifiers)
  --typecheck    Type-check the entry with the project's own typescript before
                 bundling (skipped with a warning when typescript is not installed)
  --project      ~/.claude/projects/<slug> to search (slugs start with "-"; both
                 "--project <slug>" and "--project=<slug>" forms work)
`.trim())
}

// ---------------------------------------------------------------------------
// Entry point guard — run main() when invoked directly via tsx/node
// ---------------------------------------------------------------------------

// process.argv[1] can be a bin symlink (e.g. node_modules/.bin/workflow-toolbox) while
// import.meta.url resolves to the module's realpath — so compare REALPATHS. A
// naive URL/path compare silently no-ops when invoked through the installed
// `workflow-toolbox` bin symlink (argv[1] = the symlink, import.meta.url = its target). This
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
    // The thrown message IS the user-facing error for most subcommands
    // (scaffold/debug/report throw without pre-printing), so always print it.
    // build/check print their detail lines BEFORE throwing a one-line summary —
    // repeating that summary here is redundant but never silent.
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
