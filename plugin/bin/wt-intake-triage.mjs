#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { handleHelpFlag } from './lib/cli-help.mjs'
import { prepareTriage } from './lib/intake-triage-core.mjs'

const HELP = 'Usage: wt-intake-triage.mjs --cards <json file>\n'

function cardsPath(args) {
  const index = args.indexOf('--cards')
  if (index < 0 || !args[index + 1]) throw new Error('Usage: wt-intake-triage.mjs --cards <json file>')
  return args[index + 1]
}

// `--cards` takes a value and this CLI has no boolean option; the parser below ignores everything else.
handleHelpFlag(process.argv.slice(2), HELP, {
  valueFlags: ['--cards'],
  booleanFlags: [],
})

try {
  const input = JSON.parse(readFileSync(cardsPath(process.argv.slice(2)), 'utf8'))
  const cards = Array.isArray(input) ? input : input?.cards
  const { results, eligible } = prepareTriage(cards)
  const output = results.map(({ routeLine: _routeLine, ...card }) => card)
  process.stdout.write(`${JSON.stringify({ cards: output, eligible: eligible.map(({ card }) => card) }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
