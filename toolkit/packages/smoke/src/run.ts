// run.ts — the live headless smoke harness ("upgrade canary").
//
// Launches committed toolkit workflow artifacts through the REAL Claude Code
// Workflow runtime via the TS Agent SDK and asserts on the results. Run it
// manually before a release and after every Claude Code upgrade:
//
//     pnpm smoke        # from toolkit/
//
// It is NOT part of `pnpm test`: it spends real agent runs and needs local
// Claude Code subscription auth (the SDK reuses ~/.claude credentials — no
// API key in env). All message-parsing / verdict logic lives in ./lib.ts and
// is unit-tested there against real captured messages; this file is the thin,
// integration-verified glue.
//
// Two tiers:
//   TIER 1 — launch canary: launch each committed toolkit/workflows/*.js and
//     assert the runtime's syntax check accepts it (tool_result is_error
//     false), then stop the run. Arg-less launches are safe: every committed
//     workflow's parseInput throws before def.run, so no agent (let alone a
//     worktree-mutating one) spawns.
//   TIER 2 — round trip: launch the dedicated packages/smoke/wt-smoke.js to
//     completion and assert its PatternResult envelope arrived intact.

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  annotateAuth,
  checkSmokeResult,
  ROUNDTRIP_TIMEOUT_MS,
  type RunnerOptions,
  type RuntimeRunResult,
  summarize,
  type CheckResult,
} from './lib.js'
import { pickDriverBase, runDriverSession } from './sdk-driver.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKFLOWS_DIR = join(HERE, '../../../workflows')
const SMOKE_ARTIFACT = join(HERE, '../wt-smoke.js')
const SMOKE_MARKER = 'wt-smoke-ok'

const LAUNCH_TIMEOUT_MS = 90_000

interface RunOutcome {
  launchOk: boolean
  launchReason: string
  taskId: string | null
  completionStatus: string | null
  result: unknown
  /** Claude Code version of the binary that ran, from the init message. */
  ccVersion: string | null
}

/** Drive ONE query() session (via the shared driver in sdk-driver.ts): launch a
 *  workflow, optionally wait for it to complete. Returns the observed launch +
 *  (optional) completion facts. `opts` selects which Claude Code binary the SDK
 *  drives (bundled by default). */
async function launchWorkflow(
  scriptPath: string,
  waitForCompletion: boolean,
  opts: RunnerOptions,
): Promise<RunOutcome> {
  const timeoutMs = waitForCompletion ? ROUNDTRIP_TIMEOUT_MS : LAUNCH_TIMEOUT_MS
  const d = await runDriverSession({
    ...pickDriverBase(opts),
    scriptPath,
    waitForCompletion,
    validateScriptPath: true, // run.ts-only: catch the model launching a DIFFERENT committed artifact
    timeoutMs,
  })

  const outcome: RunOutcome = {
    launchOk: d.verdict?.ok ?? false,
    launchReason: d.scriptMismatch ?? d.verdict?.reason ?? 'the model never called the Workflow tool',
    taskId: d.verdict?.taskId ?? null,
    completionStatus: null,
    result: undefined,
    ccVersion: d.ccVersion,
  }

  if (waitForCompletion && d.notification !== null) {
    outcome.completionStatus = d.notification.status
    if (d.notification.status === 'completed' && d.notification.outputFile !== null) {
      outcome.completionStatus =
        d.outputReadError !== null ? `read-output-failed: ${d.outputReadError}` : outcome.completionStatus
      if (d.outputReadError === null) outcome.result = d.result
    }
  }

  // Diagnose accurately when the launch never resolved. This only fires when
  // sawToolResult is false, at which point verdict is always null and launchOk
  // is always false — BUT a scriptMismatch is also possible here (the driver
  // sets scriptMismatch and breaks before ever seeing a tool_result), and this
  // unconditionally overwrites outcome.launchReason with the generic
  // noResultReason, clobbering the more specific "model launched the wrong
  // script: …" message set above. Known, pre-existing quirk (predates the
  // sdk-driver.ts extraction — see `git show 67a3561`), deliberately left as-is:
  // it only loses detail (the check still correctly fails), the case is rare
  // (the model would have to launch the wrong script AND then produce no
  // tool_result), and fixing it needs a proper test harness for this file's
  // `launchWorkflow`, which today is integration-verified only, via live
  // `pnpm smoke` (no mocking of runDriverSession exists anywhere in this
  // package's tests) — a bigger lift than this fast-follow warrants.
  if (!d.sawToolResult) {
    outcome.launchReason = d.noResultReason ?? outcome.launchReason
  }

  return outcome
}

