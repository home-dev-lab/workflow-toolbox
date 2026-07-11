// observe-live.ts — the IMPURE IO shell that wires a REAL workflow run into the
// pure live coordinator (@workflow-toolbox/observe `runLiveDriver`). It owns the two
// deps the coordinator deliberately does not: the SDK event stream (via the Agent
// SDK `query()`) and the filesystem (tailing the per-agent transcript `.jsonl`
// files). Mirrors run.ts's launch machinery; held out of `pnpm test` (smoke has no
// test script — it spends real agent runs and needs ~/.claude auth), typecheck-only.
//
//     pnpm exec tsx packages/smoke/src/observe-live.ts <abs-scriptPath>
//
// Flow: launch the workflow, peel the stream until the launch tool_result yields
// the runId + transcript dir, then hand the REMAINDER of the stream to
// runLiveDriver as its `events`, with `pullFs` tailing the transcript dir. The
// coordinator folds SDK (tier sdk) + transcript (tier transcript) into one live
// model and calls onModel after every event.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createLineSplitter, lineToMessagePatch, pollTail, runLiveDriver } from '@workflow-toolbox/observe'
import type { LiveDriverResult, Patch } from '@workflow-toolbox/observe'
import { isRecord } from '@workflow-toolbox/std'
import { annotateAuth, classifyAgentFile, isAbortError, launchPrompt, LaunchTimeoutError, peelLaunch, readTaskNotification, readWorkflowToolUse, resumePrompt, type LaunchInfo, type RunnerOptions, type TaskNotification, type WorkflowCompletion } from './lib.js'

// Re-export the public types a consumer of observeLiveRun needs — the opts shape and
// the return shape — so they are reachable from this package entry (exports["./observe-live"])
// without reaching into ./lib.js or @workflow-toolbox/observe directly.
export type { LaunchInfo, RunnerOptions, WorkflowCompletion } from './lib.js'
export type { LiveDriverResult } from '@workflow-toolbox/observe'
// Default total safety timeout — short, suited to the CLI/canary. An interactive
// observer (the dev server) overrides it via RunnerOptions.timeoutMs.
const OBSERVE_TIMEOUT_MS = 240_000
// Default Phase-1 launch deadline — how long to wait for the launch tool_result
// before declaring the SDK session stuck. Far below OBSERVE_TIMEOUT_MS (and below
// the dev server's 30-min run timeout) so a flaky launch fails fast, not in 30 min.
const OBSERVE_LAUNCH_TIMEOUT_MS = 60_000

/** Per-file tail state: where we have read up to, the partial-line splitter, and
 *  the UTF-8 decoder that buffers a multi-byte codepoint straddling a poll. */
interface TailState {
  offset: number
  splitter: ReturnType<typeof createLineSplitter>
  decoder: StringDecoder
}

/** Build the `pullFs` callback: on each call, discover `agent-<id>.jsonl` files in
 *  the transcript dir and emit agent.message patches for any NEW complete lines
 *  since the previous call. Pure-ish (closure state), reuses observe's pollTail +
 *  line splitter + lineToMessagePatch — the SAME parsing the one-shot FS ingestor
 *  uses, so live and post-mortem reconstruct identically.
 *
 *  NOTE: readdirSync runs on every SDK event (pullFs is called once per event by
 *  runLiveDriver). The set of agent files changes rarely, but the directory listing
 *  is re-scanned from scratch each call. For typical agent counts this is cheap; if
 *  event rates are very high consider a coarser poll cadence in the caller. */
function makeFsTailer(transcriptDir: string): () => Patch[] {
  const tails = new Map<string, TailState>()
  return () => {
    const patches: Patch[] = []
    if (!existsSync(transcriptDir)) return patches
    let entries: string[]
    try {
      entries = readdirSync(transcriptDir)
    } catch {
      return patches
    }
    for (const name of entries) {
      const agentId = classifyAgentFile(name)
      if (agentId === null) continue // skip journal.jsonl, agent-<id>.meta.json, etc.
      let state = tails.get(name)
      if (state === undefined) {
        state = { offset: 0, splitter: createLineSplitter(), decoder: new StringDecoder('utf8') }
        tails.set(name, state)
      }
      const { chunk, offset } = pollTail(join(transcriptDir, name), state.offset, state.decoder)
      state.offset = offset
      if (chunk.length === 0) continue
      for (const line of state.splitter.feed(chunk)) {
        const patch = lineToMessagePatch(line, agentId)
        if (patch !== null) patches.push(patch)
      }
    }
    return patches
  }
}

/** Re-yield SDK stream messages and STOP after the terminal task_notification for
 *  this run, so runLiveDriver returns promptly at completion instead of draining
 *  the session to maxTurns/timeout.
 *
 *  Takes the live AsyncIterator (NOT the iterable) and drives it with manual
 *  `it.next()`. This is load-bearing: the caller pulls the launch tool_result from
 *  the SAME iterator first, and a `for await … break` there would call
 *  `it.return()` and CLOSE the SDK stream — leaving this stage nothing to fold
 *  (the empty-model / "done in ~4s" bug). Manual iteration keeps the stream open. */
