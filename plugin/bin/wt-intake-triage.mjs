#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { prepareTriage } from './lib/intake-triage-core.mjs'

function cardsPath(args) {
  const index = args.indexOf('--cards')
  if (index < 0 || !args[index + 1]) throw new Error('Usage: wt-intake-triage.mjs --cards <json file>')
  return args[index + 1]
}

try {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    process.stdout.write('Usage: wt-intake-triage.mjs --cards <json file>\n')
  } else {
    const input = JSON.parse(readFileSync(cardsPath(process.argv.slice(2)), 'utf8'))
    const cards = Array.isArray(input) ? input : input?.cards
    const { results, eligible } = prepareTriage(cards)
    const output = results.map(({ routeLine, ...card }) => card)
    process.stdout.write(`${JSON.stringify({ cards: output, eligible: eligible.map(({ card }) => card) }, null, 2)}\n`)
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
