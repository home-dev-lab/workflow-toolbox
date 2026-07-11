// nesting-canaries.ts — the live canary for canary C1: writes the
// grandchild/child/parent scripts from nesting.ts to a temp dir, launches the
// PARENT through the REAL Workflow runtime via the TS Agent SDK, and asserts on
// its completed result. Run it manually after a Claude Code upgrade:
//
//     pnpm canary:nesting     # from toolkit/ (bundled runtime only)
//
// Unlike edge-canaries.ts (which only needs the launch's immediate tool_result —
// its two cases are rejected SYNCHRONOUSLY, before any agent runs), this one must
// wait for the whole run to finish: the parent launches fine, runs the child,
// and it's the child's OWN nested workflow() call that throws. So this driver
// mirrors `run.ts`'s tier-2 round trip (wait for task_notification, read its
// output file) rather than edge-canaries.ts's single-message capture. The
// matrix orchestrator (`pnpm canary`) calls runNestingChecks against each
// runtime target. Out of `pnpm test` — it drives the SDK and needs local Claude
// Code subscription auth. All verdict logic is the pure nesting.ts code that
// `pnpm test` covers; this is glue.
//
// Capture mode: set CANARY_CAPTURE=<dir> to also dump the raw output-file JSON
// to <dir>/nesting-depth2-result.json — used to (re)mint the test fixture.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  annotateAuth,
  type CheckResult,
  ROUNDTRIP_TIMEOUT_MS,
  type RunnerOptions,
  type RuntimeRunResult,
  summarize,
} from './lib.js'
import { childScript, DEPTH1_NAME, DEPTH2_NAME, grandchildScript, judgeNesting, parentScript } from './nesting.js'
import { pickDriverBase, runDriverSession } from './sdk-driver.js'

interface NestingOutcome {
  /** undefined when the run never produced a readable result (launch rejected,
   *  the run failed/stopped, or it timed out) — the caller reports that as its
   *  own failure rather than passing it on to judgeNesting silently. */
  result: unknown
  /** The raw parsed output-file JSON (undefined unless the run completed and the
   *  file parsed) — kept separate from `result` so CANARY_CAPTURE can dump the
   *  FULL shape a real run writes (summary, logs, workflowProgress, …), matching
   *  edge-canaries.ts's raw-capture convention, while `result` stays the
   *  already-unwrapped value judgeNesting consumes. */
  rawOutput: unknown
  ccVersion: string | null
  /** Set when the outcome is NOT a clean completed-with-result — explains why. */
  failureDetail: string | null
}

/** Launch the parent to completion and read its result off the task_notification
 *  output file — the same completion path `run.ts`'s tier-2 round trip uses, via
 *  the shared driver in sdk-driver.ts. `opts` selects which Claude Code binary
 *  the SDK drives (bundled by default). */
async function launchAndAwaitResult(parentScriptPath: string, opts: RunnerOptions): Promise<NestingOutcome> {
  const d = await runDriverSession({
    ...pickDriverBase(opts),
    scriptPath: parentScriptPath,
    waitForCompletion: true,
    timeoutMs: ROUNDTRIP_TIMEOUT_MS,
  })

  const outcome: NestingOutcome = {
    result: undefined,
    rawOutput: undefined,
    ccVersion: d.ccVersion,
    failureDetail: 'the model never called the Workflow tool',
  }

  if (!d.sawToolResult) {
    outcome.failureDetail = d.noResultReason
    return outcome
  }

  if (d.verdict !== null && !d.verdict.ok) {
    outcome.failureDetail = `launch rejected: ${d.verdict.reason}` // depth-1 should always launch fine; a syntax rejection never runs
    return outcome
  }

  if (d.notification === null) {
    // Launched fine but the session ended (timeout, or the stream simply closed)
    // before a task_notification for this launch ever arrived.
    outcome.failureDetail = d.abortedByTimeout
      ? `timed out after ${ROUNDTRIP_TIMEOUT_MS} ms before the run completed`
      : 'the run ended without a task_notification for this launch — cannot observe the nesting outcome'
    return outcome
  }

  if (d.notification.status !== 'completed' || d.notification.outputFile === null) {
    outcome.failureDetail = `run did not complete (status ${d.notification.status}) — cannot observe the nesting outcome`
    return outcome
  }

  if (d.outputReadError !== null) {
    outcome.failureDetail = `failed to read the output file: ${d.outputReadError}`
    return outcome
  }

  outcome.result = d.result
  outcome.rawOutput = d.rawOutput
  outcome.failureDetail = null
  return outcome
}