async function* untilDone(
  it: AsyncIterator<unknown>,
  toolUseId: string | null,
  onExtraLaunch: () => void,
  onComplete: (n: TaskNotification) => void,
): AsyncIterable<unknown> {
  while (true) {
    const { value, done } = await it.next()
    if (done === true) return
    // A SECOND Workflow tool_use after the launch = the driver looping (a weak driver
    // model re-invoking Workflow despite "call it exactly once"). This is the in-session
    // multiplier behind the 2026-06-20 runaway. Stop NOW — before the extra workflow
    // executes and spends tokens — by signalling the caller to abort the session. The
    // first launch's tool_use was already consumed in Phase 1, so any here is a 2nd+.
    if (readWorkflowToolUse(value) !== null) {
      onExtraLaunch()
      return
    }
    yield value
    const n = readTaskNotification(value)
    if (n !== null && (toolUseId === null || n.toolUseId === toolUseId)) {
      onComplete(n)
      return
    }
  }
}

/** Read a run's terminal outcome from its task_notification — status ALWAYS carried
 *  through verbatim (never collapsed), result (the script's return value, from the terminal
 *  outputFile — the same mechanism the smoke canary uses (run.ts): the file holds
 *  `{ result: <return value>, ... }`) only attempted when status is 'completed'. Exported for
 *  direct unit testing (pure: one TaskNotification in, one WorkflowCompletion out, the only
 *  I/O being a single best-effort readFileSync). Best-effort: a non-completed status is
 *  reported as-is with result: undefined WITHOUT ever touching outputFile (a failed run's
 *  outputFile is not guaranteed to exist/hold a result); a missing outputFile or an
 *  unreadable/non-JSON file on a 'completed' run also yields result: undefined (the caller
 *  treats "no result" as a non-fatal gap, distinct from a non-'completed' status). */
export function readWorkflowCompletion(n: TaskNotification): WorkflowCompletion {
  if (n.status !== 'completed' || n.outputFile === null) return { status: n.status, result: undefined }
  try {
    const parsed: unknown = JSON.parse(readFileSync(n.outputFile, 'utf8'))
    return { status: n.status, result: isRecord(parsed) ? parsed['result'] : undefined }
  } catch {
    return { status: n.status, result: undefined }
  }
}

/** Launch `scriptPath` and observe it live to completion. Returns the final folded
 *  hybrid model. Throws (via annotateAuth) on an SDK/auth failure or a launch
 *  syntax error. */
/** Default onModel: a one-line progress log (the CLI behaviour). An SSE caller
 *  passes its own onModel to forward each folded update to the browser instead. */
function logModel(model: LiveDriverResult['model']): void {
  const agents = model.agents.size
  const tok = model.tokens?.value ?? 0
  const status = model.status?.value ?? 'running'
  console.log(`  [observe] ${status}  agents=${agents}  tokens=${tok}  phases=${model.phases.size}`)
}

export async function observeLiveRun(scriptPath: string, opts: RunnerOptions = {}): Promise<LiveDriverResult> {
  // Caller may inject a controller (to abort on client disconnect); otherwise the
  // safety timeout below is the only thing that aborts.
  const controller = opts.abortController ?? new AbortController()
  const timeoutMs = opts.timeoutMs ?? OBSERVE_TIMEOUT_MS
  const launchTimeoutMs = opts.launchTimeoutMs ?? OBSERVE_LAUNCH_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const q = query({
    prompt: launchPrompt(scriptPath, opts.args),
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      allowedTools: ['Workflow'],
      settingSources: [],
      maxTurns: 4,
      abortController: controller,
      ...(opts.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    },
  })

  // ONE iterator drives both phases. Manual it.next() (not for-await) so peeling
  // the launch result below does NOT close the SDK stream — see untilDone.
  const it = q[Symbol.asyncIterator]()
  try {
    // Phase 1 — peel the stream until the launch tool_result (the only place the
    // runId + transcript dir appear), BOUNDED by launchTimeoutMs. A stuck/flaky
    // launch that never produces a tool_result rejects fast (LaunchTimeoutError)
    // instead of hanging until the far larger run-level timeoutMs.
    let info: LaunchInfo
    try {
      info = await peelLaunch(it, launchTimeoutMs)
    } catch (err) {
      // The SDK session is still alive (the losing it.next() is pending) — abort it
      // now so a stuck launch does not leak a `claude` process until timeoutMs.
      controller.abort()
      throw err
    }
    opts.onLaunch?.(info)

    // Phase 2 — fold the REMAINING stream + the growing transcripts into one model.
    // Abort the session if the driver tries to launch a SECOND workflow (anti-runaway):
    // we stop folding AND abort the controller so the extra workflow never runs.
    return await runLiveDriver({
      runId: info.runId,
      events: untilDone(
        it,
        info.toolUseId,
        () => {
          opts.onExtraLaunch?.(info.runId)
          controller.abort()
        },
        (n) => opts.onComplete?.(readWorkflowCompletion(n)),
      ),
      pullFs: makeFsTailer(info.transcriptDir),
      onModel: opts.onModel ?? logModel,
    })
  } catch (err) {
    if (err instanceof LaunchTimeoutError) {
      throw new Error(`observe-live: ${err.message} — aborted the SDK session (launchTimeoutMs=${launchTimeoutMs})`)
    }
    if (isAbortError(err)) throw new Error(`observe-live timed out after ${timeoutMs} ms`)
    throw annotateAuth(err)
  } finally {
    clearTimeout(timer)
  }
}

