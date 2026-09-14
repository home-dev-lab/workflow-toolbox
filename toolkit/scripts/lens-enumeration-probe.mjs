import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const instructionSource = readFileSync(
  fileURLToPath(new URL('../examples/pr-review.workflow.ts', import.meta.url)),
  'utf8',
)
const match = /LOCK_ENUMERATION_INSTRUCTIONS = (\[[\s\S]*?\])\.join\('\\n'\)/.exec(instructionSource)
if (match === null) throw new Error('Could not read LOCK_ENUMERATION_INSTRUCTIONS from workflow source')
const LOCK_ENUMERATION_INSTRUCTIONS = JSON.parse(match[1]).join('\n')

const fixtures = new Map([
  ['open-family', 'open-family.diff'],
  ['closed-enum', 'closed-enum.diff'],
  ['invariant', 'invariant.diff'],
])
const fixture = fixtures.get(process.argv[2])

if (fixture === undefined) {
  throw new Error('Usage: lens-enumeration-probe.mjs <open-family|closed-enum|invariant>')
}

const fixtureUrl = new URL(`../packages/build/test/fixtures/lock-enumeration/${fixture}`, import.meta.url)
const diff = readFileSync(fileURLToPath(fixtureUrl), 'utf8')
process.stdout.write(`${LOCK_ENUMERATION_INSTRUCTIONS}\n\nFixture: ${fixture}\n\n${diff}`)
