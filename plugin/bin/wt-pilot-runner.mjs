#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { parsePilotRunnerArgs, runPilot } from './lib/pilot-runner-core.mjs'
import { resolvePilotModels } from './lib/pilot-model-config.mjs'
import { resolveAgentSdkRequire } from './lib/sdk-resolution.mjs'
import { recordSessionEnvLog } from './lib/session-env-log.mjs'

function usage() {
  return 'Usage: node wt-pilot-runner.mjs --card <id> --dir <worktree> --card-file <path> [--knowledge-base-index <path>] [--archive-root <project root>] [--plugin-dir <absolute-path>]... [--profile-env <settings.json>] [--contract <path>] [--hard] [--mailbox <path>] [--timeout 5400]'
}

async function main() {
  const options = parsePilotRunnerArgs(process.argv.slice(2))
  if (options.help) { process.stdout.write(`${usage()}\n`); return 0 }
  if (options.error) { process.stderr.write(`wt-pilot-runner: ${options.error}\n${usage()}\n`); return 2 }
  if (!existsSync(options.dir)) { process.stderr.write(`wt-pilot-runner: --dir is not a directory: ${options.dir}\n`); return 2 }
  recordSessionEnvLog(options.dir)
  if (!existsSync(options.contract)) { process.stderr.write(`wt-pilot-runner: --contract does not exist: ${options.contract}\n`); return 2 }
  if (!existsSync(options.cardFile)) { process.stderr.write(`wt-pilot-runner: --card-file does not exist: ${options.cardFile}\n`); return 2 }
  try {
    const require = resolveAgentSdkRequire({ projectDir: options.dir })
    const sdk = await import(require.resolve('@anthropic-ai/claude-agent-sdk'))
    const result = await runPilot(options, { query: sdk.query, resolvePilotModels, lifecycleOptions: { sdk, sdkRequire: require } })
    process.stdout.write(`fresh=${result.summary.fresh_tokens} turns=${result.summary.turns} report=${result.summary.report_exists} requested_model=${result.summary.requested_model} served_model=${result.summary.served_model ?? 'unknown'} served_model_first_turn=${result.summary.served_model_first_turn ?? 'unknown'} served_model_agreement=${result.summary.served_model_agreement}\n`)
    return result.exitCode ?? 0
  } catch (error) {
    process.stderr.write(`wt-pilot-runner: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

main().then((code) => { process.exitCode = code })
