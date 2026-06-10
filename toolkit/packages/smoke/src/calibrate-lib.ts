// calibrate-lib.ts — PURE budgetFloor-calibration core (unit-tested in pnpm test).
//
// WHY THIS EXISTS
// The toolkit's §8 budgetFloor guidance ("≈ verifier cost × expected claims +
// synthesis") was aspirational: there were NO real numbers behind it. This module
// turns real-run statistics into a numerically-grounded floor recommendation.
//
// THE HARD HONESTY CONSTRAINT (do not paper over it)
// The Workflow runtime exposes NO per-agent token primitive — `budget.spent()`
// is turn-cumulative output tokens, and the PatternResult envelope is purely
// structural (agent COUNTS, no tokens). So "tokens per agent" can only ever be a
// CROSS-RUN STATISTICAL APPROXIMATION: total run tokens ÷ total agents spawned.
// It sizes a floor; it is never a reservation or an exact per-agent measurement.
//
// Two token signals exist, and they are NOT interchangeable:
//   - budgetSpent      — `rt.budget.spent()` surfaced by an instrumented workflow.
//                        AUTHORITATIVE (the runtime's own output-token accounting).
//   - notification     — the task_notification `usage.total_tokens` (free at the
//                        harness). OBSERVED — may be launch-session-scoped; trusted
//                        less. These are SEGREGATED in derive, never averaged
//                        together (plan-critic H2).
//
// Per-model token bucketing is deliberately NOT computed: dividing one whole-run
// token total by per-model agent counts would attribute (say) opus tokens to a
// haiku bucket — wrong in a way that looks precise (plan-critic H1). Records keep
// `patterns` as descriptive metadata only.

// Tiny defensive narrowing — shared with the rest of the toolkit (every reader takes `unknown`).
import { isRecord, numOrNull } from '@workflow-toolbox/std'

// ---------------------------------------------------------------------------
// Schema version — bump if RunStatsRecord changes shape (the JSONL log is
// append-only across versions; derive tolerates older lines).
// ---------------------------------------------------------------------------

export const CALIBRATION_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// TaskUsage — the previously-dropped task_notification `usage` block
// ---------------------------------------------------------------------------

export interface TaskUsage {
  totalTokens: number | null
  toolUses: number | null
  durationMs: number | null
}

/** Read the `usage` block off an SDK task_notification message. Returns null if
 *  this is not a task_notification at all; otherwise each field degrades to null
 *  on absence/drift (canary discipline — never throw on an upgraded shape). */
export function readTaskUsage(msg: unknown): TaskUsage | null {
  if (!isRecord(msg) || msg['type'] !== 'system' || msg['subtype'] !== 'task_notification') {
    return null
  }
  const usage = isRecord(msg['usage']) ? msg['usage'] : {}
  return {
    totalTokens: numOrNull(usage['total_tokens']),
    toolUses: numOrNull(usage['tool_uses']),
    durationMs: numOrNull(usage['duration_ms']),
  }
}

// ---------------------------------------------------------------------------
// RunStatsRecord — one persisted JSONL line for one real workflow run
// ---------------------------------------------------------------------------

export interface RunStatsRecord {
  schemaVersion: number
  /** Human label (the workflow / artifact name). */
  workflow: string
  /** ISO timestamp — INJECTED by the impure layer (keeps this layer deterministic). */
  timestamp: string
  runId: string | null
  /** Runtime-reported agent count (output file top-level `agentCount`) —
   *  the primary, shape-independent denominator. */
  runtimeAgentCount: number | null
  /** Envelope `stats.agentsSpawned` if a PatternResult was found — descriptive
   *  cross-check of runtimeAgentCount. */
  agentsSpawned: number | null
  /** AUTHORITATIVE token signal: `rt.budget.spent()` surfaced by the workflow. */
  budgetSpent: number | null
  /** OBSERVED token signal: task_notification usage.total_tokens (may be launch-scoped). */
  notificationTotalTokens: number | null
  notificationToolUses: number | null
  durationMs: number | null
  /** Distinct pattern names seen in the envelope trail — descriptive only. */
  patterns: string[]
  /** Diagnostic / honesty notes (e.g. "no token signal"). */
  notes: string[]
}

