// auto-effort.ts — per-item WORKER effort auto-selection (card #1809425610812949851).
//
// THE DECIDED FORM (settled 2026-07-04, not re-litigated here): complexity
// triage of a code task is a JUDGMENT call, not a classification — a cheap
// classifier is explicitly excluded. Hence three tiers of decision:
//
//   1. DETERMINISTIC signals first, in script code (no agent): file counts,
//      diff size, brief length. Only the CLEAR extremes are decided here.
//   2. ONE batched triage call on the BEST model scoring the whole remaining
//      worklist at once — instruction: "when unsure, score UP". Never one
//      call per item.
//   3. The routing applies to WORKERS ONLY. Verifiers keep their static
//      'high' floor (resolveVerifierEffort in @workflow-toolbox/std) — that
//      is the quality net, non-negotiable, and this module never touches it.
//
// Fail-safe direction is always UP: an item the triage forgot, a malformed
// score, or a failed triage call resolves to the caller's default (typically
// 'high') — auto-selection can only be a cost optimization, never a silent
// quality downgrade.
//
// Opt-in by contract: callers enable this per launch (e.g. an
// `args.effort.<role> = 'auto'` value) — never as a blanket user/project
// default (effort is task-relative, not identity- or project-relative).
//
// Sandbox contract: deterministic, zero imports beyond runtime types and this
// package — safe to bundle into committed workflow artifacts.

import { BEST_MODEL } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, JsonSchema, EffortAlias, ModelAlias } from '@workflow-toolbox/runtime'
import { agentWithSchemaSalvage } from './structured-salvage.js'
import { untrusted } from './untrusted.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Deterministic, script-computed signals for one work item. All optional —
 *  the rules only fire on the signals the caller could actually compute. */
export interface EffortSignals {
  /** Files the item touches (task.files.length, changedFiles.length, …). */
  filesTouched?: number
  /** Of those, files created from scratch. */
  newFiles?: number
  /** Diff size in lines, when a real diff exists (review-side callers). */
  diffLines?: number
  /** Length in characters of the item's specification prose (contracts +
   *  test plan, a change summary, …) — a proxy for intrinsic complexity. */
  specChars?: number
}

/** One work item to route: a stable id, a compact human brief for the
 *  judgment triage, and the caller's deterministic signals. */
export interface EffortWorkItem {
  id: string
  /** Compact textual description (title + intent). Keep it short — the whole
   *  worklist is embedded in ONE triage prompt. */
  brief: string
  signals: EffortSignals
}

export interface AutoSelectEffortOptions {
  /** Effort used when triage cannot decide an item (missing from the answer,
   *  triage call failed). The fail-safe direction is UP: pass the role's
   *  static default (typically 'high'). */
  fallback: EffortAlias
  /** Model for the ONE batched triage call. Defaults to BEST_MODEL — scoring
   *  code-task difficulty is a code-reading judgment, not a cheap
   *  classification. */
  model?: ModelAlias
  /** Progress-group phase for the triage agent. */
  phase?: string
  /** Label for the triage agent (defaults to 'autoEffort:triage'). */
  label?: string
}

export interface AutoSelectEffortResult {
  /** Selected effort per item id — every input id is present. */
  efforts: Record<string, EffortAlias>
  /** How each id was decided: 'deterministic' | 'triage' | 'fallback'. */
  decidedBy: Record<string, 'deterministic' | 'triage' | 'fallback'>
  /** Diagnostics (triage failures, forgotten items) — surface these. */
  warnings: string[]
  /** Agent spawns consumed (0 when everything resolved deterministically). */
  spawns: number
}

// ---------------------------------------------------------------------------
// Tier 1 — deterministic rules (script code, no agent)
// ---------------------------------------------------------------------------

// Named heuristic bounds — deliberately CONSERVATIVE: only the clear extremes
// are decided without judgment; everything in between goes to the triage.
const SMALL_MAX_FILES = 2
const SMALL_MAX_DIFF_LINES = 40
const SMALL_MAX_SPEC_CHARS = 600
const LARGE_MIN_FILES = 8
const LARGE_MIN_DIFF_LINES = 400

/** Decide an item's effort from deterministic signals alone, or return null
 *  when the signals are not clearly at either extreme (→ batched triage).
 *  Small-and-simple → 'medium' (never 'low': workers still implement/review
 *  real code); clearly-large → 'xhigh'. */
