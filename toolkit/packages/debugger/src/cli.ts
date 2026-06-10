// CLI entry — the file esbuild bundles into plugin/bin/wt-debug.mjs (and the
// byte-identical toolkit/bin copy). IMPURE (resolves + reads the disk); held out of
// `pnpm test`. Maintainer: `pnpm wt:debug [runId|latest]`. End user (plugin install):
// `node "${CLAUDE_PLUGIN_ROOT}/bin/wt-debug.mjs" [runId|latest]`.

import { findJournal, journalLookupErrorMessage, projectDirFor } from './source.js'
import { parseJournal } from './journal.js'
import { diagnoseRun } from './diagnose.js'
import { formatDiagnosis } from './format.js'
import { parseDebugArgs } from './cli-args.js'

function printHelp(): void {
  process.stdout.write(
    [
      'wt-debug — diagnose a Claude Code Workflow run from its journal',
      '',
      'Usage: wt-debug [runId|latest|<journal-path>] [--json] [--project <slug>]',
      '',
      '  runId        wf_<id> of the run (with or without the wf_ prefix). Omit or',
      '               pass "latest" to diagnose the newest run in the current project.',
      '               A literal ~/.claude/.../workflows/wf_<id>.json path also works.',
      '  --json       emit the raw diagnosis as JSON instead of the text report.',
      '  --project    search a specific ~/.claude/projects/<slug> instead of the cwd',
      '               (slugs start with "-"; both `--project <slug>` and',
      '               `--project=<slug>` forms are accepted).',
      '',
    ].join('\n') + '\n',
  )
}

function main(): number {
  const { runId, json, project, help, error } = parseDebugArgs(process.argv.slice(2))
  if (help) {
    printHelp()
    return 0
  }
  if (error) {
    process.stderr.write(`wt-debug: ${error}\n`)
    return 2
  }
  const opts = project ? { project } : {}
  const resolved = findJournal(runId, opts)
  if (!resolved) {
    process.stderr.write(journalLookupErrorMessage('wt-debug', runId, opts) + '\n')
    return 1
  }
  // The dir the journal actually came from (may differ from the scanned dir when
  // the by-runId search fell back across projects, or a literal path was given).
  process.stderr.write(`[project dir: ${projectDirFor(resolved.path)}]\n`)

  const journal = parseJournal(resolved.text)
  if (!journal) {
    process.stderr.write(`wt-debug: ${resolved.path} is not a readable workflow journal.\n`)
    return 1
  }

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
  return 0
}

process.exit(main())