interface SummarizeRunInput {
  label: string
  timestamp: string
  runId?: string | null
  /** The parsed output file object: { summary, agentCount, logs, result }. */
  output: unknown
  /** Captured usage off the completion notification, or null if unavailable. */
  usage: TaskUsage | null
}

/** Find the first `stats`/`trail` PatternResult-shaped object reachable from the
 *  workflow's return value. Workflows return varied shapes ({envelope}, {marker,
 *  envelope}, a bare PatternResult, {budgetSpent, envelope}); look one level deep. */
function findEnvelope(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result)) return null
  if (isRecord(result['stats']) || Array.isArray(result['trail'])) return result
  for (const v of Object.values(result)) {
    if (isRecord(v) && (isRecord(v['stats']) || Array.isArray(v['trail']))) return v
  }
  return null
}

function patternsOf(envelope: Record<string, unknown> | null): string[] {
  if (envelope === null || !Array.isArray(envelope['trail'])) return []
  const names = new Set<string>()
  for (const entry of envelope['trail']) {
    if (isRecord(entry) && typeof entry['stage'] === 'string') {
      const name = entry['stage'].split(':')[0]
      if (name !== undefined && name.length > 0) names.add(name)
    }
  }
  return [...names].sort()
}

/** PURE: parsed output file (+ optional usage) → one RunStatsRecord. Never throws
 *  on a partial/odd shape — it fills nulls and records why in `notes`. */
export function summarizeRun(input: SummarizeRunInput): RunStatsRecord {
  const notes: string[] = []
  const output = input.output
  const runtimeAgentCount = isRecord(output) ? numOrNull(output['agentCount']) : null
  const result = isRecord(output) ? output['result'] : undefined

  const budgetSpent = isRecord(result) ? numOrNull(result['budgetSpent']) : null
  const envelope = findEnvelope(result)
  const stats = envelope !== null && isRecord(envelope['stats']) ? envelope['stats'] : null
  const agentsSpawned = stats !== null ? numOrNull(stats['agentsSpawned']) : null

  const notificationTotalTokens = input.usage?.totalTokens ?? null
  const notificationToolUses = input.usage?.toolUses ?? null
  const durationMs = input.usage?.durationMs ?? null

  if (budgetSpent === null && notificationTotalTokens === null) {
    notes.push(
      'no token signal — neither rt.budget.spent() nor task_notification usage was captured',
    )
  }
  if (runtimeAgentCount === null && agentsSpawned === null) {
    notes.push('no agent count — neither runtime agentCount nor an envelope was found')
  }

  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    workflow: input.label,
    timestamp: input.timestamp,
    runId: input.runId ?? null,
    runtimeAgentCount,
    agentsSpawned,
    budgetSpent,
    notificationTotalTokens,
    notificationToolUses,
    durationMs,
    patterns: patternsOf(envelope),
    notes,
  }
}

// ---------------------------------------------------------------------------
// deriveCalibration — aggregate N records, SEGREGATING the two token signals
// ---------------------------------------------------------------------------

export interface SignalAggregate {
  recordCount: number
  totalTokens: number
  totalAgents: number
  /** Σtokens / Σagents over the records that landed in THIS bucket (a record
   *  contributes to at most one bucket — see deriveCalibration) AND had a positive
   *  agent count; null when no such record exists (never NaN/Infinity). */
  avgTokensPerAgent: number | null
}

export interface Calibration {
  recordCount: number
  /** From records carrying the authoritative budget.spent() signal. */
  authoritative: SignalAggregate
  /** From records carrying ONLY the observed notification signal (segregated). */
  observed: SignalAggregate
  notes: string[]
}

