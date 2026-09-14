#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolvePilotModels } from './lib/pilot-model-config.mjs'

function usage() {
  return [
    'wt-pilot-models — resolve spawn-time pilot and orchestrator models',
    '',
    'Usage:',
    '  wt-pilot-models    print pilot, pilotHard, and orchestrator resolutions',
    '  wt-pilot-models --help',
  ].join('\n')
}

function settingsEnv() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const settingsPath = path.join(configDir, 'settings.json')
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    return settings && typeof settings === 'object' && !Array.isArray(settings)
      && settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
      ? settings.env
      : {}
  } catch {
    return {}
  }
}

try {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    if (args.length !== 1) throw new Error('unknown argument')
    process.stdout.write(`${usage()}\n`)
    process.exit(0)
  }
  if (args.length > 0) throw new Error(`unknown argument: ${args[0]}\n\n${usage()}`)
  const models = resolvePilotModels({ env: process.env, settingsEnv: settingsEnv() })
  for (const role of ['pilot', 'pilotHard', 'orchestrator']) {
    const { value, source, effective, remappedBy } = models[role]
    process.stdout.write(`${role}=${value} (source=${source}${effective !== value ? `, effective=${effective} via ${remappedBy}` : ''})\n`)
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
