#!/usr/bin/env node
// cli.ts — `workflow-toolbox` command-line interface for @workflow-toolbox/build.
//
// In-repo this runs as TS via tsx (the pnpm scripts below). For npm consumers
// the published package exposes it as the `workflow-toolbox` bin (compiled to dist/cli.js by
// tsup, which preserves this shebang and chmods the output) — see
// `publishConfig.bin`. The shebang is an inert comment under tsx, so the dev
// scripts keep working unchanged. Primary form, from the workspace root
// (toolkit/), where the default out-dirs `workflows/`/`pipelines/` resolve correctly:
//   pnpm wt:build <entry.ts> [--out-dir <dir>] [--minify]
//   pnpm wt:pipeline <entry.ts> [--out-dir <dir>] [--out <name>] [--minify]
//   pnpm wt:check <file.js>
// Also supported: `pnpm wt …` from this package, or `pnpm -F @workflow-toolbox/build
// wt …` from the root (cwd is packages/build/ — paths need ../../).
//
// Structured as a thin exported main(argv) for testability plus an
// import.meta.url guard for direct invocation via:
//   pnpm exec tsx src/cli.ts build ...
//
// NOTE: `build`'s output filename is `<meta.name>.js` (not the entry filename) — the Claude
// Code runtime registry is keyed by meta.name, so using the source filename would cause a
// mismatch if the file is renamed. `pipeline`'s output FILENAME is instead derived from the
// ENTRY filename (see pipelineBaseName); as of card #1813065099577918566, that same derived
// name is ALSO injected into the emitted spec's own (optional) `name` field when the author's
// spec doesn't already declare one — see `runPipeline` below.

import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundleWorkflow } from './bundle.js'
import { bundlePipeline, pipelineBaseName } from './bundle-pipeline.js'
import { lintWorkflowSource } from './lint.js'
import type { PipelineSpec } from '@workflow-toolbox/pipeline-spec'
// The packages below are PRIVATE workspace devDependencies: tsup inlines them
// into dist/cli.js (verified — no bare imports survive in the bundle), so the
// published package stays self-contained without publishing them to npm.
import { capabilitiesLaunchHint, observerLaunchHint, MINIMAL_TSCONFIG } from '@workflow-toolbox/scaffold'
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
import { renderScaffold, writeScaffoldArtifact } from '@workflow-toolbox/scaffold/dispatch'
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
  if (command === 'pipeline') {
    return runPipeline(argv.slice(1))
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
// runPipeline — bundle an entry PIPELINE file (I5 authoring increment): the declarative
// PipelineSpec the observe-ui runner consumes, NOT a Workflow-sandbox artifact — see
// bundle-pipeline.ts's doc for why this needs no --typecheck-vs-sandbox distinction beyond
// what runBuild already does.
// ---------------------------------------------------------------------------

async function runPipeline(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'out-dir': { type: 'string', short: 'o' },
      out: { type: 'string' },
      minify: { type: 'boolean', default: false },
      typecheck: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  })

  const entry = positionals[0]
  if (entry === undefined || entry === '') {
    printUsage()
    throw new Error('workflow-toolbox pipeline: missing <entry.ts> positional argument')
  }

  const absEntry = path.resolve(entry)

  // Default out-dir: 'pipelines' relative to cwd — mirrors runBuild's 'workflows' default.
  const outDir = path.resolve(values['out-dir'] ?? 'pipelines')

  if (values.typecheck) {
    await typecheckEntry(absEntry)
  }

  const result = await bundlePipeline({ entry: absEntry, minify: values.minify })

  fs.mkdirSync(outDir, { recursive: true })

  // Output filename: derived from the ENTRY file, stripping a `.pipeline.ts` suffix if
  // present (else just `.ts`) — OVERWRITES silently, same rebuild-in-place convention as
  // runBuild. `--out` overrides the derived FILENAME entirely (with or without a trailing
  // .json — both forms accepted); it does NOT affect the `name` injection below, which is
  // always derived from the ENTRY file regardless of `--out`.
  const outName = values.out !== undefined
    ? (values.out.endsWith('.json') ? values.out : `${values.out}.json`)
    : `${pipelineBaseName(absEntry)}.json`
  const outFile = path.join(outDir, outName)

  // Pattern-name injection (card #1813065099577918566, "pipelines become first-class
  // citizens with a type"): a pipeline artifact's own `name` — symmetric to a workflow's
  // meta.name — makes a launched pipeline recognizable by TYPE (PipelineManifest.type),
  // not just its one-off goal string. Derived from the SAME entry filename `pipelineBaseName`
  // already uses for the output filename, ONLY when the authored spec doesn't declare its
  // own `name` (definePipeline() lets an author set one explicitly; that always wins).
  //
  // Bug fixed live (card #1813065099577918566 follow-up): this MUST build off `result.json`
  // (parsed back), NOT `result.spec` — `result.spec` is the ROUND-TRIPPED, re-PARSED spec
  // (parseStageSpecV2 reconstructs each stage as `{name, workflow, [input], [gateAfter],
  // [artifact]}`, a FIXED order), which silently reordered every stage's keys away from the
  // author's own order the first time this ran, contradicting define-pipeline.ts's own
  // documented promise ("preserving the author's own key order in the emitted JSON... rather
  // than churning committed artifacts' diffs on a behavior-neutral internal reconstruction").
  // `result.json` is built from the RAW, pre-round-trip `rawSpec` (bundle-pipeline.ts's Step
  // 3 doc), so re-parsing IT (not result.spec) keeps every existing key in the author's exact
  // order — `name` is the ONLY key ever appended, and only when genuinely absent.
  const parsedForInjection = JSON.parse(result.json) as PipelineSpec
  const spec = parsedForInjection.name !== undefined ? parsedForInjection : { ...parsedForInjection, name: pipelineBaseName(absEntry) }
  const json = JSON.stringify(spec, null, 2)
  // Trailing newline: the repo's own text-file convention (package.json, etc.) — also what
  // the committed toolkit/pipelines/*.json artifacts + their byte-identity gate expect.
  fs.writeFileSync(outFile, json + '\n', 'utf8')

  // Buffer.byteLength(json), not the stale result.bytes — a `name` injection can change the
  // byte count from what bundlePipeline alone measured.
  console.log(`workflow-toolbox pipeline: wrote ${outFile} (${Buffer.byteLength(json)} bytes)`)
}