/** The agent-count denominator for a record: prefer the runtime's own count,
 *  fall back to the envelope count, then the notification tool_uses. `borrowed`
 *  flags the last case — a denominator taken from the notification, which may not
 *  share the numerator's provenance (a cross-signal mix worth surfacing). */
function agentCountOf(r: RunStatsRecord): { count: number | null; borrowed: boolean } {
  if (r.runtimeAgentCount !== null) return { count: r.runtimeAgentCount, borrowed: false }
  if (r.agentsSpawned !== null) return { count: r.agentsSpawned, borrowed: false }
  return { count: r.notificationToolUses, borrowed: r.notificationToolUses !== null }
}

function finishAggregate(recordCount: number, totalTokens: number, totalAgents: number): SignalAggregate {
  return {
    recordCount,
    totalTokens,
    totalAgents,
    avgTokensPerAgent: totalAgents > 0 ? totalTokens / totalAgents : null,
  }
}

/** PURE: fold records into segregated authoritative + observed aggregates.
 *  A record contributes to AT MOST ONE bucket: authoritative if it has
 *  budgetSpent, else observed if it has a notification token total. The two are
 *  never blended into one mean (plan-critic H2). */
export function deriveCalibration(records: readonly RunStatsRecord[]): Calibration {
  let authCount = 0
  let authTokens = 0
  let authAgents = 0
  let obsCount = 0
  let obsTokens = 0
  let obsAgents = 0
  let noToken = 0
  let noAgentForToken = 0
  let borrowedDenom = 0

  for (const r of records) {
    const { count: agents, borrowed } = agentCountOf(r)
    if (r.budgetSpent !== null) {
      if (agents !== null && agents > 0) {
        authCount++
        authTokens += r.budgetSpent
        authAgents += agents
        if (borrowed) borrowedDenom++
      } else {
        noAgentForToken++
      }
    } else if (r.notificationTotalTokens !== null) {
      if (agents !== null && agents > 0) {
        obsCount++
        obsTokens += r.notificationTotalTokens
        obsAgents += agents
      } else {
        noAgentForToken++
      }
    } else {
      noToken++
    }
  }

  const notes: string[] = []
  if (noToken > 0) notes.push(`${noToken} record(s) had no token signal (structural only)`)
  if (noAgentForToken > 0) {
    notes.push(`${noAgentForToken} record(s) had a token signal but no positive agent count — excluded`)
  }
  if (borrowedDenom > 0) {
    notes.push(
      `${borrowedDenom} authoritative record(s) borrowed the agent count from the notification ` +
        `tool_uses (no runtime/envelope count) — denominator provenance differs from the numerator`,
    )
  }

  return {
    recordCount: records.length,
    authoritative: finishAggregate(authCount, authTokens, authAgents),
    observed: finishAggregate(obsCount, obsTokens, obsAgents),
    notes,
  }
}

// ---------------------------------------------------------------------------
// recommendFloor — turn the average into a budgetFloor for a named scenario
// ---------------------------------------------------------------------------

export interface FloorScenario {
  /** Expected number of claims/findings the verification loop will face. */
  expectedClaims: number
  /** Verifier votes per claim (default 3 — adversarialVerification's default). */
  votesPerClaim: number
  /** Extra non-verifier agents (synthesis / planner). Default 1. */
  synthesisAgents: number
  /** Headroom multiplier so the floor cuts breadth before integrity. Default 1.5. */
  safetyMargin: number
}

const DEFAULT_SCENARIO: FloorScenario = {
  expectedClaims: 5,
  votesPerClaim: 3,
  synthesisAgents: 1,
  safetyMargin: 1.5,
}

export interface FloorRecommendation {
  scenario: FloorScenario
  /** Which signal backed the number. 'none' → no usable token data. */
  source: 'authoritative' | 'observed' | 'none'
  avgTokensPerAgent: number | null
  expectedAgents: number
  /** Rounded recommended floor, or null when source is 'none' (B1 degrade path). */
  recommendedFloor: number | null
  rationale: string
}

