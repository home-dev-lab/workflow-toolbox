// PURE per-agent transcript tool-DENIAL scanner. When a workflow subagent is silently denied
// a tool call — the auto-mode permission classifier blocks it, a PreToolUse hook denies it, or
// the action is rejected — the agent keeps going and returns a normal-looking output. The run
// JOURNAL records cost + agent state but NEVER the denied `tool_result` inside the agent, so a
// review / plan / implementation can be DEGRADED (an agent couldn't read the diff, run the test,
// reach a file) with zero signal. This module reads one agent transcript
// (`subagents/workflows/<runId>/agent-<id>.jsonl`) and extracts those denials so the audit
// report + Stop hook can warn "this run may be blind".
//
// GROUNDED on real on-disk transcripts (captured 2026-06-29): exactly three policy-denial
// wordings are matched —
//   1. auto-mode classifier : "Permission for this action was denied by the Claude Code auto
//      mode classifier. Reason: [<Category>] ..."   (the canonical silent block)
//   2. generic rejection    : "The user doesn't want to proceed with this tool use. The tool
//      use was rejected ..."  (what an auto-mode decline surfaces as inside a run; in a
//      headless workflow run there is no human, so this is always a policy denial)
//   3. hook denial          : "Hook PreToolUse:<Tool> denied this tool"
// Ordinary tool errors (non-zero exit codes, MCP arg-validation `-32602`, oversize-read caps,
// HTTP 404s, EISDIR, ERR_MODULE_NOT_FOUND) are NOT denials and MUST never be flagged. The match
// set is therefore a CLOSED allow-list of denial signatures: precision over recall. A missed
// novel denial wording is a quiet gap to extend later; a false "degraded" on a clean run would
// erode trust in the whole signal, which is worse.
//
// DELIBERATELY EXCLUDED: "Error: No such tool available: <name>" — a DIFFERENT class
// (tool-not-found, usually the agent guessing a wrong tool name, e.g. lowercase `bash` or an
// MCP tool it never loaded), not a permission denial of a tool it was entitled to. Including it
// produced false alarms on otherwise-fine runs. Revisit if a real "agent was restricted from a
// tool it needed" case is observed.
//
// Tolerant by contract (this parses an untrusted on-disk file): malformed lines and odd shapes
// are skipped; it never throws. Reuses the @workflow-toolbox/std narrowers — no local redefinition.

import { isRecord, strOrNull } from '@workflow-toolbox/std'

/** The policy-denial classes this scanner recognises (see the file header for the exact
 *  grounded wordings). All three mean a tool the agent asked for did NOT run. */
export type DenialKind = 'auto-mode-classifier' | 'rejected' | 'hook'

/** A post-denial RECOVERY signal: the SAME agent later made a SUCCESSFUL call that plausibly
 *  covers the denied intent (denied+recovered ≠ denied+blind — a denial with a recovery signal
 *  softens the "may be blind" warning; it never removes the denial from the report). Matching
 *  is deliberately CONSERVATIVE — each accepted signal is grounded on a real occurrence:
 *    - exact retry   : the same tool with the same attempted detail succeeds later;
 *    - fetch-class   : a denied WebFetch/WebSearch followed by ANY successful fetch/search
 *                      (incl. MCP fetch tools — the context-mode hook's sanctioned fallback);
 *    - exec-fallback : a denied Bash followed by a successful MCP execute-class tool.
 *  "Same intent" stays heuristic, so downstream wording always says "verify the recovery
 *  covered the same intent". */
export interface DenialRecovery {
  /** The tool whose later successful call is the recovery signal (e.g. "WebSearch"). */
  via: string
  /** ISO timestamp of the recovering transcript line, when it carries one. */
  at: string | null
}

/** One denied tool call inside an agent transcript. */
export interface ToolDenial {
  /** The agent whose transcript this denial came from (the `agent-<id>.jsonl` id). */
  agentId: string
  /** The run-phase label of that agent, resolved from the journal by the report builder.
   *  Absent here (the transcript alone doesn't carry it) and filled in downstream. */
  label?: string
  /** The tool that was denied (e.g. "Bash", "WebFetch"); "(unknown)" if the matching
   *  tool_use block could not be found in the transcript. */
  tool: string
  /** A short, single-line description of what was attempted (the Bash command, the URL, the
   *  file path…), trimmed for display. Empty when nothing usable was on the tool_use input. */
  detail: string
  /** Which denial class matched. */
  kind: DenialKind
  /** The auto-mode "[Category]" reason tag when present (e.g. "[Create Unsafe Agents]"),
   *  else null. */
  reason: string | null
  /** ISO timestamp of the transcript line the denial was detected on (the error
   *  tool_result), null when the line carries no timestamp. Lets a replay fold
   *  gate the denial overlay at a scrub position (Workflow Observatory). */
  at: string | null
  /** Present iff a recovery signal was found AFTER this denial in the same transcript.
   *  Absent (not null) when there is none — precision over recall, never guess. */
  recovered?: DenialRecovery
}

