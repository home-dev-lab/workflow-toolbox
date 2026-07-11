// lib.ts — pure, side-effect-free message parsing and verdict logic for the
// headless smoke harness. Everything here is unit-tested against REAL captured
// SDK messages (see test/fixtures/). The live runner (run.ts) is the only part
// that touches the SDK; keeping the logic here means the fragile bits — how a
// launch result, a syntax error, and a completion are recognized — are covered
// by `pnpm test` without spending agent runs.
//
// Design note: every reader takes `unknown` and narrows defensively. The smoke
// test is an UPGRADE CANARY: if a Claude Code upgrade drifts an SDK message
// shape, these must degrade to "unrecognized" (→ a loud, explained failure in
// run.ts), never throw an opaque TypeError.

import { isRecord, strOrNull } from '@workflow-toolbox/std'

// ---------------------------------------------------------------------------
// Tiny narrowing helpers
// ---------------------------------------------------------------------------

// Re-exported so the smoke modules that import it from './lib.js' (run.ts,
// calibrate.ts, version.ts, edge-canaries.ts) keep their import path unchanged.
export { isRecord }

/** A tool_result's `content` is a string in current SDK versions, but older/
 *  other shapes deliver an array of `{ type, text }` blocks. Normalize both. */
function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (isRecord(c) && typeof c['text'] === 'string' ? c['text'] : ''))
      .join('')
  }
  return ''
}

// ---------------------------------------------------------------------------
// Message readers
// ---------------------------------------------------------------------------

export interface WorkflowToolUse {
  id: string
  scriptPath: string
}

/** Extract a Workflow tool_use from an assistant message, if present. */
export function readWorkflowToolUse(msg: unknown): WorkflowToolUse | null {
  if (!isRecord(msg) || msg['type'] !== 'assistant') return null
  const message = msg['message']
  if (!isRecord(message) || !Array.isArray(message['content'])) return null
  for (const block of message['content']) {
    if (
      isRecord(block) &&
      block['type'] === 'tool_use' &&
      block['name'] === 'Workflow' &&
      isRecord(block['input'])
    ) {
      const id = strOrNull(block['id'])
      const scriptPath = strOrNull(block['input']['scriptPath'])
      if (id !== null && scriptPath !== null) return { id, scriptPath }
    }
  }
  return null
}

export interface ToolResult {
  toolUseId: string | null
  isError: boolean
  text: string
}

/** Extract a tool_result from a user message, if present. */
export function readToolResult(msg: unknown): ToolResult | null {
  if (!isRecord(msg) || msg['type'] !== 'user') return null
  const message = msg['message']
  if (!isRecord(message) || !Array.isArray(message['content'])) return null
  for (const block of message['content']) {
    if (isRecord(block) && block['type'] === 'tool_result') {
      return {
        toolUseId: strOrNull(block['tool_use_id']),
        isError: block['is_error'] === true,
        text: normalizeContent(block['content']),
      }
    }
  }
  return null
}

export interface TaskNotification {
  taskId: string
  toolUseId: string | null
  status: 'completed' | 'failed' | 'stopped' | string
  outputFile: string | null
}

/** A workflow run's terminal outcome, as reported by its OWN task_notification — the SAME
 *  "journal decides; never assume success" rule the debugger/rehydrate path applies to a
 *  post-mortem journal, surfaced here for a LIVE run. `status` is the notification's own
 *  status verbatim ('completed' means the workflow SCRIPT finished successfully; 'failed',
 *  'stopped', or any other runtime string means it did not — even though the SDK session
 *  itself ended gracefully, with no abort/exception of its own). `result` is the script's
 *  return value and is ONLY meaningful when status is 'completed' — a caller must check
 *  status before trusting result; a non-completed status always carries result: undefined. */
export interface WorkflowCompletion {
  status: TaskNotification['status']
  result: unknown
}

