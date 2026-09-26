#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parsePilotRunnerArgs, runPilot } from './lib/pilot-runner-core.mjs'
import { resolvePilotModels } from './lib/pilot-model-config.mjs'
import { resolveAgentSdk, resolvedAgentSdkCodePaths } from './lib/sdk-resolution.mjs'
import { recordSessionEnvLog } from './lib/session-env-log.mjs'
import { pilotAdmission } from './lib/pilot-admission.mjs'
import { resolveWorkflowToolboxOption } from './lib/plugin-options.mjs'
import { decidePilotRun } from './lib/host/pilot-decision-store.mjs'

function usage() {
  return 'Usage: node wt-pilot-runner.mjs --card <id> --dir <worktree> --card-file <path> [...]\n       node wt-pilot-runner.mjs decide --run <id> --dod <n> --reading <text> [--state-root <path>]'
}

function decisionArgs(argv) {
  const out = { runId: null, criterion: null, reading: null, root: null }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--run') out.runId = argv[++index] ?? null
    else if (arg === '--dod') out.criterion = Number(argv[++index])
    else if (arg === '--reading') out.reading = argv[++index] ?? null
    else if (arg === '--state-root') out.root = argv[++index] ?? null
    else return { error: `unknown decide argument: ${arg}` }
  }
  if (!out.runId || !out.reading || !Number.isSafeInteger(out.criterion) || out.criterion < 1) return { error: 'decide requires --run <id> --dod <positive integer> --reading <text>' }
  return out
}

async function main() {
  if (process.argv[2] === 'decide') {
    const args = decisionArgs(process.argv.slice(2))
    if (args.error) { process.stderr.write(`wt-pilot-runner: ${args.error}\n${usage()}\n`); return 2 }
    try {
      const result = decidePilotRun(args)
      process.stdout.write(`decided run=${args.runId} dod=${args.criterion} state=${result.file}\n`)
      return 0
    } catch (error) {
      process.stderr.write(`wt-pilot-runner: ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }
  const options = parsePilotRunnerArgs(process.argv.slice(2))
  if (options.help) { process.stdout.write(`${usage()}\n`); return 0 }
  if (options.error) { process.stderr.write(`wt-pilot-runner: ${options.error}\n${usage()}\n`); return 2 }
  if (!existsSync(options.dir)) { process.stderr.write(`wt-pilot-runner: --dir is not a directory: ${options.dir}\n`); return 2 }
  recordSessionEnvLog(options.dir)
  if (!existsSync(options.contract)) { process.stderr.write(`wt-pilot-runner: --contract does not exist: ${options.contract}\n`); return 2 }
  if (!existsSync(options.cardFile)) { process.stderr.write(`wt-pilot-runner: --card-file does not exist: ${options.cardFile}\n`); return 2 }
  let admission
  try {
    const maxActive = resolveWorkflowToolboxOption('sdk_pilot_max_active').value
    admission = await pilotAdmission.awaitPilotAdmission({ worktree: options.dir, card: options.card, maxActive, log: (line) => process.stdout.write(`${line}\n`) })
    // Test-only manifest injection seals spawned CLI fixtures without changing real-user resolution order.
    const testManifest = process.env.NODE_ENV === 'test' ? process.env.WT_PILOT_TEST_SDK_MANIFEST : null
    const resolution = resolveAgentSdk({ projectDir: options.dir, writableRoots: [options.dir], ...(testManifest ? { ownToolkitManifest: testManifest } : {}) })
    const sdk = await import(pathToFileURL(resolution.entryPath).href)
    const result = await runPilot(options, { query: sdk.query, resolvePilotModels, loadedCodePaths: resolvedAgentSdkCodePaths(resolution), lifecycleOptions: { sdk, sdkRequire: resolution.require } })
    process.stdout.write(`fresh=${result.summary.fresh_tokens} turns=${result.summary.turns} report=${result.summary.report_exists} requested_model=${result.summary.requested_model} served_model=${result.summary.served_model ?? 'unknown'} served_model_first_turn=${result.summary.served_model_first_turn ?? 'unknown'} served_model_agreement=${result.summary.served_model_agreement}\n`)
    return result.exitCode ?? 0
  } catch (error) {
    process.stderr.write(`wt-pilot-runner: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  } finally {
    await pilotAdmission.finishPilotAdmission(admission)
  }
}

main().then((code) => {
  process.exitCode = code
  // Measured 2026-09-17 on the first real LITE run on a small card: after a refused initialization
  // receipt the summary and the archive were written, `main` resolved, and the process stayed alive in an epoll
  // wait with no child and no further output, so the launcher's EXIT marker never appeared. A draining process
  // exits before this timer fires; the timer is unreferenced so it never keeps one alive itself.
  setTimeout(() => process.exit(code), 2_000).unref()
})
