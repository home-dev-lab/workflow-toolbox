// sdk-driver.ts — the ONE shared SDK query-session driver loop behind run.ts's
// tier-1/tier-2 launches, edge-canaries.ts, and nesting-canaries.ts. All three
// used to hand-roll a near-identical `query()` + `for await` loop (build the
// launch prompt → read the init version → match the Workflow tool_use → read its
// tool_result → optionally wait for the task_notification + parse its output
// file) — a Rule-of-Three duplication that had already drifted between copies:
//
//   - edge-canaries.ts and nesting-canaries.ts each wrapped a thrown non-abort
//     error in `annotateAuth` INSIDE their loop, and the caller (runEdgeChecks /
//     runNestingChecks) wrapped it AGAIN on the way out — a doubled "This
//     harness runs under your local Claude Code subscription…" note. run.ts's
//     own copy never did this (its caller applies annotateAuth exactly once).
//   - run.ts's copy diagnoses a "no decisive tool_result" ending three ways
//     (timed out / tool invoked but no result / never called) — the other two
//     copies had a cruder, less accurate version of the same idea.
//   - edge-canaries.ts and nesting-canaries.ts already matched a tool_result's
//     tool_use_id against the launched Workflow tool_use before accepting it;
//     run.ts's copy never did — it accepted the FIRST tool_result unconditionally
//     (see `git show 67a3561:toolkit/packages/smoke/src/run.ts`). Unifying on the
//     safer (edge/nesting) behavior is a DELIBERATE tightening of run.ts's
//     tier-1/tier-2 matching (the production `pnpm smoke` gating path), not just
//     a drift fix: a stray retry's or unrelated tool_result landing before the
//     real one would previously have been trusted by run.ts and could flip a
//     launch verdict. The practical odds of this firing are low (maxTurns: 4, a
//     single-purpose launch prompt, and no other tool the model is allowed to
//     call) but it is a real behavior change, applied identically to all three
//     call sites, and is called out here explicitly rather than left as a silent
//     side effect of the unification.
//   - nesting-canaries.ts's pre-refactor loop had a latent bug this unification
//     fixes as a side effect: when the parent launched fine but the stream ended
//     WITHOUT a timeout and WITHOUT ever observing a task_notification, the old
//     code left `failureDetail` at the `null` it had already cleared on a
//     successful launch verdict, and silently fed `undefined` to `judgeNesting` —
//     read as a false "no failure" rather than a missing result. The shared
//     driver's `notification: null` + `abortedByTimeout` fields let
//     nesting-canaries.ts now diagnose that ending explicitly ("the run ended
//     without a task_notification for this launch — cannot observe the nesting
//     outcome") — a new, previously-undocumented diagnostic.
//
// This module is the single source of truth for that loop. Non-abort errors are
// rethrown RAW (no annotateAuth here) so each call site's own outer catch can
// annotate exactly once, matching run.ts's original, correct convention.

import { readFileSync } from 'node:fs'
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  isAbortError,
  isRecord,
  launchPrompt,
  launchVerdict,
  readInitVersion,
  readTaskNotification,
  readToolResult,
  readWorkflowToolUse,
  type LaunchVerdict,
  type RunnerOptions,
  type TaskNotification,
  type ToolResult,
} from './lib.js'

export interface DriverOptions {
  /** Which Claude Code binary the SDK drives; omitted for the SDK's bundled
   *  binary (same meaning as RunnerOptions.pathToClaudeCodeExecutable). */
  pathToClaudeCodeExecutable?: string
  /** Optional `args` value passed to the Workflow tool launch (see
   *  RunnerOptions.args) — threaded into launchPrompt as an exact JSON literal. */
  args?: unknown
  /** The scriptPath launched (embedded in the launch prompt). */
  scriptPath: string
  /** Total time budget for the whole session: just the launch when
   *  `waitForCompletion` is false, launch + completion round trip when true. */
  timeoutMs: number
  /** `true` — keep iterating past the launch's own tool_result for the run's
   *  task_notification + read its output file (run.ts's tier-2 round trip,
   *  nesting-canaries.ts: both must observe a COMPLETED run's result — the
   *  claim under test is only decided once the run finishes).
   *  `false` — stop the session as soon as the launch tool_result arrives,
   *  stopping any accepted task first (run.ts's tier-1 launch-only canary,
   *  edge-canaries.ts: both only need the immediate launch verdict — their
   *  cases are rejected synchronously, before any agent runs). */
  waitForCompletion: boolean
  /** run.ts-only defensive check: fail fast (before any tool_result) if the
   *  model launches a DIFFERENT script than requested — a real risk for run.ts,
   *  which launches whichever committed artifact is passed in. edge.ts/nesting.ts
   *  scripts are driven by one single very-specific launch instruction and have
   *  never carried this check — left off there (default false) to preserve
   *  their existing behavior exactly rather than change it as a side effect of
   *  this refactor. */
  validateScriptPath?: boolean
}

