#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { laneTextFromOutput } from './wt-verifier-cli-guard-hook.mjs'

function usage() {
  return [
    'wt-opencode-json-extractor',
    '',
    'Usage: wt-opencode-json-extractor <stream-file>',
    'Reads an opencode --format json stream file and prints only the model answer.',
  ].join('\n')
}

function run() {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(usage())
    return
  }
  if (args.length !== 1 || args[0] === undefined || args[0].startsWith('-')) {
    process.stderr.write(`Unknown usage for ${path.basename(process.argv[1] ?? 'wt-opencode-json-extractor.mjs')}\n`)
    process.stderr.write(`${usage()}\n`)
    process.exit(1)
  }
  const file = args[0]
  const text = fs.readFileSync(file, 'utf8')
  process.stdout.write(laneTextFromOutput(text) ?? text)
}

try {
  run()
} catch {
  process.exit(1)
}
