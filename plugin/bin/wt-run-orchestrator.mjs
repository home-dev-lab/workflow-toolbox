#!/usr/bin/env node
import { createBoardClient } from './lib/board-http-client.mjs'
import { parseOrchestratorArgs, runOrchestrator } from './lib/orchestrator-runner-core.mjs'
import { loadProfileEnv, runPilot } from './lib/pilot-runner-core.mjs'
import { createRequire } from 'node:module'
import { resolvePilotModels } from './lib/pilot-model-config.mjs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const options = parseOrchestratorArgs(process.argv.slice(2))
if (options.help) process.stdout.write('wt-run-orchestrator --cards <ids> | --mission-list <name> --worktrees-dir <dir> --report <path>\n')
else if (options.error) { process.stderr.write(`${options.error}\n`); process.exitCode = 2 }
else {
  options.waveId = randomUUID().slice(0, 8)
  process.stdout.write(`wave=${options.waveId} report=${path.resolve(options.report)}\n`)
  const require = createRequire(new URL('../../toolkit/package.json', import.meta.url))
  const { query } = require('@anthropic-ai/claude-agent-sdk')
  const profileEnv = loadProfileEnv(options.profileEnv)
  const models = resolvePilotModels({ env: process.env, settingsEnv: profileEnv })
  const contract = readFileSync(new URL('../autonomy/ORCHESTRATOR-CONTRACT.md', import.meta.url), 'utf8')
  const result = await runOrchestrator(options, { board: createBoardClient({ url: options.boardUrl }), runPilot, pilotDependencies: { query, resolvePilotModels }, query, models, contract, env: { ...process.env, ...profileEnv } })
  process.exitCode = result.exitCode
}
