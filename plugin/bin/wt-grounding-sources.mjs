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
handleHelpFlag(args, HELP, {
  valueFlags: [],
  booleanFlags: ['--dry-run', '--json'],
})
// Refuse what is not part of the grammar. `--help` is only help in flag position, so a typo'd
// token followed by --help (`init --typo --help`) now reaches the command: ignoring the typo would
// run `init` and write the registry the caller meant to ask about.
const KNOWN_OPTIONS = new Set(['--dry-run', '--json'])
const unknownToken = args.slice(1).find((token) => !KNOWN_OPTIONS.has(token))
if (unknownToken !== undefined) {
  console.error(`wt-grounding-sources: unknown argument: ${unknownToken.replace(/[\r\n]+/g, ' ').slice(0, 80)}`)
  process.exit(2)
}
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