/** Read a background task_notification system message, if this is one. */
export function readTaskNotification(msg: unknown): TaskNotification | null {
  if (!isRecord(msg) || msg['type'] !== 'system' || msg['subtype'] !== 'task_notification') {
    return null
  }
  const taskId = strOrNull(msg['task_id'])
  const status = strOrNull(msg['status'])
  if (taskId === null || status === null) return null
  return {
    taskId,
    toolUseId: strOrNull(msg['tool_use_id']),
    status,
    outputFile: strOrNull(msg['output_file']),
  }
}

/** Read the Claude Code runtime version from the SDK `init` system message. This
 *  reports the version of the binary the SDK actually drove — bundled OR the one
 *  passed via `pathToClaudeCodeExecutable` — so it is the measured CC version of
 *  whichever target a run exercised. Null if this is not an init message. */
export function readInitVersion(msg: unknown): string | null {
  if (!isRecord(msg) || msg['type'] !== 'system' || msg['subtype'] !== 'init') return null
  return strOrNull(msg['claude_code_version'])
}

/** Read the SDK session id from the `init` system message — the identity a caller
 *  must record to RESUME this session later via `query({options:{resume}})` (the
 *  resume-parity canary pinned that an unforked resume of this id preserves the
 *  Workflow agent cache across a process kill — card #1812476922312000519). Null
 *  if this is not an init message. */
export function readInitSessionId(msg: unknown): string | null {
  if (!isRecord(msg) || msg['type'] !== 'system' || msg['subtype'] !== 'init') return null
  return strOrNull(msg['session_id'])
}

// ---------------------------------------------------------------------------
// Transcript filename classifier
// ---------------------------------------------------------------------------

/** Match an agent transcript filename (`agent-<id>.jsonl`) and return the agentId,
 *  or null for siblings (journal.jsonl, agent-<id>.meta.json, agent-<id>.json, etc.).
 *  Used by the live FS tailer to discover transcript files in the transcript dir. */
export function classifyAgentFile(name: string): string | null {
  const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(name)
  return m !== null ? (m[1] as string) : null
}

// ---------------------------------------------------------------------------
// Launch-text parsing + launch verdict
// ---------------------------------------------------------------------------

/** The Workflow tool_result arrives as FORMATTED TEXT (not JSON). Pull the
 *  identifiers out of it. Any field may be absent → null. `transcriptDir` is the
 *  per-run subagents dir where `agent-<id>.jsonl` transcripts appear — the live
 *  observer tails it (the Workflow Observatory repo's live driver). */
export function parseLaunchText(text: string): {
  taskId: string | null
  runId: string | null
  transcriptDir: string | null
} {
  const taskId = text.match(/Task ID:\s*(\S+)/)?.[1] ?? null
  const runId = text.match(/Run ID:\s*(\S+)/)?.[1] ?? null
  const transcriptDir = text.match(/Transcript dir:\s*(\S+)/)?.[1] ?? null
  return { taskId, runId, transcriptDir }
}

export interface LaunchVerdict {
  ok: boolean
  taskId: string | null
  reason: string
}

/** Decide whether a launch succeeded. A syntax-check failure surfaces as
 *  is_error===true with a `<tool_use_error>…` message and NEVER runs. */
export function launchVerdict(result: ToolResult): LaunchVerdict {
  if (result.isError) {
    return { ok: false, taskId: null, reason: stripToolError(result.text) }
  }
  const { taskId } = parseLaunchText(result.text)
  if (taskId === null) {
    return {
      ok: false,
      taskId: null,
      reason: 'launch accepted but no Task ID found in the tool result text',
    }
  }
  return { ok: true, taskId, reason: 'launched' }
}

function stripToolError(text: string): string {
  return text.replace(/^<tool_use_error>/, '').replace(/<\/tool_use_error>$/, '').trim() || text
}

// ---------------------------------------------------------------------------
// Phase-1 launch peeling (bounded — fail-fast on a stuck SDK session)
// ---------------------------------------------------------------------------

/** The launch identifiers a successful Phase 1 yields. `sessionId` (from the init
 *  message peeled on the way to the tool_result) is what a server persists to
 *  resume an orphaned run after its own restart — null only if the stream carried
 *  no init before the launch result (not observed in practice; callers must
 *  degrade to "not resumable"). */
