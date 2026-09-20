#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleHelpFlag } from './lib/cli-help.mjs'
import { describeWorkflowToolboxOptions, findOrphanedPluginConfigs } from './lib/plugin-options.mjs'

const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const HELP = `wt-config - show effective Workflow Toolbox configuration

Usage:
  wt-config [--json]
  wt-config --help`

function jsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function display(value) {
  if (value === null) return '(unset)'
  if (value === '') return '(empty)'
  return String(value)
}

function table(rows) {
  const headers = ['option', 'effective', 'source', 'default']
  const values = rows.map((row) => [row.option, display(row.effective), row.source, display(row.defaultValue)])
  const widths = headers.map((header, index) => Math.max(header.length, ...values.map((row) => row[index].length)))
  const render = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join(' | ').trimEnd()
  return [render(headers), widths.map((width) => '-'.repeat(width)).join('-|-'), ...values.map(render)].join('\n')
}

try {
  const args = process.argv.slice(2)
  handleHelpFlag(args, HELP)
  if (args.some((arg) => arg !== '--json') || args.filter((arg) => arg === '--json').length > 1) {
    throw new Error(`unknown argument: ${args.find((arg) => arg !== '--json') ?? '--json'}\n\n${HELP}`)
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude')
  const manifest = jsonFile(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))
  const settings = jsonFile(path.join(configDir, 'settings.json'))
  const installed = jsonFile(path.join(configDir, 'plugins', 'installed_plugins.json'))
  const rows = describeWorkflowToolboxOptions({ env: process.env, projectDir: process.cwd(), manifest })
  const orphanedPluginConfigs = findOrphanedPluginConfigs({ settings, installed, manifest })
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ options: rows, orphanedPluginConfigs }, null, 2)}\n`)
  } else {
    process.stdout.write(`${table(rows)}\n\nOrphaned pluginConfigs\n`)
    if (orphanedPluginConfigs.length === 0) process.stdout.write('none\n')
    for (const orphan of orphanedPluginConfigs) {
      process.stdout.write(`${orphan.key}\n`)
      for (const move of orphan.moves) process.stdout.write(`  ${move.option} -> ${move.target}\n`)
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