export function deterministicEffortOf(signals: EffortSignals): EffortAlias | null {
  const files = signals.filesTouched
  const diff = signals.diffLines
  const spec = signals.specChars

  if ((files !== undefined && files >= LARGE_MIN_FILES) || (diff !== undefined && diff >= LARGE_MIN_DIFF_LINES)) {
    return 'xhigh'
  }

  // The small rule needs at least the file count to be KNOWN and small, no
  // new-file creation, and every known size signal under its bound. Unknown
  // diff/spec signals do not veto (the caller may not have them), but an
  // unknown file count does — with no signals at all, this is a judgment call.
  const filesSmall = files !== undefined && files <= SMALL_MAX_FILES && (signals.newFiles ?? 0) === 0
  const diffSmall = diff === undefined || diff <= SMALL_MAX_DIFF_LINES
  const specSmall = spec === undefined || spec <= SMALL_MAX_SPEC_CHARS
  if (filesSmall && diffSmall && specSmall && (diff !== undefined || spec !== undefined)) {
    return 'medium'
  }

  return null
}

// ---------------------------------------------------------------------------
// Tier 2 — ONE batched judgment triage on the best model
// ---------------------------------------------------------------------------

// Score → effort mapping (1-5, integers). "When unsure, score UP" is in the
// prompt; the mapping keeps 3 at the workers' typical 'high'.
function effortOfScore(score: number): EffortAlias {
  if (score <= 2) return 'medium'
  if (score <= 4) return 'high'
  return 'xhigh'
}

// One triage call scores at most this many items; larger worklists are split
// into ceil(n/chunk) batched calls (matches TRIAGE_SCHEMA's maxItems — the two
// must move together).
const TRIAGE_CHUNK_SIZE = 200

// Bounded per the capitulation defenses (fiche structured-output-capitulation):
// short/required fields first, every prose field and array bounded.
const TRIAGE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 120 },
          score: { type: 'integer' },
          reason: { type: 'string', maxLength: 160 },
        },
        required: ['id', 'score', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['scores'],
  additionalProperties: false,
}

interface TriageAnswer {
  scores: Array<{ id: string; score: number; reason: string }>
}

function triagePrompt(items: readonly EffortWorkItem[]): string {
  // The id is JSON-QUOTED on its own line and the signals live on a separate
  // line — measured live (run wf_4b35df09-227): with `- id: change [3 file(s)…]`
  // the model echoed the WHOLE line as the id, the match failed, and a scored
  // item silently fell back. Unambiguous framing + an exact-echo instruction.
  const list = items
    .map((it) => {
      const s = it.signals
      const sig = [
        s.filesTouched !== undefined ? `${s.filesTouched} file(s)` : null,
        s.newFiles !== undefined && s.newFiles > 0 ? `${s.newFiles} new` : null,
        s.diffLines !== undefined ? `${s.diffLines} diff lines` : null,
        s.specChars !== undefined ? `${s.specChars} spec chars` : null,
      ].filter((x) => x !== null).join(', ')
      return `- id: ${JSON.stringify(it.id)}${sig === '' ? '' : `\n  signals: ${sig}`}\n  work: ${it.brief}`
    })
    .join('\n')
  return (
    `You are triaging the DIFFICULTY of code work items to route each one's reasoning effort. ` +
    `Score every item 1-5:\n` +
    `1 = trivial/mechanical, 2 = simple and well-specified, 3 = ordinary implementation work, ` +
    `4 = intricate (subtle invariants, cross-cutting edits), 5 = hard judgment (architecture, ` +
    `ambiguity, high blast radius).\n` +
    `WHEN UNSURE, SCORE UP — an over-scored item only costs tokens; an under-scored one costs quality.\n` +
    `Score ALL of these items (every id must appear exactly once):\n` +
    // Item briefs come from caller artifacts (plan tasks, change summaries) —
    // attacker-influenceable text. Fence it as DATA per the repo convention.
    `${untrusted('WORK-ITEMS', list)}\n` +
    `Return { "scores": [ { "id": "<id>", "score": <1-5>, "reason": "<short>" }, ... ] }. ` +
    `Echo each "id" EXACTLY as the quoted string above — never append signals or anything else to it. ` +
    `Keep each reason under 160 characters.`
  )
}

// ---------------------------------------------------------------------------
// autoSelectEffort() — the orchestrator callers use
// ---------------------------------------------------------------------------