/** Run canary C1 (the workflow()-nesting-depth checks) against ONE runtime
 *  target. Returns the measured CC version + the two CheckResults from
 *  judgeNesting. No process.exit; a thrown SDK/auth error becomes failed
 *  CheckResults so a matrix caller can continue to the next target. */
export async function runNestingChecks(opts: RunnerOptions): Promise<RuntimeRunResult> {
  const captureDir = process.env['CANARY_CAPTURE'] ?? null
  const dir = mkdtempSync(join(tmpdir(), 'wt-canary-nest-'))

  console.log(`  [canary] nesting-depth canary (canary C1)`)
  let ccVersion: string | null = null
  let checks: CheckResult[]
  try {
    const grandchildPath = join(dir, 'wt-canary-nest-grandchild.js')
    const childPath = join(dir, 'wt-canary-nest-child.js')
    const parentPath = join(dir, 'wt-canary-nest-parent.js')
    writeFileSync(grandchildPath, grandchildScript())
    writeFileSync(childPath, childScript(grandchildPath))
    writeFileSync(parentPath, parentScript(childPath))

    try {
      const o = await launchAndAwaitResult(parentPath, opts)
      ccVersion = o.ccVersion
      if (o.failureDetail !== null) {
        checks = [
          { name: DEPTH1_NAME, ok: false, detail: o.failureDetail },
          { name: DEPTH2_NAME, ok: false, detail: 'skipped — the round trip did not produce a readable result' },
        ]
      } else {
        if (captureDir !== null) {
          // Dump the FULL raw output-file JSON (summary, logs, workflowProgress,
          // …) — matching edge-canaries.ts's raw-message capture convention and
          // the committed fixture's actual shape, so this path can really
          // (re)mint it. `o.result` (the already-unwrapped `result` field) is
          // what judgeNesting/the fixture-reading test consume; `o.rawOutput` is
          // the on-disk shape a real run wrote, kept only for this dump.
          writeFileSync(join(captureDir, 'nesting-depth2-result.json'), `${JSON.stringify(o.rawOutput, null, 2)}\n`)
        }
        checks = judgeNesting(o.result)
      }
    } catch (err) {
      const detail = annotateAuth(err).message
      checks = [
        { name: DEPTH1_NAME, ok: false, detail },
        { name: DEPTH2_NAME, ok: false, detail: 'skipped — the launch/round trip threw' },
      ]
    }
  } finally {
    // Always remove the temp scripts, even on an abort-triggered throw.
    rmSync(dir, { recursive: true, force: true })
  }

  for (const c of checks) console.log(`    ${c.ok ? 'ok' : 'FAIL'}  ${c.name}`)
  return { ccVersion, checks }
}

/** Standalone entry: `pnpm canary:nesting` runs canary C1 against the bundled
 *  runtime and exits 0 (all pass) / 1 (a check failed) / 2 (fatal). */
async function main(): Promise<void> {
  console.log(`\n[canary] nesting-depth checks (canary C1) against the bundled runtime`)
  const { checks } = await runNestingChecks({})
  const { passed, report } = summarize(checks)
  console.log(`\n${report}\n`)
  process.exit(passed ? 0 : 1)
}

// Run main() only when executed directly, not when the orchestrator imports
// runNestingChecks from this module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`\n[canary] FAILED: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
}
