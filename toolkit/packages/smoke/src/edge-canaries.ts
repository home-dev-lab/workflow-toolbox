// edge-canaries.ts — the live NEGATIVE-case canary. Writes the malformed/oversized
// workflow scripts from edge.ts to a temp dir and launches each through the REAL
// Workflow runtime via the TS Agent SDK, asserting the tool layer REJECTS it
// (tool_result is_error). Run it manually after a Claude Code upgrade:
//
//     pnpm canary:edge        # from toolkit/ (bundled runtime only)
//
// It complements `pnpm smoke`: smoke proves a VALID artifact still runs; this
// proves the runtime still REJECTS the things it must (the 512 KB cap and a
// statement before `meta`). The matrix orchestrator (`pnpm canary`) calls
// runEdgeChecks against each runtime target. Like smoke, it is OUT of `pnpm test`
// — it drives the SDK and needs local Claude Code subscription auth. All verdict
// logic is the pure edge.ts/lib.ts code that `pnpm test` covers; this is glue.
//
// Capture mode: set CANARY_CAPTURE=<dir> to also dump each raw tool_result SDK
// message to <dir>/<filename>.raw.json — used once to mint the test fixtures.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  annotateAuth,
  type CheckResult,
  isAbortError,
  isRecord,
  launchPrompt,
  parseLaunchText,
  readInitVersion,
  readToolResult,
  readWorkflowToolUse,
  type RunnerOptions,
  type RuntimeRunResult,
  summarize,
} from './lib.js'
import { type EdgeCase, edgeCases, judgeRejection } from './edge.js'

const LAUNCH_TIMEOUT_MS = 90_000

interface CaptureOutcome {
  message: unknown
  ccVersion: string | null
}

/** Launch one (expected-invalid) script and return the raw SDK message that
 *  carried the tool_result (+ the runtime's init version), or message=null if
 *  none arrived. Defensive: if the launch is unexpectedly ACCEPTED (a regression),
 *  stop the spawned task so we never leak a real run from the canary. `opts`
 *  selects which Claude Code binary the SDK drives (bundled by default). */
async function launchAndCaptureResult(scriptPath: string, opts: RunnerOptions): Promise<CaptureOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LAUNCH_TIMEOUT_MS)
  const q = query({
    prompt: launchPrompt(scriptPath),
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

  const outcome: CaptureOutcome = { message: null, ccVersion: null }
  let expectedToolUseId: string | null = null
  try {
    for await (const message of q) {
      if (outcome.ccVersion === null) {
        const v = readInitVersion(message)
        if (v !== null) outcome.ccVersion = v
      }

      const toolUse = readWorkflowToolUse(message)
      if (toolUse !== null) expectedToolUseId = toolUse.id

      const toolResult = readToolResult(message)
      if (toolResult !== null && (expectedToolUseId === null || toolResult.toolUseId === expectedToolUseId)) {
        outcome.message = message
        // Regression guard: an invalid script that is ACCEPTED returns a taskId —
        // stop it so the canary never leaves a real run draining in the background.
        if (!toolResult.isError) {
          const { taskId } = parseLaunchText(toolResult.text)
          if (taskId !== null) await q.stopTask(taskId).catch(() => undefined)
        }
        break
      }

      // Turn ended (a result message) without a tool_result — stop promptly.
      if (isRecord(message) && message['type'] === 'result') break
    }
  } catch (err) {
    if (!isAbortError(err)) throw annotateAuth(err)
  } finally {
    clearTimeout(timer)
  }
  return outcome
}

/** Run the negative-case checks against ONE runtime target. Returns the measured
 *  CC version + per-check results (each carries a canonicalized rejection reason).
 *  No process.exit; a thrown SDK/auth error becomes a failed CheckResult so a
 *  matrix caller can continue to the next target. */
export async function runEdgeChecks(opts: RunnerOptions): Promise<RuntimeRunResult> {
  const captureDir = process.env['CANARY_CAPTURE'] ?? null
  const cases: EdgeCase[] = edgeCases()
  const checks: CheckResult[] = []
  let ccVersion: string | null = null
  const dir = mkdtempSync(join(tmpdir(), 'dwt-canary-'))

  console.log(`  [canary] negative-case canary over ${cases.length} case(s)`)
  try {
    for (const c of cases) {
      const scriptPath = join(dir, c.filename)
      writeFileSync(scriptPath, c.script)

      let check: CheckResult
      try {
        const o = await launchAndCaptureResult(scriptPath, opts)
        if (o.ccVersion !== null) ccVersion = o.ccVersion
        if (captureDir !== null && o.message !== null) {
          writeFileSync(join(captureDir, `${c.filename}.raw.json`), `${JSON.stringify(o.message, null, 2)}\n`)
        }
        const result = o.message !== null ? readToolResult(o.message) : null
        check =
          result === null
            ? { name: c.name, ok: false, detail: 'no tool_result observed (timeout or the model never called Workflow)' }
            : judgeRejection(c.name, result, c.reasonPattern)
      } catch (err) {
        check = { name: c.name, ok: false, detail: annotateAuth(err).message }
      }
      checks.push(check)
      console.log(`    ${check.ok ? 'ok' : 'FAIL'}  ${c.name}`)
    }
  } finally {
    // Always remove the temp scripts, even on an abort-triggered throw.
    rmSync(dir, { recursive: true, force: true })
  }

  return { ccVersion, checks }
}

/** Standalone entry: `pnpm canary:edge` runs the negative checks against the
 *  bundled runtime and exits 0 (all pass) / 1 (a check failed) / 2 (fatal). */
async function main(): Promise<void> {
  console.log(`\n[canary] negative checks against the bundled runtime`)
  const { checks } = await runEdgeChecks({})
  const { passed, report } = summarize(checks)
  console.log(`\n${report}\n`)
  process.exit(passed ? 0 : 1)
}

// Run main() only when executed directly, not when the orchestrator imports
// runEdgeChecks from this module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`\n[canary] FAILED: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
}