/** A run-level rollup of denials across all its agents. */
export interface ToolDenialReport {
  /** Total denied tool calls across every agent. */
  total: number
  /** Distinct agents that hit at least one denial. */
  agentsAffected: number
  /** Denials grouped by a short SIGNATURE — for Bash, the leading command tokens (e.g.
   *  "git diff"); for any other tool, the tool name — most-frequent first. Drives the
   *  "git diff ×7" summary. NOTE: a Bash signature is NOT the tool name ("Bash"); the field
   *  is named `signature`, not `tool`, precisely because it carries the command head. */
  bySignature: Array<{ signature: string; count: number }>
  /** Every individual denial (label-enriched by the report builder when possible). */
  denials: ToolDenial[]
  /** True when any denial was found — every recognised class is a real policy denial, so any
   *  hit means the run may be degraded. Equals `total > 0` by construction (a convenience
   *  alias for call sites; `buildToolDenialReport` is the sole constructor and keeps them
   *  in sync). */
  degraded: boolean
  /** How many denials carry a recovery signal. Precomputed here (like `degraded`) so the
   *  wording gates on every surface (Stop hook, report, UI pill/panel) share ONE definition
   *  instead of hand-duplicating the filter. */
  recoveredCount: number
  /** True iff there ARE denials and EVERY one carries a recovery signal — the single gate
   *  for the softened "recovered" wording. False on an empty report (no denials ≠ recovered). */
  allRecovered: boolean
}

const AUTO_MODE = /denied by the Claude Code auto mode classifier/i
const AUTO_MODE_REASON = /Reason:\s*(\[[^\]]+\])/
const HOOK = /\bHook \S+ denied this tool\b/i
// Two stable substrings of the generic rejection message; the second avoids the apostrophe in
// "doesn't" entirely so a straight/curly apostrophe never breaks the match.
const REJECTED = /\bthe tool use was rejected\b|\bwant to proceed with this tool use\b/i

/**
 * Classify one `tool_result` content string as a policy denial, or null if it is an ordinary
 * error / success. Checked most-specific-first; the three signature sets do not overlap.
 * Param is `unknown` (not `string`) to match the tolerant-by-contract posture: it parses an
 * untrusted on-disk file, so a non-string slips through to the guard rather than the type.
 */
export function classifyDenial(resultText: unknown): { kind: DenialKind; reason: string | null } | null {
  if (typeof resultText !== 'string' || resultText === '') return null
  if (AUTO_MODE.test(resultText)) {
    const m = AUTO_MODE_REASON.exec(resultText)
    return { kind: 'auto-mode-classifier', reason: m ? m[1]! : null }
  }
  if (HOOK.test(resultText)) return { kind: 'hook', reason: null }
  if (REJECTED.test(resultText)) return { kind: 'rejected', reason: null }
  return null
}

/** Flatten a tool_result `content` (string OR an array of text blocks) to one searchable string. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (isRecord(b) && typeof b['text'] === 'string' ? b['text'] : ''))
      .join('\n')
  }
  return ''
}

/** Pull a single-line "what was attempted" string off a tool_use input — UNTRUNCATED, so the
 *  exact-retry comparison never collapses two long commands sharing a 120-char prefix. The
 *  PUBLIC ToolDenial.detail is this capped to DETAIL_MAX for display. */
const DETAIL_MAX = 120
function deriveDetail(input: unknown): string {
  if (!isRecord(input)) return ''
  const candidate =
    strOrNull(input['command']) ??
    strOrNull(input['url']) ??
    strOrNull(input['query']) ??
    strOrNull(input['file_path']) ??
    strOrNull(input['path']) ??
    strOrNull(input['pattern']) ??
    firstStringValue(input)
  return candidate === null ? '' : candidate.replace(/\s+/g, ' ').trim()
}

function firstStringValue(rec: Record<string, unknown>): string | null {
  for (const v of Object.values(rec)) {
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}

/** The leading verb tokens of one `&&`-segment, after skipping `FOO=bar` env assignments. */
function segmentHead(seg: string): { verb: string | null; head: string } {
  const toks = seg.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]!)) i++
  return { verb: toks[i] ?? null, head: toks.slice(i, i + 2).join(' ') }
}