// ---------------------------------------------------------------------------
// typecheckEntry — `workflow-toolbox build --typecheck` support
// ---------------------------------------------------------------------------

type TsModule = typeof import('typescript')

// The classic in-process compiler API (createProgram / getPreEmitDiagnostics /
// sys.*) the programmatic typecheck path uses. TypeScript 7+ is the native (Go)
// rewrite: `require('typescript')` resolves to version.cjs — `{ version }` only,
// with NO `sys`/`createProgram` — so `ts.sys.fileExists` there throws
// "Cannot read properties of undefined (reading 'fileExists')" (the reported
// crash). Its batch compiler API moved to an experimental `typescript/unstable/*`
// surface that spawns a subprocess anyway, so we route 7+ to the stable `tsc` CLI
// instead. Capability detection (not a version-number check) so a future major
// that keeps or restores the classic API still takes the in-process path.
export function hasClassicCompilerApi(ts: {
  createProgram?: unknown
  getPreEmitDiagnostics?: unknown
  findConfigFile?: unknown
  sys?: { fileExists?: unknown } | undefined
}): boolean {
  // A representative probe across the three phases typecheckViaProgram uses —
  // config read (findConfigFile + sys.fileExists), program build (createProgram)
  // and diagnostics (getPreEmitDiagnostics). In a real `typescript` module these
  // classic APIs all ship together, so this is representative, not exhaustive;
  // the native rewrite (7+) exposes NONE of them (only `version`), which is the
  // case that must route to the CLI.
  return (
    typeof ts.createProgram === 'function' &&
    typeof ts.getPreEmitDiagnostics === 'function' &&
    typeof ts.findConfigFile === 'function' &&
    ts.sys != null &&
    typeof ts.sys.fileExists === 'function'
  )
}