export interface DriverResult {
  /** Claude Code version of the binary that ran, from the init message. */
  ccVersion: string | null
  /** True once a tool_result matching the launch was observed. Distinguishes
   *  "never launched" from "launched, no decisive completion" in noResultReason. */
  sawToolResult: boolean
  toolResult: ToolResult | null
  /** The raw SDK message that carried the matched tool_result — only
   *  edge-canaries.ts's CANARY_CAPTURE dump consumes this; the others ignore it. */
  toolResultMessage: unknown
  /** launchVerdict(toolResult), precomputed once — null until a tool_result
   *  arrives. */
  verdict: LaunchVerdict | null
  /** Set (before any tool_result) when validateScriptPath caught a mismatch. */
  scriptMismatch: string | null
  /** The task_notification for this launch, once observed (waitForCompletion only). */
  notification: TaskNotification | null
  /** The raw parsed output-file JSON (waitForCompletion, notification.status ===
   *  'completed', file present and parsed) — the FULL on-disk shape (matching
   *  edge-canaries.ts's raw-message capture convention), not just its `result` key. */
  rawOutput: unknown
  /** rawOutput['result'] when rawOutput is a record, else undefined — the
   *  already-unwrapped value judgeNesting/checkSmokeResult consume. */
  result: unknown
  /** Set when the output file existed but failed to read/parse. */
  outputReadError: string | null
  abortedByTimeout: boolean
  /** A 3-way diagnosis — timed out / invoked-but-no-result / never called —
   *  filled in whenever the session ended without ever observing a matching
   *  tool_result. run.ts always had this; edge-canaries.ts and
   *  nesting-canaries.ts's own copies had drifted to a cruder message —
   *  this restores the finer diagnosis for all three call sites. */
  noResultReason: string | null
}

/** The two side effects the loop performs, injected so the state machine can be
 *  unit-tested with fake SDK-shaped messages (no real query() session, no real
 *  filesystem) — mirrors lib.ts's `peelLaunch` seam. */
export interface DriveLoopDeps {
  /** Reads the output file's raw contents (the loop JSON.parses the result).
   *  The real driver passes `readFileSync(path, 'utf8')`. */
  readOutputFile: (path: string) => string
  /** Stops a background task by id — the fire-and-forget "don't leak a real run"
   *  cleanup for a `waitForCompletion: false` launch. The real driver passes
   *  `q.stopTask`; a rejection is swallowed by the loop itself (matching the
   *  original `.catch(() => undefined)`), so implementations need not guard it. */
  stopTask: (taskId: string) => Promise<void>
}

type DriveLoopOptions = Pick<DriverOptions, 'scriptPath' | 'timeoutMs' | 'waitForCompletion' | 'validateScriptPath'>

/** Pick the DriverOptions fields a RunnerOptions-typed caller can legitimately
 *  forward (pathToClaudeCodeExecutable, args) — the rest of RunnerOptions
 *  (onLaunch/onModel/onExtraLaunch/onComplete/abortController/launchTimeoutMs)
 *  belongs to observe-live.ts's own, separate driver, not this one; DriverOptions
 *  deliberately does not extend RunnerOptions (see its doc comment) so a future
 *  caller can't silently pass those dead options through here. Uses
 *  `exactOptionalPropertyTypes`-safe conditional spreads so an absent field stays
 *  absent rather than becoming an explicit `undefined`. Shared by the three call
 *  sites (run.ts, edge-canaries.ts, nesting-canaries.ts) that build a
 *  DriverOptions from a RunnerOptions they were handed. */
export function pickDriverBase(opts: RunnerOptions): Pick<DriverOptions, 'pathToClaudeCodeExecutable' | 'args'> {
  return {
    ...(opts.pathToClaudeCodeExecutable !== undefined
      ? { pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable }
      : {}),
    ...(opts.args !== undefined ? { args: opts.args } : {}),
  }
}

function initialResult(): DriverResult {
  return {
    ccVersion: null,
    sawToolResult: false,
    toolResult: null,
    toolResultMessage: null,
    verdict: null,
    scriptMismatch: null,
    notification: null,
    rawOutput: undefined,
    result: undefined,
    outputReadError: null,
    abortedByTimeout: false,
    noResultReason: null,
  }
}

