#!/usr/bin/env node
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePilotRunnerArgs, runPilot } from './lib/pilot-runner-core.mjs'
import { resolvePilotModels } from './lib/pilot-model-config.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(join(ROOT, 'toolkit/package.json'))

function usage() {
  return 'Usage: node wt-pilot-runner.mjs --card <id> --dir <worktree> [--card-file <path>] [--profile-env <settings.json>] [--contract <path>] [--hard] [--mailbox <path>] [--room <atrium room>] [--timeout 5400] [--lane-silence 12]'
}

async function main() {
  const options = parsePilotRunnerArgs(process.argv.slice(2))
  if (options.help) { process.stdout.write(`${usage()}\n`); return 0 }
  if (options.error) { process.stderr.write(`wt-pilot-runner: ${options.error}\n${usage()}\n`); return 2 }
  if (!existsSync(options.dir)) { process.stderr.write(`wt-pilot-runner: --dir is not a directory: ${options.dir}\n`); return 2 }
  if (!existsSync(options.contract)) { process.stderr.write(`wt-pilot-runner: --contract does not exist: ${options.contract}\n`); return 2 }
  if (options.cardFile && !existsSync(options.cardFile)) { process.stderr.write(`wt-pilot-runner: --card-file does not exist: ${options.cardFile}\n`); return 2 }
  try {
    const sdk = await import(require.resolve('@anthropic-ai/claude-agent-sdk'))
    const result = await runPilot(options, { query: sdk.query, resolvePilotModels })
    process.stdout.write(`fresh=${result.summary.fresh_tokens} turns=${result.summary.turns} report=${result.summary.report_exists}\n`)
    return result.exitCode ?? 0
  } catch (error) {
    process.stderr.write(`wt-pilot-runner: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

main().then((code) => { process.exitCode = code })
