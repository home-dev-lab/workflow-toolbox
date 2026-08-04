#!/usr/bin/env node

import path from 'node:path'
import { analyzeLaneConsent } from './lib/lane-consent-check-core.mjs'

function parseArgs(argv) {
  let projectDir = process.cwd()
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project' && typeof argv[i + 1] === 'string') {
      projectDir = path.resolve(argv[i + 1])
      i += 1
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
