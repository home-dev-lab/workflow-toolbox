#!/usr/bin/env node

import path from 'node:path'
import { analyzeLaneConsent } from './lib/lane-consent-check-core.mjs'
import { handleHelpFlag } from './lib/cli-help.mjs'

const HELP = `wt-lane-consent-check — report whether this project has explicitly opted in to
routing work to an external executor lane (opencode/codex), by reading the project's consent
switch. Availability of a lane on the machine is never consent — this reports what was declared.

Usage:
  node wt-lane-consent-check.mjs [--project <dir>]
    --project <dir>  project to check (default: cwd)
`

function parseArgs(argv) {
  handleHelpFlag(argv, HELP)
  let projectDir = process.cwd()
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project' && typeof argv[i + 1] === 'string') {
      projectDir = path.resolve(argv[i + 1])
      i += 1
      continue
    }
    if (argv[i].startsWith('--')) {
      process.stderr.write(`wt-lane-consent-check: unknown flag '${argv[i]}'\n`)
      process.exit(2)
    }
  }
  return { projectDir }
}

function main() {
  const { projectDir } = parseArgs(process.argv.slice(2))
  const result = analyzeLaneConsent(projectDir, process.env)
  if (result.message) process.stdout.write(`${result.message}\n`)
  process.exitCode = result.exitCode
}

main()
