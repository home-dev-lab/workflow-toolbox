// card-cost.ts — PURE per-tracked-CARD cost rollup. Given each contributing agent's ALREADY
// PARSED transcript usage + activity + identity (model/agentType/name), produce the total AND
// "fresh-compute" breakdown for one card's arc. Pure — no IO, no task-tracker coupling (Planka
// is the impure caller's business) — so it is fully unit-tested. The impure disk-reading layer
// (which agent belongs to the card, and reads their transcripts) is card-cost-scan.ts.
//
// "Fresh compute" = input + output + cache-WRITE, excluding cache-READ. This convention was
// established and cross-verified (zero delta, two independent re-derivations) the night of
// 2026-07-24→25 — see the memory fiche `journal-token-breakdown` and card
// #1827133895158531377. A cache read is a cheap re-read of context already paid for; folding it
// into "compute" masks where the real cost goes.
//
// Scope, disclosed explicitly here (never silently assumed by a caller): this rolls up
// CLAUDE-side agents only. An external-provider lane (an opencode/codex bridge call) runs a
// DIFFERENT model's compute that never appears in a Claude transcript — buildCardCostReport has
// no way to see it. A caller that presents this report as "the card's total cost" without
// naming that gap repeats the exact mistake the honesty clause in `journal-token-breakdown`
// warns against.

import { addUsage, emptyUsage, isNonEmptyUsage, type AgentUsage, type TranscriptActivity } from './transcript-usage.js'

/** One contributing agent's identity + measured cost/activity, as fed to buildCardCostReport.
 *  The CALLER resolves which agentIds belong to the card via an EXPLICIT name/id list (see
 *  card-cost-scan.ts's module doc for why) — this module never guesses scope itself. */
export interface CardCostAgentInput {
  agentId: string
  /** The `name:` the spawner gave this agent, if any (meta.json `name`) — null for an
   *  unnamed/default spawn. */
  name: string | null
  /** meta.json `agentType` (e.g. "pilot", "Explore", "workflow-toolbox:opencode-verifier"). */
  agentType: string | null
  /** meta.json `model` (e.g. "sonnet", "opus"), null when the spawn didn't record one. */
  model: string | null
  /** meta.json `description` — the one-line spawn purpose; used as a cheap "task type" label
   *  when no more structured field exists. */
  description: string | null
  usage: AgentUsage
  activity: TranscriptActivity
  /** True when this agent's identity was found (meta.json present) but its transcript could
   *  NOT be read (missing/pruned/unreadable) — usage/activity are then zeroed placeholders,
   *  NOT a measured zero. Flagged by cross-family review (2026-07-25): without this field, a
   *  transcript-missing row and a genuine zero-work row were indistinguishable in the numbers
   *  alone (a `numbers-carry-their-set-and-unit`-shaped gap) — a caller could report "0 tokens"
   *  as fact when the truth is "unmeasured". */
  transcriptMissing: boolean
}

/** input + output + cache-creation ("fresh compute") — excludes cache-read. See module header. */
export function freshComputeTokens(u: AgentUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens
}

/** One agent's row in a card cost report. */
export interface CardCostAgentRow {
  agentId: string
  name: string | null
  agentType: string | null
  model: string | null
  description: string | null
  usage: AgentUsage
  freshTokens: number
  turns: number
  toolCalls: number
  firstTimestamp: string | null
  lastTimestamp: string | null
  /** See CardCostAgentInput.transcriptMissing — propagated verbatim to the row. */
  transcriptMissing: boolean
}

export interface CardCostReport {
  cardId: string | null
  /** Per-agent rows, in the order given — the CALLER controls the explicit scope, this module
   *  never reorders or filters beyond what addUsage/coverage bookkeeping needs. */
  agents: CardCostAgentRow[]
  /** Distinct agents whose transcript yielded NON-EMPTY usage (see isNonEmptyUsage) — the
   *  coverage numerator, mirrors TokenBreakdown.coveredAgents in report.ts. */
  coveredAgents: number
  /** Total agents given as input, whether or not their transcript yielded usage — the coverage
   *  denominator. A gap between this and coveredAgents is a NAMED, not hidden, incompleteness
   *  (per numbers-carry-their-set-and-unit: a count without its set misleads). */
  totalAgents: number
  totals: AgentUsage
  freshTotal: number
  /** Earliest firstTimestamp / latest lastTimestamp across all rows — the arc's wall-clock
   *  span. Null when no row carried a timestamp. */
  spanStart: string | null
  spanEnd: string | null
}

/** Roll a set of already-parsed per-agent inputs into one CardCostReport. Pure: no IO, never
 *  throws (the inputs are already-validated in-memory values, not untrusted disk content —
 *  tolerance lives in card-cost-scan.ts, the impure reader). */
export function buildCardCostReport(cardId: string | null, inputs: CardCostAgentInput[]): CardCostReport {
  const agents: CardCostAgentRow[] = []
  let totals = emptyUsage()
  let freshTotal = 0
  let coveredAgents = 0
  let spanStart: string | null = null
  let spanEnd: string | null = null

  for (const input of inputs) {
    const fresh = freshComputeTokens(input.usage)
    agents.push({
      agentId: input.agentId,
      name: input.name,
      agentType: input.agentType,
      model: input.model,
      description: input.description,
      usage: input.usage,
      freshTokens: fresh,
      turns: input.activity.turns,
      toolCalls: input.activity.toolCalls,
      firstTimestamp: input.activity.firstTimestamp,
      lastTimestamp: input.activity.lastTimestamp,
      transcriptMissing: input.transcriptMissing,
    })
    totals = addUsage(totals, input.usage)
    freshTotal += fresh
    if (isNonEmptyUsage(input.usage)) coveredAgents++
    const { firstTimestamp, lastTimestamp } = input.activity
    if (firstTimestamp !== null && (spanStart === null || firstTimestamp < spanStart)) spanStart = firstTimestamp
    if (lastTimestamp !== null && (spanEnd === null || lastTimestamp > spanEnd)) spanEnd = lastTimestamp
  }

  return { cardId, agents, coveredAgents, totalAgents: inputs.length, totals, freshTotal, spanStart, spanEnd }
}
