#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'
import { describeWorkflowToolboxOptions, findOrphanedPluginConfigs } from './lib/plugin-options.mjs'

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function jsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function main() {
  let input
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return
  }
  if (!input || typeof input !== 'object' || typeof input.agent_id === 'string' && input.agent_id) return
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude')
  const manifest = jsonFile(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))
  const settings = jsonFile(path.join(configDir, 'settings.json'))
  const installed = jsonFile(path.join(configDir, 'plugins', 'installed_plugins.json'))
  const rows = describeWorkflowToolboxOptions({ env: process.env, projectDir: input.cwd || process.cwd(), manifest })
  const changed = rows.filter((row) => row.source !== 'default')
  const orphans = findOrphanedPluginConfigs({ settings, installed, manifest })
  if (changed.length === 0 && orphans.length === 0) return
  const lines = []
  if (changed.length > 0) {
    const changedOptions = changed.map((row) => `${row.option}=${String(row.effective)} (${row.source})`).join(', ')
    lines.push(`workflow-toolbox config: ${changedOptions} - full table: node ${JSON.stringify(path.join(PLUGIN_ROOT, 'bin', 'wt-config.mjs'))}`)
  }
  for (const orphan of orphans) {
    const targets = orphan.moves.map((move) => `${move.option} -> ${move.target}`).join(', ') || 'no options'
    lines.push(`orphaned pluginConfigs ${orphan.key}: ${targets}; reported only, not auto-migrated`)
  }
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } })}\n`)
}

runFailOpenHook('wt-config-context-hook.mjs', main)
process.exit(0)