export interface LaunchInfo {
  runId: string
  transcriptDir: string
  toolUseId: string | null
  sessionId: string | null
}

/** Thrown by `peelLaunch` when the launch produced no tool_result within its
 *  deadline — i.e. a stuck/flaky SDK session that would otherwise hang until the
 *  far larger run-level safety timeout (30 min on the dev server). Carries the
 *  deadline so the caller can report it. */
export class LaunchTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`workflow launch produced no tool_result within ${timeoutMs} ms`)
    this.name = 'LaunchTimeoutError'
  }
}

/** Phase 1 of a live observe run: drive the SDK stream iterator until the launch
 *  tool_result yields the runId + transcript dir, BOUNDED by `timeoutMs`. A launch
 *  that never produces a tool_result rejects with LaunchTimeoutError instead of
 *  hanging — the fail-fast the dev server needs (a stuck launch used to run to the
 *  30-min run-level timeout). Leading non-result messages (init, task_started,
 *  assistant tool_use) carry no identifiers and are skipped.
 *
 *  Pure w.r.t. IO: it drives whatever AsyncIterator it is handed, so it is
 *  unit-tested with fake iterators (no SDK, no agent run). The caller owns the
 *  AbortController and must abort it on a LaunchTimeoutError to tear the stuck SDK
 *  session down — this helper only stops waiting, it cannot kill the process. */
