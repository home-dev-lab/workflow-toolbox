// CLI entry for the per-tracked-card cost report (card #1826896411828946028). IMPURE (reads
// disk); held out of `pnpm test` like report-cli.ts / cli.ts — not one of the DEBUGGER_ENTRIES
// bundled to a shipped bin (build-bundles.ts), a dev-only `tsx`-invoked tool like report-cli.ts.
//
//   pnpm wt:card-cost -- --subagents-dir <dir> [--card-id <id>] [--name <n> ...] [--agent-id <id> ...]
//
// Deliberately scope-explicit (see card-cost-scan.ts's module doc): this CLI does not sweep a
// session directory or infer scope from a time window — the caller (a pilot/orchestrator that
// knows exactly which agents it spawned for this card) supplies the names/ids. Prints the
// CardCostReport as JSON to stdout; exit 0 even when zero agents matched — the report says so
// explicitly (coveredAgents/totalAgents, plus this CLI's own unmatchedNames/unmatchedIds),
// never a silent empty success indistinguishable from a wrong path or a typo'd name.

import { scanCardCostAgents } from './card-cost-scan.js'
import { buildCardCostReport } from './card-cost.js'

interface CardCostArgs {
  subagentsDir: string | null
  cardId: string | null
  names: string[]
  agentIds: string[]
  help: boolean
  error?: string
}

function parseCardCostArgs(argv: string[]): CardCostArgs {
  const r: CardCostArgs = { subagentsDir: null, cardId: null, names: [], agentIds: [], help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') {
      r.help = true
    } else if (a === '--subagents-dir') {
      const v = argv[++i]
      if (v === undefined) return { ...r, error: '--subagents-dir requires a value.' }
      r.subagentsDir = v
    } else if (a.startsWith('--subagents-dir=')) {
      r.subagentsDir = a.slice('--subagents-dir='.length)
    } else if (a === '--card-id') {
      const v = argv[++i]
      if (v === undefined) return { ...r, error: '--card-id requires a value.' }
      r.cardId = v
    } else if (a.startsWith('--card-id=')) {
      r.cardId = a.slice('--card-id='.length)
    } else if (a === '--name') {
      const v = argv[++i]
      if (v === undefined) return { ...r, error: '--name requires a value.' }
      r.names.push(v)
    } else if (a.startsWith('--name=')) {
      r.names.push(a.slice('--name='.length))
    } else if (a === '--agent-id') {
      const v = argv[++i]
      if (v === undefined) return { ...r, error: '--agent-id requires a value.' }
      r.agentIds.push(v)
    } else if (a.startsWith('--agent-id=')) {
      r.agentIds.push(a.slice('--agent-id='.length))
    }
  }
  return r
}

function printHelp(): void {
  process.stdout.write(
    [
      'wt-card-cost — per-tracked-card token/activity cost report from EXPLICITLY named agents',
      '',
      'Usage: wt:card-cost -- --subagents-dir <dir> [--card-id <id>] [--name <n> ...] [--agent-id <id> ...]',
      '',
      "  --subagents-dir  the session's flat subagents/ dir (NOT subagents/workflows/<runId>)",
      '  --card-id        tag stamped into the output JSON (informational only)',
      "  --name           match agents by their meta.json `name` (repeatable)",
      '  --agent-id       match agents by exact agent-<id> stem (repeatable)',
      '',
      'At least one of --name/--agent-id is required — this CLI never sweeps the whole',
      'directory or infers scope from a time window (see card-cost-scan.ts).',
      '',
      'Scope disclosed: Claude-side agents only. An external-provider lane (opencode/codex)',
      'runs compute this tool cannot see — name that gap explicitly wherever this report is used.',
      '',
    ].join('\n') + '\n',
  )
}

function main(): number {
  const { subagentsDir, cardId, names, agentIds, help, error } = parseCardCostArgs(process.argv.slice(2))
  if (help) {
    printHelp()
    return 0
  }
  if (error) {
    process.stderr.write(`wt-card-cost: ${error}\n`)
    return 2
  }
  if (subagentsDir === null) {
    process.stderr.write('wt-card-cost: --subagents-dir is required.\n')
    return 2
  }
  if (names.length === 0 && agentIds.length === 0) {
    process.stderr.write('wt-card-cost: at least one --name or --agent-id is required (no directory-wide sweep).\n')
    return 2
  }

  const inputs = scanCardCostAgents(subagentsDir, { names, agentIds })
  const report = buildCardCostReport(cardId, inputs)

  // Name what was requested but never matched — a silent gap here is exactly the failure mode
  // this tool exists to avoid (see the memory fiche numbers-carry-their-set-and-unit).
  const matchedNames = new Set(inputs.map((i) => i.name).filter((n): n is string => n !== null))
  const matchedIds = new Set(inputs.map((i) => i.agentId))
  const unmatchedNames = names.filter((n) => !matchedNames.has(n))
  const unmatchedIds = agentIds.filter((id) => !matchedIds.has(id))

  process.stdout.write(JSON.stringify({ ...report, unmatchedNames, unmatchedIds }, null, 2) + '\n')
  if (unmatchedNames.length > 0 || unmatchedIds.length > 0) {
    process.stderr.write(
      `[card-cost] WARNING: ${unmatchedNames.length} name(s) and ${unmatchedIds.length} id(s) requested but not found under ${subagentsDir}.\n`,
    )
  }
  return 0
}

process.exit(main())
