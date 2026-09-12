#!/usr/bin/env node
import { createBoardClient } from './lib/board-http-client.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The board id comes from --board-id or from the nearest `.claude/planka.json` walking up from cwd
// (the suite root holds it; a repository checkout inside the suite does not).
function resolveBoardId(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    const file = join(dir, '.claude', 'planka.json')
    if (existsSync(file)) { try { return JSON.parse(readFileSync(file, 'utf8')).boardId ?? null } catch { return null } }
    if (dirname(dir) === dir) return null
  }
}
import { parseOrchestratorArgs, runOrchestrator } from './lib/orchestrator-runner-core.mjs'
import { loadProfileEnv, runPilot } from './lib/pilot-runner-core.mjs'
import { createRequire } from 'node:module'
import { resolvePilotModels } from './lib/pilot-model-config.mjs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

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
  const result = await runOrchestrator(options, { board: createBoardClient({ url: options.boardUrl, boardId: options.boardId ?? resolveBoardId(process.cwd()) }), runPilot, pilotDependencies: { query, resolvePilotModels }, query, models, contract, env: { ...process.env, ...profileEnv } })
  process.exitCode = result.exitCode
}