// Walk up from `startDir` for the nearest tsconfig.json (fs-only — must work
// without the TS API, which is absent under the native rewrite).
export function findNearestTsconfig(startDir: string): string | undefined {
  let dir = startDir
  for (;;) {
    const candidate = path.join(dir, 'tsconfig.json')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

async function typecheckEntry(absEntry: string): Promise<void> {
  // Resolve the CONSUMER's typescript from the entry's directory (NEVER a
  // bundled copy — versions must match the consumer's own toolchain).
  let req: ReturnType<typeof createRequire>
  let tsPath: string
  try {
    req = createRequire(path.join(path.dirname(absEntry), 'package.json'))
    tsPath = req.resolve('typescript')
  } catch {
    console.warn(
      'workflow-toolbox build: --typecheck skipped — typescript is not installed in this project.\n' +
        '  Install it to enable the check: pnpm add -D typescript',
    )
    return
  }

  const tsImport = (await import(pathToFileURL(tsPath).href)) as { default?: TsModule }
  const ts = tsImport.default ?? (tsImport as unknown as TsModule)

  if (hasClassicCompilerApi(ts)) {
    typecheckViaProgram(ts, absEntry)
  } else {
    // TypeScript 7+ (native rewrite): no in-process compiler API — shell out to
    // the consumer's own `tsc` binary, the one stable cross-version contract.
    typecheckViaCli(req, absEntry, ts.version)
  }
}

// The in-process path for TypeScript < 7 (classic API). UNCHANGED from the
// original typecheckEntry body — the shipped, tested ^5/^6 path.
function typecheckViaProgram(ts: TsModule, absEntry: string): void {
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

// The subprocess path for TypeScript 7+ (native rewrite). Runs the consumer's
// own `tsc` on a temp tsconfig that inherits their nearest tsconfig options (or
// the scaffold MINIMAL_TSCONFIG when none) but scopes the check to just the
// entry — the same check `typecheckViaProgram` performs, via the stable CLI.
// Exported for the TEST-LOCK (exercised with the dev toolchain's own tsc, since
// TS7 isn't a devDependency; the CLI contract is version-stable by design).
export function typecheckViaCli(
  req: ReturnType<typeof createRequire>,
  absEntry: string,
  version: string,
): void {
  let tscBin: string
  try {
    const pkgJsonPath = req.resolve('typescript/package.json')
    const pkgRoot = path.dirname(pkgJsonPath)
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
      bin?: string | Record<string, string>
    }
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsc
    if (binRel === undefined) throw new Error('no tsc bin in typescript package.json')
    tscBin = path.join(pkgRoot, binRel)
  } catch {
    console.warn(
      `workflow-toolbox build: --typecheck skipped — could not locate the 'tsc' binary of typescript@${version}.\n` +
        '  TypeScript 7+ (the native rewrite) is type-checked via its CLI; reinstall typescript to enable the check.',
    )
    return
  }

  // extends the consumer's nearest tsconfig for its options; `files:[entry]` +
  // `include:[]` scope the file set to ONLY the entry (matching the in-process
  // path's `[absEntry]` roots — a base `include` would otherwise widen it).
  const nearest = findNearestTsconfig(path.dirname(absEntry))
  const config =
    nearest !== undefined
      ? { extends: nearest, compilerOptions: { noEmit: true }, files: [absEntry], include: [] }
      : {
          compilerOptions: { ...MINIMAL_TSCONFIG.compilerOptions, noEmit: true },
          files: [absEntry],
          include: [],
        }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-typecheck-'))
  const tmpConfig = path.join(tmpDir, 'tsconfig.json')
  try {
    fs.writeFileSync(tmpConfig, JSON.stringify(config, null, 2) + '\n', 'utf8')
    // `stdio: 'inherit'` lets tsc render its own diagnostics (with context) to
    // the user's terminal; the exit code is the ground-truth pass/fail.
    const result = spawnSync(process.execPath, [tscBin, '--project', tmpConfig], {
      stdio: 'inherit',
    })
    if (result.error !== undefined) {
      throw new Error(
        `workflow-toolbox build: typecheck could not run tsc (${result.error.message}) — artifact NOT written`,
      )
    }
    if (result.status !== 0) {
      throw new Error('workflow-toolbox build: typecheck failed — artifact NOT written')
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
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

  // `scaffold agent <spec.json>` emits a least-privilege agentType .md;
  // `scaffold observer <spec.json>` emits a workflow-owned <name>.observer.json;
  // `scaffold capabilities <spec.json>` emits a workflow-owned <name>.capabilities.json;
  // plain `scaffold <spec.json>` emits a .workflow.ts. The per-mode load+render+
  // filename mapping and the --stdout / no-clobber / mkdir / write mechanics are the
  // shared @workflow-toolbox/scaffold/dispatch helpers; only this CLI's messaging,
  // `next` hints and tsconfig emission stay here.
  const subVerbs = { agent: 'agent', observer: 'observer', capabilities: 'capabilities' } as const
  const sub = (positionals[0] ?? '') as keyof typeof subVerbs
  const mode = sub in subVerbs ? subVerbs[sub] : 'workflow'
  const specPath = positionals[mode === 'workflow' ? 0 : 1]
  if (specPath === undefined || specPath === '') {
    printUsage()
    throw new Error('workflow-toolbox scaffold: missing <spec.json> positional argument')
  }

  const rendered = renderScaffold(mode, specPath)
  const outDir = path.resolve(values['out-dir'] ?? '.')
  const result = writeScaffoldArtifact({
    source: rendered.source,
    outName: rendered.outName,
    outDir,
    stdout: values.stdout,
    force: values.force,
  })
  if (result.kind === 'stdout') return

  const label = rendered.mode === 'workflow' ? 'scaffold' : `scaffold ${rendered.mode}`
  if (result.kind === 'refused') {
    throw new Error(`workflow-toolbox ${label}: refusing to overwrite ${result.outFile} — pass --force to replace it`)
  }
  console.log(`workflow-toolbox ${label}: wrote ${result.outFile}`)

  if (rendered.mode === 'capabilities') {
    console.log(capabilitiesLaunchHint(rendered.spec).trimEnd())
    return
  }

  if (rendered.mode === 'observer') {
    console.log(observerLaunchHint(rendered.spec).trimEnd())
    return
  }

  if (rendered.mode === 'agent') {
    console.log(
      `  next: put ${rendered.spec.name}.md under ~/.claude/agents/ (or .claude/agents/), then reference it via agent(prompt, { agentType: '${rendered.spec.name}' })`,
    )
    return
  }

  // workflow: emit a minimal tsconfig.json ONLY when the target dir has none (never
  // overwrites; --no-tsconfig opts out) so --typecheck and editor type hints
  // work in a fresh consumer project.
  const tsconfigPath = path.join(outDir, 'tsconfig.json')
  if (!values['no-tsconfig'] && !fs.existsSync(tsconfigPath)) {
    fs.writeFileSync(tsconfigPath, JSON.stringify(MINIMAL_TSCONFIG, null, 2) + '\n', 'utf8')
    console.log(`workflow-toolbox scaffold: wrote ${tsconfigPath} (none existed — pass --no-tsconfig to skip)`)
  }

  const rel = path.relative(process.cwd(), result.outFile)
  console.log(`  next: npx workflow-toolbox build ${rel.startsWith('..') ? result.outFile : rel} --typecheck`)
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
  workflow-toolbox scaffold agent <spec.json> [--out-dir <dir>] [--stdout] [--force]
  workflow-toolbox scaffold observer <spec.json> [--out-dir <dir>] [--stdout] [--force]
  workflow-toolbox scaffold capabilities <spec.json> [--out-dir <dir>] [--stdout] [--force]
  workflow-toolbox build <entry.ts> [--out-dir <dir>] [--minify] [--typecheck]
  workflow-toolbox pipeline <entry.ts> [--out-dir <dir>] [--out <name>] [--minify] [--typecheck]
  workflow-toolbox check <file.js>
  workflow-toolbox debug [runId|latest|<journal-path>] [--json] [--project <slug>]
  workflow-toolbox report [runId|latest|<journal-path>] [--project <slug>] [--out <dir>] [--quiet]

Commands:
  scaffold  Emit a build-clean <name>.workflow.ts skeleton from a JSON spec
            (or "scaffold agent <spec.json>" → a least-privilege agentType <name>.md,
            or "scaffold observer <spec.json>" → a workflow-owned <name>.observer.json,
            an ObserverDefinition of ABSTRACT observation needs — validated by the shared
            @workflow-toolbox/debugger observer-def contract, the same one the launch
            bridge fails loud on,
            or "scaffold capabilities <spec.json>" → a workflow-owned <name>.capabilities.json,
            a machine-agnostic capability sidecar with $cap:<need> placeholders — validated by
            the shared @workflow-toolbox/debugger capability-registry lint, the same rules the
            launch resolver fails loud on)
            ({ "meta": { "name", "description" }, "steps": [{ "pattern", "phase" }] }).
            Also writes a minimal tsconfig.json when the target dir has none
            (--no-tsconfig to skip; an existing tsconfig is never touched).

  build     Bundle a TypeScript workflow entry file to a self-contained .js artifact.
            Output filename is <meta.name>.js in --out-dir (default: workflows/).
            An existing artifact with the same name is overwritten.
            The runtime registry is keyed by meta.name, NOT the filename.

  pipeline  Bundle a TypeScript ORCHESTRATOR-PIPELINE entry file (an
            "export default definePipeline({...})") to a PipelineSpec .json artifact — NOT a
            Workflow-sandbox artifact; this is the declarative spec the observe-ui pipeline
            runner consumes over POST /api/pipeline {spec}. Output filename is derived from
            the entry file (strips a .pipeline.ts suffix, else .ts) in --out-dir (default:
            pipelines/); --out overrides it. An existing artifact with the same name is
            overwritten.

  check     Lint an already-built workflow artifact with lintWorkflowSource.
            Exits 1 if any errors are found.

  debug     Diagnose a Workflow run from its on-disk journal (post-mortem only:
            the journal materializes at run completion).

  report    Produce the cost + traceability audit report for a run; --out <dir>
            (or $DWT_WORKFLOW_LOG_DIR) also writes the audit folder.

Options:
  --out-dir, -o  Output directory (build: default workflows/; pipeline: default pipelines/;
                 scaffold: default .)
  --out          pipeline only: override the derived output filename (with or without .json)
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
