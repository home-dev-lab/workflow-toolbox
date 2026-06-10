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

// ---------------------------------------------------------------------------
// Launch-text parsing + launch verdict
// ---------------------------------------------------------------------------

/** The Workflow tool_result arrives as FORMATTED TEXT (not JSON). Pull the
 *  identifiers out of it. Either may be absent → null. */
export function parseLaunchText(text: string): { taskId: string | null; runId: string | null } {
  const taskId = text.match(/Task ID:\s*(\S+)/)?.[1] ?? null
  const runId = text.match(/Run ID:\s*(\S+)/)?.[1] ?? null
  return { taskId, runId }
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

/** The launch prompt: make the model call the Workflow tool exactly once with
 *  this scriptPath and nothing else, so each query() yields one Workflow tool_use. */
export function launchPrompt(scriptPath: string): string {
  return (
    `Call the Workflow tool exactly once with scriptPath set to "${scriptPath}". ` +
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
