#!/usr/bin/env node
import { createBoardClient, resolveBoardPointer } from './lib/board-http-client.mjs'
import { readFileSync } from 'node:fs'
import { parseOrchestratorArgs, runOrchestrator } from './lib/orchestrator-runner-core.mjs'
import { loadProfileEnv, runPilot } from './lib/pilot-runner-core.mjs'
import { resolvePilotModels } from './lib/pilot-model-config.mjs'
import { randomUUID } from 'node:crypto'
import { resolveAgentSdk, resolvedAgentSdkCodePaths } from './lib/sdk-resolution.mjs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

async function main() {
  const options = parseOrchestratorArgs(process.argv.slice(2))
  if (options.help) { process.stdout.write('wt-run-orchestrator --cards <ids> | --mission-list <name> --worktrees-dir <dir> --report <path> [--board-contract <json file>] [--knowledge-base-index <path>] [--plugin-dir <absolute-path>]...\n'); return 0 }
  if (options.error) { process.stderr.write(`${options.error}\n`); return 2 }
  try {
    const resolution = resolveAgentSdk({ projectDir: process.cwd(), writableRoots: [process.cwd()] })
    const sdk = await import(pathToFileURL(resolution.entryPath).href)
    const loadedCodePaths = resolvedAgentSdkCodePaths(resolution)
    const profileEnv = loadProfileEnv(options.profileEnv)
    const models = resolvePilotModels({ env: process.env, settingsEnv: profileEnv })
    options.waveId = randomUUID().slice(0, 8)
    process.stdout.write(`wave=${options.waveId} report=${path.resolve(options.report)}\n`)
    const contract = readFileSync(new URL('../autonomy/ORCHESTRATOR-CONTRACT.md', import.meta.url), 'utf8')
    const lifecycleOptions = { sdk, sdkRequire: resolution.require }
    const result = await runOrchestrator(options, { board: createBoardClient({ url: options.boardUrl, boardId: options.boardId ?? resolveBoardPointer(process.cwd())?.boardId ?? null }), runPilot, pilotDependencies: { query: sdk.query, resolvePilotModels, loadedCodePaths, lifecycleOptions }, query: sdk.query, sdk, sdkRequire: resolution.require, loadedCodePaths, models, contract, env: { ...process.env, ...profileEnv } })
    return result.exitCode
  } catch (error) {
    process.stderr.write(`wt-run-orchestrator: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

main().then((code) => { process.exitCode = code })
