// budget-canaries.ts — the live canary for canary C2: writes the two probe
// scripts from budget.ts to a temp dir, launches probe A through the REAL
// Workflow runtime via the TS Agent SDK to COMPLETION, THEN launches probe B
// (strictly sequential — the claim is about what a SECOND orchestrator launch
// sees after real spend already happened, and running them in parallel would
// blur that), and asserts on the pair with judgeBudget. Run it manually after
// a Claude Code upgrade, or whenever the budget-pool claim needs re-pinning:
//
//     pnpm canary:budget     # from toolkit/ (bundled runtime only)
//
// Each probe is its OWN `runDriverSession` call — a separate SDK `query()`
// session, i.e. the same "orchestrator launches a run as an independent
// session" shape the multi-level-pipeline execution model uses (as opposed to
// nesting-canaries.ts's single session with a nested workflow() call). Like
// nesting-canaries.ts, this must wait for each run to complete (the numbers
// under test are only meaningful post-completion), so it mirrors
// nesting-canaries.ts's completion round trip rather than edge-canaries.ts's
// single-message capture. The matrix orchestrator (`pnpm canary`) calls
// runBudgetChecks against each runtime target. Out of `pnpm test` — it drives
// the SDK, spends real budget, and needs local Claude Code subscription auth.
// All verdict logic is the pure budget.ts code that `pnpm test` covers; this
// is glue.
//
// Capture mode: set CANARY_CAPTURE=<dir> to also dump the raw output-file
// JSON for both runs to <dir>/budget-a-result.json and
// <dir>/budget-b-result.json.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { budgetProbeScript, BUDGET_COUNTER_NAME, BUDGET_ISOLATION_NAME, judgeBudget } from './budget.js'
import {
  annotateAuth,
  type CheckResult,
  ROUNDTRIP_TIMEOUT_MS,
  type RunnerOptions,
  type RuntimeRunResult,
  summarize,
} from './lib.js'
import { pickDriverBase, runDriverSession } from './sdk-driver.js'

interface ProbeOutcome {
  /** undefined when the run never produced a readable result (launch rejected,
   *  the run failed/stopped, or it timed out) — the caller reports that as its
   *  own failure rather than feeding it to judgeBudget silently. */
  result: unknown
  /** The raw parsed output-file JSON (undefined unless the run completed and
   *  the file parsed) — kept separate from `result` for CANARY_CAPTURE, same
   *  convention as nesting-canaries.ts. */
  rawOutput: unknown
  ccVersion: string | null
  /** Set when the outcome is NOT a clean completed-with-result — explains why. */
  failureDetail: string | null
}

/** Launch one probe to completion and read its result off the
 *  task_notification output file — the same completion path
 *  nesting-canaries.ts / run.ts's tier-2 round trip uses, via the shared
 *  driver in sdk-driver.ts. */
async function launchProbeAndAwaitResult(probeScriptPath: string, opts: RunnerOptions): Promise<ProbeOutcome> {
  const d = await runDriverSession({
    ...pickDriverBase(opts),
    scriptPath: probeScriptPath,
    waitForCompletion: true,
    timeoutMs: ROUNDTRIP_TIMEOUT_MS,
  })

  const outcome: ProbeOutcome = {
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
    outcome.failureDetail = `launch rejected: ${d.verdict.reason}` // the probe should always launch fine — a syntax rejection never runs
    return outcome
  }

  if (d.notification === null) {
    outcome.failureDetail = d.abortedByTimeout
      ? `timed out after ${ROUNDTRIP_TIMEOUT_MS} ms before the run completed`
      : 'the run ended without a task_notification for this launch — cannot observe the budget outcome'
    return outcome
  }

  if (d.notification.status !== 'completed' || d.notification.outputFile === null) {
    outcome.failureDetail = `run did not complete (status ${d.notification.status}) — cannot observe the budget outcome`
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

/** Run canary C2 (the budget-pool-isolation checks) against ONE runtime
 *  target. Launches probe A to completion FIRST, then probe B — strictly
 *  sequential, two separate SDK sessions. Returns the measured CC version +
 *  the two CheckResults from judgeBudget. No process.exit; a thrown SDK/auth
 *  error becomes failed CheckResults so a matrix caller can continue to the
 *  next target. If A fails, B is skipped entirely and both checks report the
 *  A failure honestly (a shared-pool claim about B is meaningless without a
 *  real A to compare against). */
export async function runBudgetChecks(opts: RunnerOptions): Promise<RuntimeRunResult> {
  const captureDir = process.env['CANARY_CAPTURE'] ?? null
  const dir = mkdtempSync(join(tmpdir(), 'wt-canary-budget-'))

  console.log(`  [canary] budget-pool canary (canary C2)`)
  let ccVersion: string | null = null
  let checks: CheckResult[]
  try {
    const probeAPath = join(dir, 'wt-canary-budget-a.js')
    const probeBPath = join(dir, 'wt-canary-budget-b.js')
    writeFileSync(probeAPath, budgetProbeScript('a'))
    writeFileSync(probeBPath, budgetProbeScript('b'))

    try {
      const a = await launchProbeAndAwaitResult(probeAPath, opts)
      ccVersion = a.ccVersion
      if (a.failureDetail !== null) {
        checks = [
          { name: BUDGET_COUNTER_NAME, ok: false, detail: `probe A: ${a.failureDetail}` },
          { name: BUDGET_ISOLATION_NAME, ok: false, detail: 'skipped — probe A did not produce a readable result' },
        ]
      } else {
        if (captureDir !== null) {
          writeFileSync(join(captureDir, 'budget-a-result.json'), `${JSON.stringify(a.rawOutput, null, 2)}\n`)
        }

        const b = await launchProbeAndAwaitResult(probeBPath, opts)
        ccVersion = b.ccVersion ?? ccVersion
        if (b.failureDetail !== null) {
          checks = [
            { name: BUDGET_COUNTER_NAME, ok: false, detail: `probe B: ${b.failureDetail}` },
            { name: BUDGET_ISOLATION_NAME, ok: false, detail: 'skipped — probe B did not produce a readable result' },
          ]
        } else {
          if (captureDir !== null) {
            writeFileSync(join(captureDir, 'budget-b-result.json'), `${JSON.stringify(b.rawOutput, null, 2)}\n`)
          }
          checks = judgeBudget({ first: a.result, second: b.result })
        }
      }
    } catch (err) {
      const detail = annotateAuth(err).message
      checks = [
        { name: BUDGET_COUNTER_NAME, ok: false, detail },
        { name: BUDGET_ISOLATION_NAME, ok: false, detail: 'skipped — a launch/round trip threw' },
      ]
    }
  } finally {
    // Always remove the temp scripts, even on an abort-triggered throw.
    rmSync(dir, { recursive: true, force: true })
  }

  for (const c of checks) console.log(`    ${c.ok ? 'ok' : 'FAIL'}  ${c.name}`)
  return { ccVersion, checks }
}

/** Standalone entry: `pnpm canary:budget` runs canary C2 against the bundled
 *  runtime and exits 0 (all pass) / 1 (a check failed) / 2 (fatal). */
async function main(): Promise<void> {
  console.log(`\n[canary] budget-pool checks (canary C2) against the bundled runtime`)
  const { checks } = await runBudgetChecks({})
  const { passed, report } = summarize(checks)
  console.log(`\n${report}\n`)
  process.exit(passed ? 0 : 1)
}

// Run main() only when executed directly, not when the orchestrator imports
// runBudgetChecks from this module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`\n[canary] FAILED: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
}
