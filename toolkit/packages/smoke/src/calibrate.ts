// calibrate.ts — IMPURE budgetFloor-calibration runner (held out of `pnpm test`,
// like run.ts / canary-all.ts; still typechecked). Two modes:
//
//   pnpm wt:calibrate record [--workflow <path>] [--claims N] [--label L]
//       Drive a workflow through the REAL runtime (the wt-calib probe by default),
//       capture the task_notification usage + the output file, and APPEND one
//       RunStatsRecord to run-stats/runs.jsonl (gitignored, per-machine real data).
//
//   pnpm wt:calibrate derive [--claims N] [--votes N] [--synthesis N] [--margin M]
//       Read the log, segregate the authoritative vs observed token signals, and
//       print a recommended budgetFloor for the scenario (or an honest "no signal").
//
// It spends real agent runs and needs local Claude Code subscription auth (the SDK
// reuses ~/.claude — no API key in env), exactly like the smoke harness.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  annotateAuth,
  isAbortError,
  isRecord,
  readTaskNotification,
  readToolResult,
  readWorkflowToolUse,
  launchVerdict,
} from './lib.js'
import {
  readTaskUsage,
  summarizeRun,
  deriveCalibration,
  recommendFloor,
  formatCalibrationReport,
  CALIBRATION_SCHEMA_VERSION,
  type RunStatsRecord,
  type TaskUsage,
} from './calibrate-lib.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLKIT_ROOT = join(HERE, '../../..')
const DEFAULT_PROBE = join(HERE, '../wt-calib.js')
const DEFAULT_LOG = join(TOOLKIT_ROOT, 'run-stats', 'runs.jsonl')

const ROUNDTRIP_TIMEOUT_MS = 240_000

// ---------------------------------------------------------------------------
// arg parsing (minimal, mirrors the other toolkit CLIs)
// ---------------------------------------------------------------------------

interface Args {
  mode: string | null
  workflow: string
  claims: number | null
  votes: number | null
  synthesis: number | null
  margin: number | null
  label: string | null
  log: string
}

/** Parse a CLI numeric flag to a finite number, or null (ignored) on garbage —
 *  keeps NaN out of the scenario math. */
function finiteNum(v: string | undefined): number | null {
  if (v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    mode: null,
    workflow: DEFAULT_PROBE,
    claims: null,
    votes: null,
    synthesis: null,
    margin: null,
    label: null,
    log: DEFAULT_LOG,
  }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!
    if (t === '--workflow' || t === '-w') a.workflow = argv[++i] ?? a.workflow
    else if (t === '--claims') a.claims = finiteNum(argv[++i])
    else if (t === '--votes') a.votes = finiteNum(argv[++i])
    else if (t === '--synthesis') a.synthesis = finiteNum(argv[++i])
    else if (t === '--margin') a.margin = finiteNum(argv[++i])
    else if (t === '--label') a.label = argv[++i] ?? null
    else if (t === '--log') a.log = argv[++i] ?? a.log
    else if (t === '--help' || t === '-h') {
      printHelp()
      process.exit(0)
    } else if (!t.startsWith('-') && a.mode === null) a.mode = t
  }
  return a
}

function printHelp(): void {
  console.log(
    [
      'wt:calibrate — derive a budgetFloor from real run statistics',
      '',
      'Usage:',
      '  pnpm wt:calibrate record [--workflow <path>] [--claims N] [--label L]',
      '  pnpm wt:calibrate derive [--claims N] [--votes N] [--synthesis N] [--margin M]',
      '',
      'record  drive a workflow live (the wt-calib probe by default) and append one',
      '        RunStatsRecord to run-stats/runs.jsonl. Spends real agent runs.',
      'derive  read the log and print a recommended budgetFloor (or an honest no-signal).',
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------
// record — drive one real run, capture usage + output, append a record
// ---------------------------------------------------------------------------

// Drive the same way the proven smoke round-trip does (run.ts): a single string
// prompt + maxTurns, looping until the background task_notification arrives. The
// probe workflow is kept small + fast (like wt-smoke's generateAndFilter) so it
// completes inside the window the SDK keeps the stream open for.
const LAUNCH_MAX_TURNS = 4

function launchPromptWithClaims(scriptPath: string, claims: number | null): string {
  const argsClause =
    claims !== null ? ` and args set to the JSON object {"claims": ${claims}}` : ''
  return (
    `Call the Workflow tool exactly once with scriptPath set to "${scriptPath}"${argsClause}. ` +
    `Do not read or write any files and do not do anything else. After the tool returns, stop.`
  )
}

interface RecordOutcome {
  runId: string | null
  status: string | null
  output: unknown
  usage: TaskUsage | null
}

async function driveRun(scriptPath: string, claims: number | null): Promise<RecordOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ROUNDTRIP_TIMEOUT_MS)
  const q = query({
    prompt: launchPromptWithClaims(scriptPath, claims),
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      allowedTools: ['Workflow'],
      settingSources: [],
      maxTurns: LAUNCH_MAX_TURNS,
      abortController: controller,
    },
  })

  const outcome: RecordOutcome = { runId: null, status: null, output: undefined, usage: null }
  let expectedToolUseId: string | null = null

  try {
    for await (const message of q) {
      const toolUse = readWorkflowToolUse(message)
      if (toolUse !== null) expectedToolUseId = toolUse.id

      const toolResult = readToolResult(message)
      if (toolResult !== null) {
        const verdict = launchVerdict(toolResult)
        if (!verdict.ok) {
          outcome.status = `launch-failed: ${verdict.reason}`
          break
        }
      }

      const notification = readTaskNotification(message)
      if (
        notification !== null &&
        (expectedToolUseId === null || notification.toolUseId === expectedToolUseId)
      ) {
        outcome.runId = notification.taskId
        outcome.status = notification.status
        outcome.usage = readTaskUsage(message)
        if (notification.status === 'completed' && notification.outputFile !== null) {
          try {
            outcome.output = JSON.parse(readFileSync(notification.outputFile, 'utf8'))
          } catch (err) {
            outcome.status = `read-output-failed: ${(err as Error).message}`
          }
        }
        break
      }
    }
  } catch (err) {
    if (!isAbortError(err)) throw err
    if (outcome.status === null) outcome.status = `timed out after ${ROUNDTRIP_TIMEOUT_MS} ms`
  } finally {
    clearTimeout(timer)
  }
  return outcome
}

