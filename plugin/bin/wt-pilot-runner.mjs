#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parsePilotRunnerArgs, runPilot } from './lib/pilot-runner-core.mjs'
import { resolvePilotModels } from './lib/pilot-model-config.mjs'
import { resolveAgentSdkRequire } from './lib/sdk-resolution.mjs'
import { recordSessionEnvLog } from './lib/session-env-log.mjs'
import { pilotAdmission } from './lib/pilot-admission.mjs'
import { resolveWorkflowToolboxOption } from './lib/plugin-options.mjs'

function usage() {
  return 'Usage: node wt-pilot-runner.mjs --card <id> --dir <worktree> --card-file <path> [--board-contract <json file>] [--knowledge-base-index <path>] [--archive-root <project root>] [--plugin-dir <absolute-path>]... [--profile-env <settings.json>] [--contract <path>] [--hard] [--mailbox <path>] [--timeout <seconds>]'
}

async function main() {
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
    const require = resolveAgentSdkRequire({ projectDir: options.dir, ...(testManifest ? { ownToolkitManifest: testManifest } : {}) })
    const sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href)
    const result = await runPilot(options, { query: sdk.query, resolvePilotModels, lifecycleOptions: { sdk, sdkRequire: require } })
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
