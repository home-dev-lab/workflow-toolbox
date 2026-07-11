// CLI entry for the workflow audit report. IMPURE (resolves + reads the disk, stats
// transcripts, optionally writes the audit folder); held out of `pnpm test`.
//
//   pnpm wt:report [runId|latest] [--project <slug>] [--out <dir>] [--quiet]
//
// Behaviour (mirrors the D3 gating): the markdown report is ALWAYS printed to stdout
// (so the invoking session always has the real cost/decision data), UNLESS --quiet.
// The audit FOLDER is written only when $DWT_WORKFLOW_LOG_DIR or --out is set — disk
// persistence is off by default. A one-line "wrote <dir>" note goes to stderr so it
// never pollutes the stdout report.

import { findJournal, journalLookupErrorMessage, projectDirFor, transcriptDirFor } from './source.js'
import { parseJournal, agentEvents } from './journal.js'
import { buildAuditReport } from './report.js'
import { formatAuditReportMarkdown } from './report-format.js'
import { resolveLogDir, writeAuditFolder, scanTranscripts } from './audit-folder.js'
import { parseReportArgs } from './cli-args.js'

function printHelp(): void {
  process.stdout.write(
    [
      'wt-report — produce a cost + traceability audit report for a Workflow run',
      '',
      'Usage: wt:report [runId|latest|<journal-path>] [--project <slug>] [--out <dir>] [--quiet]',
      '',
      '  runId        wf_<id> of the run (with or without the wf_ prefix). Omit or',
      '               pass "latest" for the newest run in the current project.',
      '               A literal <configDir>/.../workflows/wf_<id>.json path also works.',
      '  --project    search a specific $CLAUDE_CONFIG_DIR/projects/<slug> instead of the cwd',
      '               (slugs start with "-"; both `--project <slug>` and',
      '               `--project=<slug>` forms are accepted).',
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
  const { runId, project, out, quiet, help, error } = parseReportArgs(process.argv.slice(2))
  if (help) {
    printHelp()
    return 0
  }
  if (error) {
    process.stderr.write(`wt-report: ${error}\n`)
    return 2
  }

  const opts = project !== undefined ? { project } : {}
  const resolved = findJournal(runId, opts)
  if (!resolved) {
    process.stderr.write(journalLookupErrorMessage('wt-report', runId, opts) + '\n')
    return 1
  }
  // The dir the journal actually came from (may differ from the scanned dir when
  // the by-runId search fell back across projects, or a literal path was given).
  process.stderr.write(`[project dir: ${projectDirFor(resolved.path)}]\n`)

  const journal = parseJournal(resolved.text)
  if (!journal) {
    process.stderr.write(`wt-report: ${resolved.path} is not a readable workflow journal.\n`)
    return 1
  }

  // Scan each agent's transcript for the present-set, copy sources, AND token usage — the CLI
  // always renders the full report.md, so it always reads usage (withUsage).
  const tdir = transcriptDirFor(resolved.path, resolved.runId)
  const agentIds = agentEvents(journal)
    .map((a) => a.agentId)
    .filter((id): id is string => typeof id === 'string')
  const { presentTranscripts, transcriptSources, usageByAgent, denialsByAgent, compactionByAgent, delegationByAgent } =
    scanTranscripts(tdir, agentIds, { withUsage: true, withDenials: true, withCompaction: true, withDelegation: true })

  const report = buildAuditReport(journal, {
    presentTranscripts,
    usageByAgent,
    denialsByAgent,
    compactionByAgent,
    delegationByAgent,
  })
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
