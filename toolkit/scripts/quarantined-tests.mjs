import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawningTestFiles } from './spawning-test-files.mjs'

const ROOT = resolve(import.meta.dirname, '..')

export const quarantinedTests = [
]

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// An alternation of zero names is the empty pattern, which matches every name: an empty list must
// quarantine nothing and block everything, never the reverse.
const MATCHES_NOTHING = '(?!)'

function namesAlternation(entries) {
  return entries.length ? entries.map(({ name }) => escapeRegex(name)).join('|') : MATCHES_NOTHING
}

export function quarantineTestPattern(entries = quarantinedTests) {
  return new RegExp(`(?:${namesAlternation(entries)})$`)
}

export function blockingTestPattern(entries = quarantinedTests) {
  // [\s\S], never `.`: Vitest matches the full task name, and a name may contain a newline.
  return new RegExp(`^(?![\\s\\S]*(?:${namesAlternation(entries)})$)[\\s\\S]+$`)
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
