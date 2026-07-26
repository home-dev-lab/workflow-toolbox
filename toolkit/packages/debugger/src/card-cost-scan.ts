// card-cost-scan.ts — IMPURE disk layer for buildCardCostReport (card-cost.ts). Given a
// session's FLAT `subagents/` directory (`agent-<id>.jsonl` + `agent-<id>.meta.json` pairs —
// see the memory fiche `journal-token-breakdown` for the disk layout; distinct from the nested
// `subagents/workflows/<runId>/` dir a Workflow-tool run uses) and an EXPLICIT selector (names
// or ids the caller already knows it spawned), read + parse each matching pair into a
// CardCostAgentInput.
//
// Deliberately NOT a time-window sweep or a directory-wide scan. A shared session directory can
// hold hundreds of concurrent, unrelated agents — proven the night of 2026-07-24→25: an
// unscoped mtime-window sweep of the same directory returned ~2.5x a hand-verified 14-agent
// scope (card #1827133895158531377's evidence). The caller — the pilot or orchestrator that
// actually did the spawning — is the only party that reliably knows which agents belong to
// this card; this module trusts that explicit list rather than inferring scope.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord, strOrNull } from '@workflow-toolbox/std'
import { parseTranscriptUsage, parseTranscriptActivity, emptyUsage, emptyActivity, type AgentUsage } from './transcript-usage.js'
import type { CardCostAgentInput } from './card-cost.js'

/** Whether an agentId is safe to interpolate into `agent-<id>.jsonl` / `.meta.json`. Mirrors
 *  audit-folder.ts's isSafeAgentId (a path-traversal-shaped id must never reach a filesystem
 *  join) — re-declared rather than imported: that copy is scoped to a workflow-run transcript
 *  dir with its own module doc, this one guards a different (flat, session-wide) directory
 *  shape. Duplicating an 8-line regex guard is cheaper and safer than a cross-module dependency
 *  for it; if the guard rule itself ever needs to change, both call sites are one grep away. */
export function isSafeAgentId(agentId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(agentId)
}

export interface AgentSelector {
  /** Match by exact meta.json `name` (what the spawner passed at Agent-tool spawn time). */
  names?: string[]
  /** Match by exact agentId (the `agent-<id>` filename stem) — for a caller that already
   *  resolved concrete ids from its own spawn-result bookkeeping. */
  agentIds?: string[]
}

/** One `agent-<id>.meta.json` sidecar's fields relevant to card-cost attribution. Absent /
 *  unreadable / shapeless → all-null, never throws. */
interface MetaSidecar {
  name: string | null
  agentType: string | null
  model: string | null
  description: string | null
}

function readMetaSidecar(metaPath: string): MetaSidecar {
  const empty: MetaSidecar = { name: null, agentType: null, model: null, description: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch {
    return empty
  }
  if (!isRecord(parsed)) return empty
  return {
    name: strOrNull(parsed['name']),
    agentType: strOrNull(parsed['agentType']),
    model: strOrNull(parsed['model']),
    description: strOrNull(parsed['description']),
  }
}

/** List every `agent-<id>` stem directly under `subagentsDir` (non-recursive — the nested
 *  `workflows/` subdirectory is a DIFFERENT scope, out of this function's contract; see the
 *  module doc). Best-effort: an unreadable dir yields []. */
function listAgentIds(subagentsDir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(subagentsDir)
  } catch {
    return []
  }
  const ids = new Set<string>()
  for (const entry of entries) {
    const m = /^agent-(.+)\.meta\.json$/.exec(entry)
    const id = m?.[1]
    if (id !== undefined && isSafeAgentId(id)) ids.add(id)
  }
  return [...ids]
}

/** Resolve a selector to concrete agentIds by reading every meta.json under `subagentsDir`
 *  once, then parse each matched agent's transcript. Best-effort + explicit: a requested
 *  name/id that matches nothing on disk is simply absent from the result — the CALLER (see
 *  card-cost-cli.ts) diffs its requested list against the returned rows to surface what went
 *  unmatched, rather than this function silently fabricating or dropping a row. A transcript
 *  that is present in meta.json but missing/unreadable on disk (e.g. pruned) still yields a
 *  row — with zeroed usage/activity — so the agent's IDENTITY is not silently lost, only its
 *  cost data. */
export function scanCardCostAgents(subagentsDir: string, selector: AgentSelector): CardCostAgentInput[] {
  const wantNames = new Set(selector.names ?? [])
  const wantIds = new Set(selector.agentIds ?? [])
  const results: CardCostAgentInput[] = []

  for (const agentId of listAgentIds(subagentsDir)) {
    const meta = readMetaSidecar(join(subagentsDir, `agent-${agentId}.meta.json`))
    const matches = wantIds.has(agentId) || (meta.name !== null && wantNames.has(meta.name))
    if (!matches) continue

    let usage: AgentUsage = emptyUsage()
    let activity = emptyActivity()
    let transcriptMissing = false
    try {
      const text = readFileSync(join(subagentsDir, `agent-${agentId}.jsonl`), 'utf8')
      usage = parseTranscriptUsage(text)
      activity = parseTranscriptActivity(text)
    } catch {
      // Transcript missing/unreadable — meta.json still identified the agent; report it with
      // zeroed usage/activity rather than omitting the row (an omitted row would silently
      // understate coverage instead of naming the gap via coveredAgents < totalAgents). The
      // zeros are a PLACEHOLDER, not a measurement — transcriptMissing is what disambiguates
      // this from genuine zero-cost work (a real completeness gap flagged by cross-family
      // review 2026-07-25: the two were indistinguishable in the numbers alone before this).
      transcriptMissing = true
    }

    results.push({
      agentId,
      name: meta.name,
      agentType: meta.agentType,
      model: meta.model,
      description: meta.description,
      usage,
      activity,
      transcriptMissing,
    })
  }

  return results
}
