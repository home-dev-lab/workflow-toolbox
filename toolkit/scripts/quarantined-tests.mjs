import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawningTestFiles } from './spawning-test-files.mjs'

const ROOT = resolve(import.meta.dirname, '..')

export const quarantinedTests = [
  {
    file: 'scripts/test/wt-wake-channel.test.ts',
    name: 'canonicalises an aliased spool before watching and delivers post-init through the configured alias',
    cardId: '1863398344542389302',
    waitingOn: 'reliable fs.watch directory delivery on slow Linux hosts',
  },
  {
    file: 'packages/build/test/wt-lane-launcher.test.ts',
    name: 'journals a stalled episode again after it clears and recurs for the same runId',
    cardId: '1863398344542389302',
    waitingOn: 'detached lane stall detection under slow host process and timer scheduling',
  },
]

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function quarantineTestPattern(entries = quarantinedTests) {
  return new RegExp(`(?:${entries.map(({ name }) => escapeRegex(name)).join('|')})$`)
}

export function blockingTestPattern(entries = quarantinedTests) {
  return new RegExp(`^(?!.*(?:${entries.map(({ name }) => escapeRegex(name)).join('|')})$).+$`)
}

export function validateQuarantinedTests(entries = quarantinedTests, root = ROOT) {
  const identities = new Set()
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.cardId)) throw new Error(`quarantine entry must carry a numeric card id: ${entry.file} > ${entry.name}`)
    if (!entry.waitingOn?.trim()) throw new Error(`quarantine entry must say what it is waiting on: ${entry.file} > ${entry.name}`)
    const identity = `${entry.file}\0${entry.name}`
    if (identities.has(identity)) throw new Error(`duplicate quarantine entry: ${entry.file} > ${entry.name}`)
    identities.add(identity)
    if (!spawningTestFiles.includes(entry.file)) throw new Error(`quarantined test is not in the process-spawning project: ${entry.file}`)
    const source = readFileSync(resolve(root, entry.file), 'utf8')
    if (!source.includes(entry.name)) throw new Error(`quarantined test not found: ${entry.file} > ${entry.name}`)
  }
}
