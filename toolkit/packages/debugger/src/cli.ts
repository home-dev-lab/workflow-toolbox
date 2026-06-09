// CLI entry — the file esbuild bundles into plugin/bin/dwt-debug.mjs (and the
// byte-identical toolkit/bin copy). IMPURE (resolves + reads the disk); held out of
// `pnpm test`. Maintainer: `pnpm dwt:debug [runId|latest]`. End user (plugin install):
// `node "${CLAUDE_PLUGIN_ROOT}/bin/dwt-debug.mjs" [runId|latest]`.

import { findJournal } from './source.js'
import { parseJournal } from './journal.js'
import { diagnoseRun } from './diagnose.js'
import { formatDiagnosis } from './format.js'

interface CliArgs {
  runId: string | null
  json: boolean
  project: string | undefined
}

function parseArgs(argv: string[]): CliArgs {
  let runId: string | null = null
  let json = false
  let project: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--json') json = true
    else if (a === '--project') project = argv[++i]
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else if (!a.startsWith('-')) runId = a
  }
  return { runId, json, project }
}

function printHelp(): void {
  process.stdout.write(
    [
      'dwt-debug — diagnose a Claude Code Workflow run from its journal',
      '',
      'Usage: dwt-debug [runId|latest] [--json] [--project <slug>]',
      '',
      '  runId        wf_<id> of the run (with or without the wf_ prefix). Omit or',
      '               pass "latest" to diagnose the newest run in the current project.',
      '  --json       emit the raw diagnosis as JSON instead of the text report.',
      '  --project    search a specific ~/.claude/projects/<slug> instead of the cwd.',
      '',
    ].join('\n') + '\n',
  )
}

function main(): number {
  const { runId, json, project } = parseArgs(process.argv.slice(2))
  const resolved = findJournal(runId, project ? { project } : {})
  if (!resolved) {
    const which = runId && runId !== 'latest' ? `run "${runId}"` : 'any run in this project'
    process.stderr.write(
      `dwt-debug: no journal found for ${which}.\n` +
        '  Journals live at ~/.claude/projects/<project>/<session>/workflows/wf_<runId>.json.\n' +
        '  Run dwt-debug from the project that produced the run, or pass --project <slug>.\n',
    )
    return 1
  }

  const journal = parseJournal(resolved.text)
  if (!journal) {
    process.stderr.write(`dwt-debug: ${resolved.path} is not a readable workflow journal.\n`)
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
      formatDiagnosis(diagnosis, { journalPath: resolved.path, sessionId: resolved.sessionId }) +
        '\n',
    )
  }
  return 0
}

process.exit(main())
