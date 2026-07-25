// PURE per-agent transcript token-usage parser. A workflow agent's transcript
// (`subagents/workflows/<runId>/agent-<id>.jsonl`) is the ONLY place the real billed
// token usage lives — the run journal carries just an aggregate `tokens` scalar (a
// different measure; see report.ts, NEVER reconciled against this). This module sums one
// transcript's usage so the audit report can show an input/output/cache breakdown.
//
// Correctness core (verified against real transcripts): each `assistant` line carries a
// `.message.usage` block, but the SAME logical message is streamed across MULTIPLE lines
// with `output_tokens` growing toward its final value (e.g. 4 → 134) under one stable
// `message.id`. Summing every line double-counts. So we DEDUP by `message.id`, keeping the
// snapshot with the greatest `output_tokens` (the final one — input/cache are stable within
// an id, so this co-selects the correct input/cache too), then sum across DISTINCT ids.
// Distinct ids are sequential agentic turns; the API bills each turn's input/cache, so
// summing them is the real billed cost (report-format.ts states this in its caveat).
//
// Tolerant by contract (this parses an untrusted on-disk file): malformed lines, non-
// assistant lines, and usage-less lines are skipped; an empty transcript yields zeros; it
// never throws. Reuses the @workflow-toolbox/std narrowers — no local redefinition.

import { isRecord, numOrNull, strOrNull } from '@workflow-toolbox/std'

/** One agent's billed token usage, summed across its transcript. */
export interface AgentUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
}

/** Whether a usage carries any billed tokens. The single definition of "this transcript counts
 *  toward report coverage" — a present-but-empty transcript must not inflate the rollup. */
export function isNonEmptyUsage(u: AgentUsage): boolean {
  return u.inputTokens > 0 || u.outputTokens > 0 || u.cacheReadTokens > 0 || u.cacheCreationTokens > 0
}

/** Field-wise sum (used to roll per-agent usage into a run total). Pure — no mutation. */
export function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  }
}

/** Read the four scalar token fields off a `usage` record (defaults 0). The real block also
 *  carries a NESTED `cache_creation` object — we read only the scalar
 *  `cache_creation_input_tokens` (numOrNull on the object returns null, so it can't leak). */
function readUsage(usage: Record<string, unknown>): AgentUsage {
  return {
    inputTokens: numOrNull(usage['input_tokens']) ?? 0,
    outputTokens: numOrNull(usage['output_tokens']) ?? 0,
    cacheReadTokens: numOrNull(usage['cache_read_input_tokens']) ?? 0,
    cacheCreationTokens: numOrNull(usage['cache_creation_input_tokens']) ?? 0,
  }
}

/** Dedup streamed assistant-message snapshots by `message.id`, keeping the snapshot with the
 *  greatest `output_tokens` (the final one — see module header: input/cache are stable within
 *  an id, so this co-selects the correct input/cache too). Lines without an id get a unique
 *  synthetic key so they are never collapsed together. Returns the raw `message` records (not
 *  just their usage) — shared by `parseTranscriptUsage` (sums usage) AND `parseTranscriptActivity`
 *  (counts turns / tool_use blocks), so both stay consistent with the SAME streaming-dedup rule:
 *  they would have to change together if that rule ever did (same reason to change, not just
 *  same shape — the Rule-of-Three generalize case). Only admits assistant lines carrying a
 *  `usage` block, matching the original parseTranscriptUsage admission rule exactly. */
