#!/usr/bin/env node
import { detectedMcpServerNames, groundingConfigDir, initUserRegistry, loadGroundingRegistryReport } from './lib/grounding-sources.mjs'
import { handleHelpFlag } from './lib/cli-help.mjs'

const args = process.argv.slice(2)
const HELP = `wt-grounding-sources — inspect or initialize the deep-grounding source registry.

Usage:
  wt-grounding-sources.mjs list [--json]
  wt-grounding-sources.mjs init [--dry-run] [--json]

list prints the merged plugin → user → project registry and missing dependencies.
init creates the user registry from detected MCP servers and command-line tools; it never overwrites.
`
handleHelpFlag(args, HELP)
const command = args[0]
const dryRun = args.includes('--dry-run')
const asJson = args.includes('--json')
const configDir = groundingConfigDir()

if (command === 'list') {
  const { entries, warnings } = loadGroundingRegistryReport({ installedMcpNames: detectedMcpServerNames(configDir, { cwd: process.cwd() }) })
  if (asJson) console.log(JSON.stringify(entries, null, 2))
  else {
    for (const warning of warnings) console.error(`warning: ${warning}`)
    for (const entry of entries) console.log(`${entry.family}\tlayer=${entry.layer}\t${entry.missing ? 'missing' : 'available'}\t${entry.layer === 'project' ? '[untrusted project recipe] ' : ''}${entry.query}`)
  }
} else if (command === 'init') {
  const result = initUserRegistry({ dryRun, configDir })
  if (asJson) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`${result.reason}: ${result.target}`)
    if (dryRun) console.log(JSON.stringify(result.entries, null, 2))
  }
  if (result.reason === 'exists') process.exitCode = 1
} else {
  console.error('usage: wt-grounding-sources.mjs <list|init> [--dry-run] [--json]')
  process.exitCode = 2
}