/** Resume a run orphaned by a process death (card #1812476922312000519, increment A3):
 *  re-invoke the Workflow tool on the SAME (unforked) SDK session so completed `agent()`
 *  calls replay from the journal cache — pinned live by the resume-parity canary
 *  (run2.jsonl). Mirrors observeLiveRun (SAME Phase-1/Phase-2 flow, timeouts, abort/error
 *  handling, anti-runaway guard) with exactly two differences:
 *   1. the prompt (resumePrompt, not launchPrompt) and the query options carry
 *      `resume: sessionId` — NEVER `forkSession` (an unforked resume is the whole point:
 *      forking would mint a NEW session with none of the original's cache);
 *   2. `maxTurns: 6`, not 4 — a resumed session first silently digests an unsolicited
 *      `task_notification` about the orphaned background run (an empty, zero-turn "reply")
 *      before the model actually re-invokes Workflow (observed in run2.jsonl: TWO `init`s
 *      and an empty `result` precede the real work) — peelLaunch itself needs no change (it
 *      already skips any non-tool_result message while waiting), but the SDK session as a
 *      whole needs the extra turn budget to get there.
 *  Deliberately duplicated rather than refactored into a shared core with observeLiveRun:
 *  this file is typecheck-only (no unit tests — driving the real SDK needs ~/.claude auth,
 *  per the file-level doc), so a shared-core refactor of the EXISTING, production
 *  observeLiveRun would have no test harness to verify it stayed behavior-identical. Revisit
 *  if a THIRD variant of this flow ever appears (Rule of Three). */
export async function resumeLiveRun(
  scriptPath: string,
  runId: string,
  sessionId: string,
  opts: RunnerOptions = {},
): Promise<LiveDriverResult> {
  const controller = opts.abortController ?? new AbortController()
  const timeoutMs = opts.timeoutMs ?? OBSERVE_TIMEOUT_MS
  const launchTimeoutMs = opts.launchTimeoutMs ?? OBSERVE_LAUNCH_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const q = query({
    prompt: resumePrompt(scriptPath, runId, opts.args),
    options: {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      allowedTools: ['Workflow'],
      settingSources: [],
      maxTurns: 6,
      abortController: controller,
      resume: sessionId,
      ...(opts.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: opts.pathToClaudeCodeExecutable } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    },
  })

  const it = q[Symbol.asyncIterator]()
  try {
    let info: LaunchInfo
    try {
      info = await peelLaunch(it, launchTimeoutMs)
    } catch (err) {
      controller.abort()
      throw err
    }
    opts.onLaunch?.(info)

    return await runLiveDriver({
      runId: info.runId,
      events: untilDone(
        it,
        info.toolUseId,
        () => {
          opts.onExtraLaunch?.(info.runId)
          controller.abort()
        },
        (n) => opts.onComplete?.(readWorkflowCompletion(n)),
      ),
      pullFs: makeFsTailer(info.transcriptDir),
      onModel: opts.onModel ?? logModel,
    })
  } catch (err) {
    if (err instanceof LaunchTimeoutError) {
      throw new Error(`observe-live (resume): ${err.message} — aborted the SDK session (launchTimeoutMs=${launchTimeoutMs})`)
    }
    if (isAbortError(err)) throw new Error(`observe-live (resume) timed out after ${timeoutMs} ms`)
    throw annotateAuth(err)
  } finally {
    clearTimeout(timer)
  }
}

async function main(): Promise<void> {
  const scriptPath = process.argv[2]
  if (scriptPath === undefined) {
    console.error('usage: tsx observe-live.ts <abs-scriptPath>')
    process.exit(2)
  }
  const result = await observeLiveRun(scriptPath)
  console.log(
    `\n[observe] done: run ${result.runId} — ${result.model.agents.size} agent(s), ` +
      `${result.model.phases.size} phase(s), status ${result.model.status?.value ?? 'unknown'}, ` +
      `${result.patches.length} patch(es).`,
  )
  process.exit(0)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`\n[observe] FAILED: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