function fmtScript(p: string): string {
  return p.replace(/^.*\/(?=workflows\/|packages\/)/, '')
}

/** Run the positive smoke checks (tier 1 launches + tier 2 round trip) against
 *  ONE runtime target. Returns the measured CC version + per-check results — no
 *  process.exit, and an auth/SDK failure becomes a failed CheckResult rather than
 *  a throw, so a matrix caller can keep going to the next target. */
export async function runSmokeChecks(opts: RunnerOptions): Promise<RuntimeRunResult> {
  const checks: CheckResult[] = []
  let ccVersion: string | null = null

  const tier1Artifacts = readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => join(WORKFLOWS_DIR, f))

  if (tier1Artifacts.length === 0) {
    checks.push({ name: 'tier1: discover artifacts', ok: false, detail: `no .js files under ${WORKFLOWS_DIR}` })
  }

  console.log(`  [smoke] Tier 1 — launch canary over ${tier1Artifacts.length} committed artifact(s)`)
  for (const scriptPath of tier1Artifacts) {
    const label = fmtScript(scriptPath)
    try {
      const o = await launchWorkflow(scriptPath, false, opts)
      if (o.ccVersion !== null) ccVersion = o.ccVersion
      checks.push({ name: `tier1 launch: ${label}`, ok: o.launchOk, detail: o.launchOk ? `taskId ${o.taskId}` : o.launchReason })
      console.log(`    ${o.launchOk ? 'ok' : 'FAIL'}  ${label}`)
    } catch (err) {
      checks.push({ name: `tier1 launch: ${label}`, ok: false, detail: annotateAuth(err).message })
      console.log(`    FAIL  ${label}`)
    }
  }

  console.log(`  [smoke] Tier 2 — round trip through wt-smoke.js`)
  try {
    const o = await launchWorkflow(SMOKE_ARTIFACT, true, opts)
    if (o.ccVersion !== null) ccVersion = o.ccVersion
    if (!o.launchOk) {
      checks.push({ name: 'tier2 launch: wt-smoke.js', ok: false, detail: o.launchReason })
    } else if (o.completionStatus !== 'completed') {
      checks.push({ name: 'tier2 completion: wt-smoke.js', ok: false, detail: `status ${o.completionStatus ?? 'none (timed out)'}` })
    } else {
      const problems = checkSmokeResult(o.result, SMOKE_MARKER)
      checks.push({
        name: 'tier2 round trip: wt-smoke.js',
        ok: problems.length === 0,
        detail: problems.length === 0 ? 'envelope intact, marker echoed' : problems.join('; '),
      })
    }
    console.log(`    ${checks[checks.length - 1]?.ok ? 'ok' : 'FAIL'}  wt-smoke.js`)
  } catch (err) {
    checks.push({ name: 'tier2 round trip: wt-smoke.js', ok: false, detail: annotateAuth(err).message })
    console.log(`    FAIL  wt-smoke.js`)
  }

  return { ccVersion, checks }
}

/** Standalone entry: `pnpm smoke` runs the positive checks against the bundled
 *  runtime and exits 0 (all pass) / 1 (a check failed) / 2 (fatal). */
async function main(): Promise<void> {
  console.log(`\n[smoke] positive checks against the bundled runtime`)
  const { checks } = await runSmokeChecks({})
  const { passed, report } = summarize(checks)
  console.log(`\n${report}\n`)
  process.exit(passed ? 0 : 1)
}

// Run main() only when executed directly (`pnpm smoke`), not when the matrix
// orchestrator imports runSmokeChecks from this module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`\n[smoke] FAILED: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  })
}