/** PURE: floor ≈ avgTokensPerAgent × (expectedClaims × votesPerClaim +
 *  synthesisAgents) × safetyMargin. Prefers the authoritative average; falls back
 *  to the observed (clearly labelled) one; yields a null floor WITH a reason when
 *  neither exists — it never invents a number (plan-critic B1). */
export function recommendFloor(
  cal: Calibration,
  scenario: Partial<FloorScenario>,
): FloorRecommendation {
  const s: FloorScenario = { ...DEFAULT_SCENARIO, ...scenario }
  const expectedAgents = s.expectedClaims * s.votesPerClaim + s.synthesisAgents

  const auth = cal.authoritative.avgTokensPerAgent
  const obs = cal.observed.avgTokensPerAgent
  const source: FloorRecommendation['source'] = auth !== null ? 'authoritative' : obs !== null ? 'observed' : 'none'
  const avg = source === 'authoritative' ? auth : source === 'observed' ? obs : null

  if (avg === null) {
    return {
      scenario: s,
      source: 'none',
      avgTokensPerAgent: null,
      expectedAgents,
      recommendedFloor: null,
      rationale:
        'No usable token signal across the recorded runs (insufficient data) — ' +
        'budgetFloor sizing stays heuristic. Capture more runs with `pnpm wt:calibrate record`.',
    }
  }

  const floor = Math.round(avg * expectedAgents * s.safetyMargin)
  const sourceNote =
    source === 'observed'
      ? ' (from the OBSERVED notification signal — may include launch-session overhead; treat as an upper bound)'
      : ''
  return {
    scenario: s,
    source,
    avgTokensPerAgent: avg,
    expectedAgents,
    recommendedFloor: floor,
    rationale:
      `≈ ${Math.round(avg)} output tokens/agent × ${expectedAgents} agents ` +
      `(${s.expectedClaims} claims × ${s.votesPerClaim} votes + ${s.synthesisAgents} synthesis) ` +
      `× ${s.safetyMargin} margin ≈ ${floor}${sourceNote}. ` +
      'Cross-run approximation, not a per-agent guarantee.',
  }
}

// ---------------------------------------------------------------------------
// formatCalibrationReport — human-readable report (mirrors the debugger/canary style)
// ---------------------------------------------------------------------------

function fmtAgg(label: string, a: SignalAggregate): string {
  const avg = a.avgTokensPerAgent !== null ? `${Math.round(a.avgTokensPerAgent)} tok/agent` : 'n/a'
  return `  ${label}: ${a.recordCount} run(s), ${a.totalTokens} tok / ${a.totalAgents} agents → ${avg}`
}

/** PURE: the printable calibration report. Always carries the cross-run
 *  approximation caveat; on the no-signal path it states that honestly instead of
 *  printing a fabricated floor. */
export function formatCalibrationReport(cal: Calibration, rec: FloorRecommendation): string {
  const lines: string[] = []
  lines.push('budgetFloor calibration')
  lines.push('─'.repeat(48))
  lines.push(`records: ${cal.recordCount}`)
  lines.push(fmtAgg('authoritative (budget.spent)', cal.authoritative))
  lines.push(fmtAgg('observed (notification usage)', cal.observed))
  for (const n of cal.notes) lines.push(`  note: ${n}`)
  lines.push('')
  lines.push(
    'Tokens-per-agent is a CROSS-RUN APPROXIMATION — the runtime exposes no per-agent',
  )
  lines.push('token primitive. Use it to size a floor, not as a reservation.')
  lines.push('')
  if (rec.source === 'none' || rec.recommendedFloor === null) {
    lines.push(`No recommendation: ${rec.rationale}`)
  } else {
    lines.push(
      `Recommended budgetFloor (${rec.source}) for ` +
        `${rec.scenario.expectedClaims} claims × ${rec.scenario.votesPerClaim} votes: ${rec.recommendedFloor}`,
    )
    lines.push(`  ${rec.rationale}`)
  }
  return lines.join('\n')
}