function dedupAssistantMessages(jsonl: string): Map<string, Record<string, unknown>> {
  const finals = new Map<string, Record<string, unknown>>()
  let synthetic = 0

  for (const raw of jsonl.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // malformed line — skip
    }
    if (!isRecord(parsed) || parsed['type'] !== 'assistant') continue
    const message = parsed['message']
    if (!isRecord(message)) continue
    const usage = message['usage']
    if (!isRecord(usage)) continue

    const key = strOrNull(message['id']) ?? ` synthetic-${synthetic++}`
    const currentOutput = numOrNull(usage['output_tokens']) ?? 0
    const prior = finals.get(key)
    const priorUsage = prior ? prior['usage'] : undefined
    const priorOutput = isRecord(priorUsage) ? numOrNull(priorUsage['output_tokens']) ?? 0 : -1
    // Keep the higher-output snapshot for a given id (the final streamed value).
    if (prior === undefined || currentOutput >= priorOutput) finals.set(key, message)
  }

  return finals
}

/** Sum one agent transcript's billed token usage, deduping streaming snapshots by
 *  `message.id`. Never throws; an empty / unparseable transcript yields `emptyUsage()`. */
export function parseTranscriptUsage(jsonl: string): AgentUsage {
  const finals = dedupAssistantMessages(jsonl)
  let total = emptyUsage()
  for (const message of finals.values()) {
    const usage = message['usage']
    if (isRecord(usage)) total = addUsage(total, readUsage(usage))
  }
  return total
}

/** One transcript's ACTIVITY shape (turns / tool calls / wall-clock span) — the companion
 *  measure to `parseTranscriptUsage` for card-cost reporting (turns/tool-calls answer "how much
 *  work", tokens answer "how much it cost"; per `numbers-carry-their-set-and-unit`, a raw LINE
 *  count is not a turn count — a single billed turn streams across many lines). */
export interface TranscriptActivity {
  /** Distinct billed assistant turns — same admission/dedup rule as parseTranscriptUsage
   *  (message.id, or a synthetic key when absent), so "turns" and "tokens" always agree on
   *  what counts as one turn. */
  turns: number
  /** `tool_use` content blocks across the DEDUPED (final-snapshot) assistant messages — a
   *  streamed partial snapshot of the same message could carry a different block set than its
   *  final snapshot, so counting only the final snapshot avoids double-counting one tool call
   *  seen in an intermediate delta too. */
  toolCalls: number
  /** Earliest / latest top-level `timestamp` across EVERY line (not just assistant/deduped —
   *  user and tool-result lines bound the real wall-clock span too). Null when no line carried
   *  a parseable timestamp. */
  firstTimestamp: string | null
  lastTimestamp: string | null
}

export function emptyActivity(): TranscriptActivity {
  return { turns: 0, toolCalls: 0, firstTimestamp: null, lastTimestamp: null }
}

/** Parse one agent transcript's activity: distinct turns, tool_use calls, and wall-clock span.
 *  Never throws; an empty / unparseable transcript yields `emptyActivity()`. */
export function parseTranscriptActivity(jsonl: string): TranscriptActivity {
  const finals = dedupAssistantMessages(jsonl)
  let toolCalls = 0
  for (const message of finals.values()) {
    const content = message['content']
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (isRecord(block) && block['type'] === 'tool_use') toolCalls++
    }
  }

  let firstTimestamp: string | null = null
  let lastTimestamp: string | null = null
  for (const raw of jsonl.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // malformed line — skip
    }
    if (!isRecord(parsed)) continue
    const ts = strOrNull(parsed['timestamp'])
    if (ts === null) continue
    if (firstTimestamp === null || ts < firstTimestamp) firstTimestamp = ts
    if (lastTimestamp === null || ts > lastTimestamp) lastTimestamp = ts
  }

  return { turns: finals.size, toolCalls, firstTimestamp, lastTimestamp }
}

/** One auto/manual compaction boundary found in an agent transcript. Read DEFENSIVELY: the
 *  runtime event (`type:'system', subtype:'compact_boundary'`) carries a rich `compactMetadata`,
 *  but the SDK type (`SDKCompactBoundaryMessage`) only guarantees `{ trigger, preTokens }` — older
 *  or future shapes may omit the rest, so every field is `| null`. */