/** A short grouping signature: a Bash command collapses to its leading "verb" tokens
 *  (e.g. "git diff"); any other tool groups under its own name. Picks the FIRST `&&`-segment
 *  whose verb isn't `cd`, so both `cd <dir> && git diff` and `git diff && echo done` yield
 *  the real command head (not a trailing `echo`). */
function signatureOf(tool: string, detail: string): string {
  if (tool !== 'Bash' || detail === '') return tool
  const segs = detail.split('&&').map((s) => s.trim()).filter(Boolean)
  for (const seg of segs) {
    const { verb, head } = segmentHead(seg)
    if (verb === 'cd') continue
    if (head) return head
  }
  // Every segment was a `cd` (or empty) — fall back to the first segment's head, else the tool.
  return (segs[0] ? segmentHead(segs[0]).head : '') || tool
}

// ── recovery matching (see DenialRecovery) ──────────────────────────────────────
// Fetch-class: the two builtin web tools plus MCP tools whose name says fetch/search
// (e.g. context-mode's ctx_fetch_and_index / ctx_search — the sanctioned hook fallback).
// The keyword must stand on a non-letter boundary: 'research_status' must NOT match
// ('search' glued to letters), while 'ctx_fetch_and_index' / 'web_search' do. The
// builtin ToolSearch is deliberately NOT in the class: loading a tool schema fetches
// no content, so it cannot recover a denied fetch.
const FETCH_RE = /(^|[^a-z])(fetch|search)([^a-z]|$)/i
function isFetchClass(name: string): boolean {
  if (name === 'WebFetch' || name === 'WebSearch') return true
  return name.startsWith('mcp__') && FETCH_RE.test(name)
}

/** MCP execute-class (ctx_execute, ctx_batch_execute, execute_shell_command…) — the
 *  sanctioned fallback when a Bash command is hook-blocked. Same boundary rule. */
const EXEC_RE = /(^|[^a-z])execute([^a-z]|$)/i
function isMcpExec(name: string): boolean {
  return name.startsWith('mcp__') && EXEC_RE.test(name)
}

/** How close (counted in SUBSEQUENT tool_results of the same transcript) a matching success
 *  must be to count as the recovery for a denial. Every grounded real recovery pivoted
 *  within 1–2 results of the denial; the bound is what keeps one unrelated success 50 calls
 *  later from being credited (review wf_9fdbddfe-ba5's repro). */
const RECOVERY_WINDOW = 5

function isRecoveryFor(denied: { tool: string; detail: string }, success: { name: string; detail: string }): boolean {
  // Exact retry: same tool, same UNTRUNCATED attempted detail, now succeeding. No early
  // return on the name — a same-tool call with a different input still falls through to
  // the class checks (WebFetch→WebFetch on a corrected URL is a fetch-class recovery).
  if (success.name === denied.tool && denied.detail !== '' && success.detail === denied.detail) return true
  if (isFetchClass(denied.tool) && isFetchClass(success.name)) return true
  if (denied.tool === 'Bash' && isMcpExec(success.name)) return true
  return false
}

/**
 * Scan one agent transcript (`agent-<id>.jsonl` text) for denied tool calls. Builds a
 * tool_use_id → {name,input} map from the assistant lines (which precede their results), then
 * classifies each tool_result. A second pass attaches a `recovered` signal to each denial
 * that is followed (in transcript order) by a matching SUCCESSFUL call — see DenialRecovery.
 * Never throws; a malformed/empty transcript yields [].
 */