export async function peelLaunch(it: AsyncIterator<unknown>, timeoutMs: number): Promise<LaunchInfo> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LaunchTimeoutError(timeoutMs)), timeoutMs)
  })
  try {
    let sessionId: string | null = null
    while (true) {
      const next = it.next()
      next.catch(() => {}) // swallow a late rejection if the timeout wins the race (no unhandled rejection)
      const step = (await Promise.race([next, timeout])) as IteratorResult<unknown>
      if (step.done === true) {
        throw new Error('SDK stream ended before the launch tool_result')
      }
      // Capture the session identity on the way past the init (needed to resume
      // the session after a process death — see LaunchInfo.sessionId).
      sessionId = readInitSessionId(step.value) ?? sessionId
      const tr = readToolResult(step.value)
      if (tr === null) continue
      if (tr.isError) throw new Error(`workflow launch rejected: ${tr.text}`)
      const parsed = parseLaunchText(tr.text)
      if (parsed.runId === null || parsed.transcriptDir === null) {
        throw new Error('launch tool_result did not carry a Run ID + Transcript dir')
      }
      return { runId: parsed.runId, transcriptDir: parsed.transcriptDir, toolUseId: tr.toolUseId, sessionId }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Completion / envelope assertions
// ---------------------------------------------------------------------------

const STAT_KEYS = ['itemsIn', 'itemsOut', 'agentsSpawned', 'dropped', 'truncated'] as const

/** Validate the `result` field of a completed wt-smoke run. Returns a list of
 *  problems — empty means the round-trip envelope arrived intact. Asserts the
 *  PatternResult shape structurally (deterministic) plus the marker. */
export function checkSmokeResult(result: unknown, marker: string): string[] {
  const problems: string[] = []
  if (!isRecord(result)) return [`result is not an object (got ${typeof result})`]

  if (result['marker'] !== marker) {
    problems.push(`result.marker is ${JSON.stringify(result['marker'])}, expected ${JSON.stringify(marker)}`)
  }

  const envelope = result['envelope']
  if (!isRecord(envelope)) {
    problems.push('result.envelope is missing or not an object')
    return problems
  }

  if (!Array.isArray(envelope['value'])) problems.push('envelope.value is not an array')
  if (!Array.isArray(envelope['warnings'])) problems.push('envelope.warnings is not an array')
  if (!Array.isArray(envelope['trail']) || envelope['trail'].length === 0) {
    problems.push('envelope.trail is missing, not an array, or empty')
  }

  const stats = envelope['stats']
  if (!isRecord(stats)) {
    problems.push('envelope.stats is missing or not an object')
  } else {
    for (const key of STAT_KEYS) {
      if (typeof stats[key] !== 'number') {
        problems.push(`envelope.stats.${key} is not a number`)
      }
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Report summary
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
  /** Stable, canonicalized rejection wording (negative checks only) — fed into
   *  the change-report snapshot so wording drift is detected without volatile ids. */
  canonicalReason?: string
}

/** Options shared by the live runners: which Claude Code binary to drive. When
 *  `pathToClaudeCodeExecutable` is omitted, the SDK uses its bundled binary. */
export interface RunnerOptions {
  pathToClaudeCodeExecutable?: string
  /** Multi-observe I4a — the LAUNCHED CHILD's environment. Per the SDK's own contract this
   *  REPLACES the subprocess environment entirely (not merged) — a caller that still wants
   *  the ambient environment must spread `process.env` itself, e.g.
   *  `{ ...process.env, CLAUDE_CONFIG_DIR: myConfigDir }`. Omit to keep today's default
   *  (the subprocess inherits `process.env` verbatim, unchanged). */
  env?: Record<string, string | undefined>
  /** Inject the abort controller so a long-lived caller (e.g. an SSE dev server)
   *  can cancel the run on client disconnect. Defaults to an internal controller
   *  driven only by the runner's own safety timeout. */
  abortController?: AbortController
  /** Optional `args` value to pass to the Workflow tool (the script reads it as the
   *  global `args`). Threaded into launchPrompt as an exact JSON literal; omit for a
   *  no-args launch. Any JSON-serializable value (string, array, object, …). */
  args?: unknown
  /** Called once, as soon as the launch tool_result yields the run identifiers —
   *  lets a caller learn the runId + transcript dir before the first model fold.
   *  `sessionId` (card #1812476922312000519) is the SDK session id captured on the way past
   *  the `init` message during peelLaunch — a caller that must RESUME this run after a
   *  process death (app.ts's launch-records.ts) persists it here; it is null only in the
   *  undocumented-in-practice case the stream carried no init before the launch result (see
   *  LaunchInfo's own doc). Existing callers that destructure only {runId, transcriptDir}
   *  are unaffected — this is a purely additive widening. */
  onLaunch?: (info: { runId: string; transcriptDir: string; sessionId: string | null }) => void
  /** Called if the driver attempts a SECOND Workflow launch in the same session (the
   *  in-session runaway multiplier). The runner aborts the session right after; the
   *  caller can log it. Fires at most once per run. */
  onExtraLaunch?: (runId: string) => void
  /** Called once on GRACEFUL SDK-session completion with the workflow's full outcome
   *  ({status, result} — see WorkflowCompletion's doc). `status` is the task_notification's
   *  own terminal status, ALWAYS present; `result` (the script's return value, read from the
   *  outputFile — the same mechanism the smoke canary uses) is only meaningful when
   *  status === 'completed'. A caller MUST check status before trusting result — a graceful
   *  SDK completion does not imply the workflow SCRIPT succeeded (this used to be
   *  conflated: a caller reading only `result` had no way to tell "ran and returned nothing"
   *  from "failed", the live-settle truth bug this shape prevents). Lets a caller (the
   *  human-gated pipeline) consume a stage's artifact, not just its DAG.
   *  NOT fired on abort paths (safety timeout, the second-launch guard, or an injected
   *  abortController) — those reject the runner promise instead. A caller that
   *  must run teardown on EVERY exit should use the promise's finally/catch, not onComplete. */
  onComplete?: (outcome: WorkflowCompletion) => void
  /** Total safety timeout (ms) before the run is aborted. Defaults to a short cap
   *  suited to the CLI/canary; an interactive observer (the dev server) passes a far
   *  larger value so a long multi-phase workflow is not killed mid-run. */
  timeoutMs?: number
  /** Phase-1 launch deadline (ms): how long to wait for the launch tool_result
   *  (runId + transcript dir) before giving up. A stuck/flaky SDK session that never
   *  launches fails fast with this, instead of hanging until `timeoutMs` (which on
   *  the dev server is 30 min). Defaults to a short value; far below `timeoutMs`. */
  launchTimeoutMs?: number
}

/** What one runtime target's run produced: the measured Claude Code version (from
 *  the init message) plus the per-check results. */
export interface RuntimeRunResult {
  ccVersion: string | null
  checks: CheckResult[]
}

/** Fold per-check results into a final pass/fail verdict + a printable report. */
export function summarize(results: readonly CheckResult[]): { passed: boolean; report: string } {
  const passed = results.length > 0 && results.every((r) => r.ok)
  const lines = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`)
  const failed = results.filter((r) => !r.ok).length
  lines.push('')
  lines.push(
    passed
      ? `All ${results.length} smoke check(s) passed.`
      : `${failed} of ${results.length} smoke check(s) FAILED.`,
  )
  return { passed, report: lines.join('\n') }
}

// ---------------------------------------------------------------------------
// Live-runner helpers (pure — shared by run.ts and edge-canaries.ts)
// ---------------------------------------------------------------------------

/** Total time budget for a launch+completion round trip (`waitForCompletion:
 *  true`): how long a live runner waits for a run to actually FINISH, not just
 *  launch. Shared by every runner that drives one SDK session to a finished
 *  result (run.ts's tier-2, calibrate.ts, nesting-canaries.ts,
 *  budget-canaries.ts) — hoisted here after it had drifted into a 4th
 *  independent copy of the same literal. */
export const ROUNDTRIP_TIMEOUT_MS = 240_000

/** The launch prompt: make the model call the Workflow tool exactly once with
 *  this scriptPath and nothing else, so each query() yields one Workflow tool_use.
 *  When `args` is provided it is embedded as an exact JSON literal so the model
 *  passes it through to the Workflow tool's `args` (the script's global `args`);
 *  omit it (or pass undefined) for a no-args launch. */
export function launchPrompt(scriptPath: string, args?: unknown): string {
  const argsClause = args === undefined ? '' : ` and args set to this exact JSON value: ${JSON.stringify(args)}`
  return (
    `Call the Workflow tool exactly once with scriptPath set to "${scriptPath}"${argsClause}. ` +
    `Do not read or write any files and do not do anything else. After the tool returns, stop.`
  )
}

/** The RESUME prompt (card #1812476922312000519): re-invoke the Workflow tool with
 *  `resumeFromRunId` set so completed `agent()` calls replay from the journal cache instead
 *  of re-running (the resume-parity canary, run2.jsonl, pinned that an UNFORKED resume of the
 *  original SDK session preserves this cache across a process kill). Unlike launchPrompt's
 *  hand-quoted scriptPath + a separate args clause, the whole input is embedded as ONE
 *  JSON.stringify literal — scriptPath, resumeFromRunId, and (only when provided) args in a
 *  single object — since the input now has three fields instead of two, and a caller
 *  (the Observatory repo's resumeLiveRun) always has a concrete args value or none, never a
 *  template to interpolate around. */
export function resumePrompt(scriptPath: string, runId: string, args?: unknown): string {
  const input: Record<string, unknown> = { scriptPath, resumeFromRunId: runId }
  if (args !== undefined) input['args'] = args
  return (
    `Call the Workflow tool exactly once with this exact JSON input: ${JSON.stringify(input)}. ` +
    `Do not read or write any files and do not do anything else. After the tool returns, stop.`
  )
}

/** A timeout-triggered AbortController surfaces as an abort error in the stream. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))
}

/** Turn an SDK auth/binary failure into an actionable message. */
export function annotateAuth(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (/auth|credential|login|not found|ENOENT|binary/i.test(message)) {
    return new Error(
      `${message}\n\n[wt] This harness runs under your local Claude Code subscription — the SDK ` +
        `reuses ~/.claude credentials (no API key in env). Make sure you are logged in (run \`claude\` ` +
        `once interactively). For CI, set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.`,
    )
  }
  return err instanceof Error ? err : new Error(message)
}