async function runRecord(a: Args): Promise<number> {
  const label = a.label ?? a.workflow.replace(/^.*\//, '').replace(/\.js$/, '')
  console.log(`[calibrate] recording a live run of ${label}${a.claims !== null ? ` (claims=${a.claims})` : ''}…`)

  let outcome: RecordOutcome
  try {
    outcome = await driveRun(a.workflow, a.claims)
  } catch (err) {
    console.error(`[calibrate] FAILED: ${annotateAuth(err).message}`)
    return 1
  }

  if (outcome.status !== 'completed' || !isRecord(outcome.output)) {
    console.error(`[calibrate] run did not complete cleanly: ${outcome.status ?? 'no completion'}`)
    return 1
  }

  const record: RunStatsRecord = summarizeRun({
    label,
    timestamp: new Date().toISOString(), // injected here so the pure layer stays deterministic
    runId: outcome.runId,
    output: outcome.output,
    usage: outcome.usage,
  })

  mkdirSync(dirname(a.log), { recursive: true })
  appendFileSync(a.log, JSON.stringify(record) + '\n', 'utf8')

  console.log(`[calibrate] appended to ${a.log}:`)
  console.log(
    `  agents=${record.runtimeAgentCount ?? '?'}  budgetSpent=${record.budgetSpent ?? '—'}  ` +
      `notif.totalTokens=${record.notificationTotalTokens ?? '—'}  notif.toolUses=${record.notificationToolUses ?? '—'}`,
  )
  if (record.notes.length > 0) console.log(`  notes: ${record.notes.join('; ')}`)
  return 0
}

// ---------------------------------------------------------------------------
// derive — read the log, print the calibration report
// ---------------------------------------------------------------------------

function readLog(logPath: string): RunStatsRecord[] {
  if (!existsSync(logPath)) return []
  const out: RunStatsRecord[] = []
  let bad = 0
  let futureSchema = 0
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed) as RunStatsRecord
      // Forward-compat guard: skip records written by a newer schema than this
      // build understands, rather than silently mixing incompatible shapes.
      if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > CALIBRATION_SCHEMA_VERSION) {
        futureSchema++
        continue
      }
      out.push(parsed)
    } catch {
      bad++
    }
  }
  if (bad > 0) console.log(`[calibrate] skipped ${bad} unparseable log line(s)`)
  if (futureSchema > 0) {
    console.log(
      `[calibrate] skipped ${futureSchema} record(s) from a newer schema (> v${CALIBRATION_SCHEMA_VERSION}) — upgrade the toolkit`,
    )
  }
  return out
}

function runDerive(a: Args): number {
  const records = readLog(a.log)
  if (records.length === 0) {
    console.error(
      `[calibrate] no records at ${a.log} — run \`pnpm wt:calibrate record\` first ` +
        `(or pass --log <path> to a seeded log).`,
    )
    return 1
  }

  const cal = deriveCalibration(records)
  const scenario: Parameters<typeof recommendFloor>[1] = {}
  if (a.claims !== null) scenario.expectedClaims = a.claims
  if (a.votes !== null) scenario.votesPerClaim = a.votes
  if (a.synthesis !== null) scenario.synthesisAgents = a.synthesis
  if (a.margin !== null) scenario.safetyMargin = a.margin

  const rec = recommendFloor(cal, scenario)
  console.log('')
  console.log(formatCalibrationReport(cal, rec))
  console.log('')
  return 0
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2))
  if (a.mode === 'record') return runRecord(a)
  if (a.mode === 'derive') return runDerive(a)
  printHelp()
  if (a.mode !== null) console.error(`\n[calibrate] unknown mode "${a.mode}" — use record or derive.`)
  return a.mode === null ? 0 : 1
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`[calibrate] FATAL: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  })