export interface CompactionEvent {
  /** 'auto' | 'manual' — how the compaction fired. */
  trigger: string | null
  /** Pre-compaction context size: the TRUE peak the run journal's post-compaction total erases. */
  preTokens: number | null
  /** Context size kept after compaction. */
  postTokens: number | null
  /** Tokens summarized away (`cumulativeDroppedTokens`) — the magnitude of potential fidelity loss. */
  droppedTokens: number | null
  /** How long the compaction took, in ms. */
  durationMs: number | null
}

/** Compaction summary for one agent transcript: whether it compacted, each boundary, and the
 *  peak context reached (max `preTokens`) — the resource-pressure signal the journal's
 *  post-compaction `totalTokens` hides. */
export interface TranscriptCompaction {
  compacted: boolean
  events: CompactionEvent[]
  peakTokens: number | null
}

/** Scan one agent transcript for `compact_boundary` system events. Pure and tolerant (never
 *  throws): malformed / non-compaction lines are skipped; a transcript with no boundary yields
 *  `{ compacted: false, events: [], peakTokens: null }`. */
export function parseTranscriptCompaction(jsonl: string): TranscriptCompaction {
  const events: CompactionEvent[] = []
  for (const raw of jsonl.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // malformed line — skip
    }
    if (!isRecord(parsed) || parsed['type'] !== 'system' || parsed['subtype'] !== 'compact_boundary') continue
    const meta = isRecord(parsed['compactMetadata']) ? parsed['compactMetadata'] : {}
    events.push({
      trigger: strOrNull(meta['trigger']),
      preTokens: numOrNull(meta['preTokens']),
      postTokens: numOrNull(meta['postTokens']),
      droppedTokens: numOrNull(meta['cumulativeDroppedTokens']),
      durationMs: numOrNull(meta['durationMs']),
    })
  }
  const peaks = events.map((e) => e.preTokens).filter((n): n is number => n !== null)
  return {
    compacted: events.length > 0,
    events,
    // reduce, NOT Math.max(...peaks): a pathological transcript with a huge boundary count would
    // blow the argument-spread limit and THROW, violating this parser's never-throws contract (and
    // — since scanTranscripts wraps no per-parse try/catch — aborting the whole scan, which would
    // also suppress the tool-denial signal read in the same pass).
    peakTokens: reduceOrNull(peaks, (a, b) => Math.max(a, b)),
  }
}

/** One agent's compaction, projected for the run-level report. `label` is filled downstream by
 *  the report builder from the journal rows (the transcript alone doesn't carry it), mirroring
 *  ToolDenial. `peakTokens` is the agent's worst pre-compaction size; `droppedTokens` is the
 *  cumulative amount summarized away (the MAX of its boundaries' `cumulativeDroppedTokens`, since
 *  that field is already cumulative — never a sum). */
export interface CompactionAgent {
  agentId: string
  label?: string
  peakTokens: number | null
  droppedTokens: number | null
  /** How the PEAK (max-preTokens) boundary fired: 'auto' | 'manual' | null — matched to peakTokens
   *  so the rendered Trigger column always describes the SAME boundary as the Peak beside it; falls
   *  back to the first non-null trigger only when the peak boundary can't be identified. */
  trigger: string | null
  /** Number of compaction boundaries in this agent's transcript. */
  boundaries: number
}

/** A run-level ADVISORY rollup of auto-compaction across a run's agents. Deliberately NOT the
 *  ToolDenialReport `degraded` shape: a compacted run still SUCCEEDED — this is a softer "an agent
 *  over-scoped, watch its fidelity" signal, not a "the run may be blind" one. */
export interface CompactionReport {
  /** Distinct agents that auto-compacted at least once. */
  agentsCompacted: number
  /** The worst pre-compaction peak across all compacted agents (max) — the run's tightest squeeze
   *  and the figure the journal's post-compaction `totalTokens` erases. Null when unknown. */
  peakTokens: number | null
  /** Total tokens summarized away across all compacted agents (sum of each agent's cumulative
   *  drop). Null when no agent reported a drop figure. */
  droppedTokens: number | null
  /** Per-agent rows, sorted worst-pressure-first (highest peak). */
  agents: CompactionAgent[]
  /** True when any agent compacted — the advisory (NOT degraded) signal. */
  compacted: boolean
}

