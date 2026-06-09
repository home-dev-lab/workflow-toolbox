// CLI entry for the workflow audit report. IMPURE (resolves + reads the disk, stats
// transcripts, optionally writes the audit folder); held out of `pnpm test`.
//
//   pnpm dwt:report [runId|latest] [--project <slug>] [--out <dir>] [--quiet]
//
// Behaviour (mirrors the D3 gating): the markdown report is ALWAYS printed to stdout
// (so the invoking session always has the real cost/decision data), UNLESS --quiet.
// The audit FOLDER is written only when $DWT_WORKFLOW_LOG_DIR or --out is set — disk
// persistence is off by default. A one-line "wrote <dir>" note goes to stderr so it
// never pollutes the stdout report.

import { findJournal, transcriptDirFor } from './source.js'
import { parseJournal, agentEvents } from './journal.js'
import { buildAuditReport } from './report.js'
import { formatAuditReportMarkdown } from './report-format.js'
import { resolveLogDir, writeAuditFolder, scanTranscripts } from './audit-folder.js'

interface CliArgs {
  runId: string | null
  project: string | undefined
  out: string | undefined
  quiet: boolean
}

/** Read the value token after a flag, rejecting a missing value or another flag
 *  (so `--project --quiet` errors instead of silently swallowing `--quiet`). */
function nextValue(argv: string[], i: number, flag: string): string {
  const v = argv[i]
  if (v === undefined || v.startsWith('-')) {
    process.stderr.write(`dwt-report: ${flag} requires a value.\n`)
    process.exit(2)
  }
  return v
}

function parseArgs(argv: string[]): CliArgs {
  let runId: string | null = null
  let project: string | undefined
  let out: string | undefined
  let quiet = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--project') project = nextValue(argv, ++i, '--project')
    else if (a === '--out') out = nextValue(argv, ++i, '--out')
    else if (a === '--quiet') quiet = true
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else if (!a.startsWith('-')) runId = a
  }
  return { runId, project, out, quiet }
}

function printHelp(): void {
  process.stdout.write(
    [
      'dwt-report — produce a cost + traceability audit report for a Workflow run',
      '',
      'Usage: dwt:report [runId|latest] [--project <slug>] [--out <dir>] [--quiet]',
      '',
      '  runId        wf_<id> of the run (with or without the wf_ prefix). Omit or',
      '               pass "latest" for the newest run in the current project.',
      '  --project    search a specific ~/.claude/projects/<slug> instead of the cwd.',
      '  --out <dir>  also write an audit folder <dir>/<runId>/ (report.md + journal.json',
      '               + transcripts/). Overrides $DWT_WORKFLOW_LOG_DIR.',
      '  --quiet      suppress the stdout report (use with --out / the env var).',
      '',
      'The report always prints to stdout unless --quiet. The audit FOLDER is written',
      'only when --out or $DWT_WORKFLOW_LOG_DIR is set (off by default).',
      '',
    ].join('\n') + '\n',
  )
}

function main(): number {
  const { runId, project, out, quiet } = parseArgs(process.argv.slice(2))

  const resolved = findJournal(runId, project !== undefined ? { project } : {})
  if (!resolved) {
    const which = runId && runId !== 'latest' ? `run "${runId}"` : 'any run in this project'
    process.stderr.write(
      `dwt-report: no journal found for ${which}.\n` +
        '  Journals live at ~/.claude/projects/<project>/<session>/workflows/wf_<runId>.json.\n' +
        '  Run from the project that produced the run, or pass --project <slug>.\n',
    )
    return 1
  }

  const journal = parseJournal(resolved.text)
  if (!journal) {
    process.stderr.write(`dwt-report: ${resolved.path} is not a readable workflow journal.\n`)
    return 1
  }

  // Scan each agent's transcript for the present-set, copy sources, AND token usage — the CLI
  // always renders the full report.md, so it always reads usage (withUsage).
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
      process.stderr.write(`[report] wrote audit folder ${result.dir} (${result.files?.length ?? 0} file(s))\n`)
    } else {
      process.stderr.write(`[report] audit folder NOT written: ${result.reason ?? 'unknown error'}\n`)
      return 1
    }
  } else if (quiet) {
    // --quiet with no destination would silently do nothing — tell the user why.
    process.stderr.write(
      '[report] nothing emitted: --quiet was set but no audit folder is configured ' +
        '(set --out <dir> or $DWT_WORKFLOW_LOG_DIR).\n',
    )
    return 1
  }

  return 0
}

process.exit(main())