export function parseTranscriptDenials(jsonl: string, agentId: string): ToolDenial[] {
  const toolUses = new Map<string, { name: string; input: unknown }>()
  // `resultIndex` counts tool_results (any outcome) — the unit of the RECOVERY_WINDOW.
  // Details tracked here are UNTRUNCATED (exact-retry compares them); the public
  // ToolDenial.detail is capped for display.
  const denials: Array<{ denial: ToolDenial; detail: string; resultIndex: number }> = []
  const successes: Array<{ resultIndex: number; name: string; detail: string; at: string | null }> = []
  let resultIndex = 0

  for (const raw of jsonl.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    const lineAt = strOrNull(parsed['timestamp'])
    const message = parsed['message']
    if (!isRecord(message)) continue
    const content = message['content']
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (!isRecord(block)) continue
      if (block['type'] === 'tool_use') {
        const id = strOrNull(block['id'])
        if (id !== null) toolUses.set(id, { name: strOrNull(block['name']) ?? '(unknown)', input: block['input'] })
      } else if (block['type'] === 'tool_result') {
        resultIndex++
        const id = strOrNull(block['tool_use_id'])
        const use = id !== null ? toolUses.get(id) : undefined
        // GATE on is_error: a real policy denial always lands as an error tool_result (proven
        // on every grounded fixture). Without this, a SUCCESSFUL tool call whose output merely
        // QUOTES a denial phrase (a workflow grepping a transcript / the CC logs / even this
        // module's own source + fixtures) would be a false "degraded" — defeating the
        // precision-over-recall contract. is_error:false / absent → never a denial.
        if (block['is_error'] !== true) {
          // A successful call — a potential recovery signal for an EARLIER denial.
          if (use !== undefined) successes.push({ resultIndex, name: use.name, detail: deriveDetail(use.input), at: lineAt })
          continue
        }
        const verdict = classifyDenial(resultText(block['content']))
        if (verdict === null) continue
        const detail = deriveDetail(use?.input)
        denials.push({
          resultIndex,
          detail,
          denial: {
            agentId,
            tool: use?.name ?? '(unknown)',
            detail: detail.slice(0, DETAIL_MAX),
            kind: verdict.kind,
            reason: verdict.reason,
            at: lineAt,
          },
        })
      }
    }
  }

  // Second pass, per SUCCESS in transcript order: each success is credited to the CLOSEST
  // preceding unrecovered matching denial within RECOVERY_WINDOW (the agent reacts to its
  // LAST failure — crediting the earliest denial misattributes the recovery when two denials
  // share a candidate). A success recovers at most ONE denial by construction — otherwise a
  // single unrelated success would be credited to every earlier matching denial in the run.
  for (const s of successes) {
    let closest: (typeof denials)[number] | undefined
    for (const d of denials) {
      if (d.resultIndex >= s.resultIndex) break // denials are in transcript order
      if (d.denial.recovered !== undefined) continue
      if (s.resultIndex - d.resultIndex > RECOVERY_WINDOW) continue
      if (isRecoveryFor({ tool: d.denial.tool, detail: d.detail }, s)) closest = d // keep the LAST (closest)
    }
    if (closest !== undefined) closest.denial.recovered = { via: s.name, at: s.at }
  }
  return denials.map((d) => d.denial)
}

/** Roll per-agent denial lists into one report (grouping, counts, degraded flag). Usually
 *  per-RUN (one list per agent of a single run), but also used to aggregate ACROSS runs — the
 *  observe-ui pipeline combined view flattens every stage's denials into one report. `agentsAffected`
 *  and the downstream per-agentId attribution treat `agentId` as a global key, so cross-run
 *  aggregation is only correct because runtime agentIds are globally unique 17-char random ids
 *  (`a00f7657a34d8dc9b` — empirically a leading 'a' + 16 random hex nibbles); two denials sharing
 *  an `agentId` are deliberately counted as the SAME affected agent. */
export function buildToolDenialReport(perAgent: Iterable<ToolDenial[]>): ToolDenialReport {
  const denials: ToolDenial[] = []
  const affected = new Set<string>()
  for (const list of perAgent) {
    for (const d of list) {
      denials.push(d)
      affected.add(d.agentId)
    }
  }

  const counts = new Map<string, number>()
  for (const d of denials) {
    const sig = signatureOf(d.tool, d.detail)
    counts.set(sig, (counts.get(sig) ?? 0) + 1)
  }
  const bySignature = [...counts.entries()]
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature))

  const recoveredCount = denials.filter((d) => d.recovered !== undefined).length
  return {
    total: denials.length,
    agentsAffected: affected.size,
    bySignature,
    denials,
    degraded: denials.length > 0,
    recoveredCount,
    allRecovered: denials.length > 0 && recoveredCount === denials.length,
  }
}

/** An explicit empty report (no denials) — the safe default when no transcripts were scanned. */
export function emptyDenialReport(): ToolDenialReport {
  return { total: 0, agentsAffected: 0, bySignature: [], denials: [], degraded: false, recoveredCount: 0, allRecovered: false }
}

/** The distinct recovery tools of a report, first-seen order — the "(later succeeded via …)"
 *  list every wording surface renders (one definition, not per-surface duplicates). */
export function recoveryVias(report: Pick<ToolDenialReport, 'denials'>): string[] {
  return [...new Set(report.denials.map((d) => d.recovered?.via).filter((v): v is string => v !== undefined))]
}