/** The extracted state machine behind `runDriverSession`: drives ONE SDK-shaped
 *  message stream (`it`) to its decisive outcome per `opts`, using `deps` for the
 *  loop's two side effects (reading the output file, stopping a fire-and-forget
 *  task). `it` need only implement `next()` (a raw AsyncIterator), not the full
 *  AsyncIterable protocol, so tests can hand it a plain list-backed fake (the SDK's
 *  real `Query` also satisfies this — it's an AsyncGenerator). Reacts to an abort
 *  by treating a non-abort thrown error as fatal (rethrown raw — see module doc)
 *  and an abort error as `abortedByTimeout`; it does NOT own the AbortController/
 *  timer that produces that rejection — `runDriverSession` does. */
export async function driveLoop(
  it: AsyncIterator<unknown>,
  opts: DriveLoopOptions,
  deps: DriveLoopDeps,
): Promise<DriverResult> {
  const result = initialResult()
  let expectedToolUseId: string | null = null

  try {
    for (;;) {
      const step = await it.next()
      if (step.done === true) break
      const message = step.value

      if (result.ccVersion === null) {
        const v = readInitVersion(message)
        if (v !== null) result.ccVersion = v
      }

      const toolUse = readWorkflowToolUse(message)
      if (toolUse !== null) {
        expectedToolUseId = toolUse.id
        if (opts.validateScriptPath === true && toolUse.scriptPath !== opts.scriptPath) {
          result.scriptMismatch = `model launched the wrong script: ${toolUse.scriptPath}`
          break
        }
      }

      const toolResult = readToolResult(message)
      if (toolResult !== null && (expectedToolUseId === null || toolResult.toolUseId === expectedToolUseId)) {
        result.sawToolResult = true
        result.toolResult = toolResult
        result.toolResultMessage = message
        const verdict = launchVerdict(toolResult)
        result.verdict = verdict

        if (!opts.waitForCompletion) {
          // Fire-and-forget: stop any accepted task so the canary never leaves a
          // real run draining in the background, then we're done either way.
          if (verdict.taskId !== null) await deps.stopTask(verdict.taskId).catch(() => undefined)
          break
        }
        if (!verdict.ok) break // a syntax rejection never produces a completion
        // launched fine — keep iterating below for the task_notification
      }

      const notification = readTaskNotification(message)
      if (notification !== null && (expectedToolUseId === null || notification.toolUseId === expectedToolUseId)) {
        result.notification = notification
        if (notification.status === 'completed' && notification.outputFile !== null) {
          try {
            result.rawOutput = JSON.parse(deps.readOutputFile(notification.outputFile))
            result.result = isRecord(result.rawOutput) ? result.rawOutput['result'] : undefined
          } catch (err) {
            result.outputReadError = (err as Error).message
          }
        }
        break
      }

      // Fire-and-forget modes only (tier-1 launch canary, edge canaries): the
      // turn ended (a result message) without a tool_result — stop promptly
      // rather than draining to the timeout. NOT applied when waiting for
      // completion — a background task_notification legitimately arrives after
      // the turn's own "result" message.
      if (!opts.waitForCompletion && isRecord(message) && message['type'] === 'result') break
    }
  } catch (err) {
    if (!isAbortError(err)) throw err
    result.abortedByTimeout = true
  }

  if (!result.sawToolResult) {
    result.noResultReason = result.abortedByTimeout
      ? `timed out after ${opts.timeoutMs} ms before the Workflow launch resolved`
      : expectedToolUseId !== null
        ? 'the Workflow tool was invoked but no tool result arrived before the turn ended'
        : 'the model never called the Workflow tool'
  }

  return result
}

/** Drive ONE `query()` session end-to-end per `opts`. Never calls process.exit;
 *  a non-abort error from the SDK stream is rethrown RAW (see module doc) so the
 *  caller's own outer catch can annotate it exactly once. A thin wrapper: it only
 *  constructs the query() session + owns the AbortController/timer; the state
 *  machine itself is `driveLoop`, unit-tested separately. */
export async function runDriverSession(opts: DriverOptions): Promise<DriverResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  const q = query({
    prompt: launchPrompt(opts.scriptPath, opts.args),
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      allowedTools: ['Workflow'],
      settingSources: [],
      maxTurns: 4,
      abortController: controller,
      ...(opts.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable } : {}),
    },
  })

  try {
    return await driveLoop(q, opts, {
      readOutputFile: (path) => readFileSync(path, 'utf8'),
      stopTask: (taskId) => q.stopTask(taskId),
    })
  } finally {
    clearTimeout(timer)
  }
}