/** An explicit not-compacted report — the safe default when no compaction data was injected. */
export function emptyCompactionReport(): CompactionReport {
  return { agentsCompacted: 0, peakTokens: null, droppedTokens: null, agents: [], compacted: false }
}

/** Reduce a non-empty numeric list; null when the list is empty (keeps "unknown" distinct from 0). */
function reduceOrNull(nums: number[], fn: (a: number, b: number) => number): number | null {
  return nums.length === 0 ? null : nums.reduce(fn)
}

/** Merge multiple CompactionReports (e.g. per-stage pipeline reports) into ONE combined report.
 *  Concatenates all per-agent rows, recomputes aggregates, and re-sorts worst-peak-first.
 *  Mirrors rollupPipelineDenials for the compaction signal. Never throws. */
export function mergeCompactionReports(reports: CompactionReport[]): CompactionReport {
  const agents: CompactionAgent[] = reports.flatMap((r) => r.agents)
  agents.sort((a, b) => (b.peakTokens ?? -1) - (a.peakTokens ?? -1) || a.agentId.localeCompare(b.agentId))
  const peaks = agents.map((a) => a.peakTokens).filter((n): n is number => n !== null)
  const drops = agents.map((a) => a.droppedTokens).filter((n): n is number => n !== null)
  return {
    agentsCompacted: agents.length,
    peakTokens: reduceOrNull(peaks, (a, b) => Math.max(a, b)),
    droppedTokens: reduceOrNull(drops, (a, b) => a + b),
    agents,
    compacted: agents.length > 0,
  }
}

/** Roll per-agent TranscriptCompaction into one run-level advisory report (mirrors
 *  buildToolDenialReport). Non-compacted entries are skipped defensively. Never throws. */
export function buildCompactionReport(
  perAgent: Iterable<{ agentId: string; label?: string; compaction: TranscriptCompaction }>,
): CompactionReport {
  const agents: CompactionAgent[] = []
  for (const { agentId, label, compaction } of perAgent) {
    if (!compaction.compacted || compaction.events.length === 0) continue
    // cumulativeDroppedTokens is cumulative within an agent → the agent's total drop is the MAX
    // across its boundaries, never a sum.
    const drops = compaction.events.map((e) => e.droppedTokens).filter((n): n is number => n !== null)
    // Trigger of the PEAK boundary (the one whose preTokens IS peakTokens), so the table's Trigger
    // column and Peak column always describe the same boundary. Fall back to the first non-null
    // trigger when the peak is null / no boundary matches.
    const peakEvent = compaction.events.find(
      (e) => compaction.peakTokens !== null && e.preTokens === compaction.peakTokens,
    )
    const trigger = peakEvent?.trigger ?? compaction.events.map((e) => e.trigger).find((t): t is string => t !== null) ?? null
    agents.push({
      agentId,
      ...(label !== undefined ? { label } : {}),
      peakTokens: compaction.peakTokens,
      droppedTokens: reduceOrNull(drops, (a, b) => Math.max(a, b)),
      trigger,
      boundaries: compaction.events.length,
    })
  }

  agents.sort((a, b) => (b.peakTokens ?? -1) - (a.peakTokens ?? -1) || a.agentId.localeCompare(b.agentId))

  const peaks = agents.map((a) => a.peakTokens).filter((n): n is number => n !== null)
  const drops = agents.map((a) => a.droppedTokens).filter((n): n is number => n !== null)
  return {
    agentsCompacted: agents.length,
    peakTokens: reduceOrNull(peaks, (a, b) => Math.max(a, b)),
    droppedTokens: reduceOrNull(drops, (a, b) => a + b),
    agents,
    compacted: agents.length > 0,
  }
}