/**
 * Select a WORKER effort per work item: deterministic extremes in script code,
 * then ONE batched best-model triage call for everything else ("when unsure,
 * score UP"), with the caller's `fallback` (typically the role's static
 * default) for anything the triage failed to decide. Worklists beyond 200
 * undecided items are triaged in batched chunks of 200 (one call per chunk —
 * never one call per item; the schema bounds each answer at 200 scores).
 *
 * NEVER apply the result to verifier/checker roles — those keep their static
 * 'high' floor via resolveVerifierEffort. That boundary is the caller's to
 * hold and this module's contract to state.
 *
 * @example
 * ```ts
 * const sel = await autoSelectEffort(rt, tasks.map((t) => ({
 *   id: t.id,
 *   brief: `${t.title} — ${t.intent}`,
 *   signals: { filesTouched: t.files.length, newFiles: t.files.filter(f => f.status === 'new').length, specChars: t.contracts.length + t.testPlan.length },
 * })), { fallback: 'high', phase: 'Load' })
 * // workers: effort = sel.efforts[task.id]; checkers: UNCHANGED (floored).
 * ```
 */
export async function autoSelectEffort(
  rt: WorkflowRuntime,
  items: readonly EffortWorkItem[],
  options: AutoSelectEffortOptions,
): Promise<AutoSelectEffortResult> {
  const { fallback, model, phase, label } = options

  const seen = new Set<string>()
  for (const it of items) {
    if (seen.has(it.id)) {
      throw new Error(`autoSelectEffort: duplicate item id "${it.id}" — ids must be unique`)
    }
    seen.add(it.id)
  }

  const efforts: Record<string, EffortAlias> = {}
  const decidedBy: Record<string, 'deterministic' | 'triage' | 'fallback'> = {}
  const warnings: string[] = []

  // Tier 1 — deterministic extremes, in code.
  const undecided: EffortWorkItem[] = []
  for (const it of items) {
    const det = deterministicEffortOf(it.signals)
    if (det !== null) {
      efforts[it.id] = det
      decidedBy[it.id] = 'deterministic'
    } else {
      undecided.push(it)
    }
  }

  if (undecided.length === 0) {
    return { efforts, decidedBy, warnings, spawns: 0 }
  }

  // Tier 2 — one batched judgment call PER CHUNK on the best model,
  // salvage-wrapped. TRIAGE_SCHEMA bounds the answer at TRIAGE_CHUNK_SIZE
  // scores, so a larger worklist is split into ceil(n/chunk) calls — still
  // batched (never one call per item), and the ceiling is part of the public
  // contract instead of a silent schema rejection past 200 items.
  const scored = new Map<string, number>()
  // Ids already individually diagnosed (out-of-range score) — they fall back
  // WITHOUT the misleading extra "omitted" warning.
  const diagnosed = new Set<string>()
  let spawns = 0
  let anyTriageAnswered = false
  for (let at = 0; at < undecided.length; at += TRIAGE_CHUNK_SIZE) {
    const chunk = undecided.slice(at, at + TRIAGE_CHUNK_SIZE)
    const out = await agentWithSchemaSalvage<TriageAnswer>(rt, triagePrompt(chunk), {
      schema: TRIAGE_SCHEMA,
      label: label ?? 'autoEffort:triage',
      model: model ?? BEST_MODEL,
      effort: 'high',
      ...(phase !== undefined ? { phase } : {}),
    })
    spawns += out.spawns
    for (const w of out.warnings) warnings.push(`autoEffort: ${w}`)

    if (out.value === null) {
      warnings.push(`autoEffort: batched triage call failed — ${chunk.length} undecided item(s) fall back to '${fallback}'`)
      continue
    }
    anyTriageAnswered = true
    for (const entry of out.value.scores) {
      // Only known, not-yet-decided ids count; a hallucinated or duplicate id
      // is reported, never applied.
      if (!seen.has(entry.id) || entry.id in efforts || scored.has(entry.id)) {
        warnings.push(`autoEffort: triage returned unknown or duplicate id "${entry.id}" — ignored`)
        continue
      }
      if (!Number.isInteger(entry.score) || entry.score < 1 || entry.score > 5) {
        warnings.push(`autoEffort: triage score for "${entry.id}" out of range (${String(entry.score)}) — falling back to '${fallback}'`)
        diagnosed.add(entry.id)
        continue
      }
      scored.set(entry.id, entry.score)
    }
  }

  for (const it of undecided) {
    const score = scored.get(it.id)
    if (score !== undefined) {
      efforts[it.id] = effortOfScore(score)
      decidedBy[it.id] = 'triage'
    } else {
      if (anyTriageAnswered && !diagnosed.has(it.id)) {
        warnings.push(`autoEffort: triage omitted item "${it.id}" — falling back to '${fallback}'`)
      }
      efforts[it.id] = fallback
      decidedBy[it.id] = 'fallback'
    }
  }

  return { efforts, decidedBy, warnings, spawns }
}
