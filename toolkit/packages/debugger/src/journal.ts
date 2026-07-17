// Types + tolerant parsing for a Claude Code Workflow RUN JOURNAL:
//   ~/.claude/projects/<project-slug>/<sessionId>/workflows/wf_<runId>.json
//
// The journal is the PRIMARY, structured record of a workflow run. (The per-agent
// `agent-<id>.jsonl` transcripts are the documented FALLBACK "when no journal is
// available" — so this debugger is journal-first, transcript-as-drill-down.)
//
// Schema first verified against 59 real journals (2026-06-08), re-swept over 779
// (2026-07-17): `status` is "completed" | "failed" (plus "killed" from reaped runs).
// "async_launched" is documented (a pre-run syntax/meta failure that never executes)
// but has never been observed on disk — current-runtime probes show a rejected script
// writes NO run record at all, so the branch is defensive. Non-"done" agent states
// ("error", plus "progress"/"start" frozen on dead runs) and attempt > 1
// (StructuredOutput retries) ARE observed in real journals, rarely. Parsing stays
// deliberately tolerant: we never assume a field is present or well-typed.

export type WorkflowStatus = 'completed' | 'failed' | 'async_launched' | (string & {})

export interface WorkflowPhaseEvent {
  type: 'workflow_phase'
  index?: number
  title?: string
}

export interface WorkflowAgentEvent {
  type: 'workflow_agent'
  /** Usually "done"; any other terminal value means the agent did not complete
   * (died → `agent()` returned null). Non-"done" states ("error", plus
   * "progress"/"start" frozen mid-flight) are observed in real journals of
   * failed/killed runs. */
  state?: string
  /** Usually 1; > 1 means StructuredOutput schema retries — observed in real
   * journals, rarely. */
  attempt?: number
  index?: number
  label?: string
  agentId?: string
  model?: string
  phaseIndex?: number
  phaseTitle?: string
  tokens?: number
  toolCalls?: number
  durationMs?: number
  /** Wall-clock ms epochs, observed on disk (real journal, 2026-07-08): when the agent
   *  was enqueued / actually started. With durationMs they let replay ingest stamp an
   *  agent's lifecycle patches at its REAL times instead of bunching them at journal-write
   *  time (the votes-stuck-at-0-while-synthesize-speaks replay artifact). */
  queuedAt?: number
  startedAt?: number
  lastToolName?: string
  lastToolSummary?: string
  resultPreview?: string
  promptPreview?: string
}

export type WorkflowProgressEvent =
  | WorkflowPhaseEvent
  | WorkflowAgentEvent
  | { type?: string; [k: string]: unknown }

export interface WorkflowJournal {
  runId: string
  /** Background-task id (distinct from the wf_<runId> filename key). Present on real
   * journals; the only handle the Stop hook's background_tasks[] carries — see the
   * audit-report design. */
  taskId?: string
  status?: WorkflowStatus
  workflowName?: string
  /** One-line workflow goal — mirrors the artifact's `meta.description`. Verified
   * present on 243/243 real journals (2026-06-20); surfaced by readRunSummary. */
  summary?: string
  error?: string
  result?: unknown
  args?: unknown
  agentCount?: number
  totalTokens?: number
  totalToolCalls?: number
  durationMs?: number
  startTime?: number
  timestamp?: string
  scriptPath?: string
  /** The run's default model tier (e.g. "claude-opus-4-8[1m]"). */
  defaultModel?: string
  /** Static per-phase description from the workflow's `meta.phases`. Present on real
   * journals (e.g. `phases:[{title,detail}]`); surfaced by observe as a phase-box tooltip
   * and as inline text on an empty/skipped phase box. */
  phases?: { title?: string; detail?: string }[]
  workflowProgress?: WorkflowProgressEvent[]
  /** Narrator lines emitted by `rt.log()` during the run, in call order. Real journals
   * carry these as BARE strings (e.g. "Evidence gathered: 3/4"); most runs have none, so
   * the array is often absent or empty. Captured into the observe model as `run.log`
   * patches — see observe's journalToPatches. NOT a decision source for the audit report. */
  logs?: string[]
}

/**
 * Parse raw journal text. Tolerant by contract: never throws. Returns null on
 * malformed JSON, a non-object payload, or a payload missing a string `runId`.
 * Beyond `runId` we do NOT deep-validate — accessors guard each field they read.
 */
export function parseJournal(text: string): WorkflowJournal | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const obj = data as Record<string, unknown>
  if (typeof obj['runId'] !== 'string') return null
  // Guarded runId above; the rest stays tolerant (accessors guard each field they read).
  return obj as unknown as WorkflowJournal
}

/** All `workflow_agent` events, in journal order. Tolerant of an absent stream. */
export function agentEvents(j: WorkflowJournal): WorkflowAgentEvent[] {
  return (j.workflowProgress ?? []).filter(
    (e): e is WorkflowAgentEvent =>
      !!e && (e as { type?: unknown }).type === 'workflow_agent',
  )
}

/** Agents that reached the terminal "done" state. */
export function doneAgents(j: WorkflowJournal): WorkflowAgentEvent[] {
  return agentEvents(j).filter((a) => a.state === 'done')
}

/** Agents whose state is anything other than "done". On a TERMINAL run these are
 * dead/incomplete; on a still-running run they are simply not finished yet — the
 * caller (diagnoseRun) decides which interpretation applies. */
export function incompleteAgents(j: WorkflowJournal): WorkflowAgentEvent[] {
  return agentEvents(j).filter((a) => a.state !== 'done')
}

/** Agents that needed more than one attempt (StructuredOutput schema retries). */
export function retriedAgents(j: WorkflowJournal): WorkflowAgentEvent[] {
  return agentEvents(j).filter((a) => (a.attempt ?? 1) > 1)
}
