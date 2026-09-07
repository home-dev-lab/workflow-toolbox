#!/usr/bin/env node
// Validate only a closing report's Findings disposition contract. This is a separate CLI so
// lesson harvesting retains its stable extraction-only exit-code contract.

import { readFileSync } from 'node:fs'
import { handleHelpFlag } from './lib/cli-help.mjs'

export const PROBATION_UNTIL = '2026-09-14'

const HELP = `wt-report-findings-check — validate a closing report's ## Findings dispositions.

Usage:
  node wt-report-findings-check.mjs <report.md>

Prints the Findings row count, rows without exactly one disposition, and the active warn/block
probation mode. Set WT_FINDINGS_DISPOSITION_MODE=block to block before ${PROBATION_UNTIL}.
`

function extractFindings(markdown) {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s+Findings\s*$/i.test(line))
  if (start === -1) return { found: false, body: '' }
  const end = lines.findIndex((line, index) => index > start && /^##\s+\S/.test(line))
  return { found: true, body: lines.slice(start + 1, end === -1 ? lines.length : end).join('\n').trim() }
}

function findingsRows(body) {
  if (/^none\.$/i.test(body.trim())) return { rows: [], valid: true }
  const lines = body.split(/\r?\n/)
  const separator = lines.findIndex((line, index) => index > 0 && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line))
  if (separator === -1) return { rows: [], valid: false }
  const rows = []
  for (let index = separator + 1; index < lines.length; index++) {
    if (!/^\s*\|/.test(lines[index])) break
    rows.push(lines[index])
  }
  return { rows, valid: rows.length > 0 }
}

function hasOneDisposition(row) {
  const matches = row.match(/fixed with red lock \S+|out-of-scope card \d{6,}|rejected with evidence \S+/g) ?? []
  return matches.length === 1
}

export function resolveMode(env = process.env) {
  if (env.WT_FINDINGS_DISPOSITION_MODE === 'block') return 'block'
  const now = env.WT_FINDINGS_DISPOSITION_NOW ?? new Date().toISOString().slice(0, 10)
  return now >= PROBATION_UNTIL ? 'block' : 'warn'
}

export function checkFindings(markdown, env = process.env) {
  const section = extractFindings(markdown)
  const mode = resolveMode(env)
  if (!section.found) return { rows: 0, withoutDisposition: 1, mode }
  const table = findingsRows(section.body)
  if (!table.valid) return { rows: 0, withoutDisposition: 1, mode }
  return {
    rows: table.rows.length,
    withoutDisposition: table.rows.filter((row) => !hasOneDisposition(row)).length,
    mode,
  }
}

function main() {
  handleHelpFlag(process.argv.slice(2), HELP)
  const [reportPath] = process.argv.slice(2)
  if (!reportPath) {
    process.stderr.write('usage: wt-report-findings-check.mjs <report.md>\n')
    process.exit(2)
  }
  let markdown
  try {
    markdown = readFileSync(reportPath, 'utf8')
  } catch (error) {
    process.stderr.write(`could not read ${reportPath}: ${error.message}\n`)
    process.exit(2)
  }
  const result = checkFindings(markdown)
  process.stdout.write(
    `findings: ${result.rows} rows, ${result.withoutDisposition} without disposition (mode=${result.mode}, probation until ${PROBATION_UNTIL})\n`,
  )
  process.exit(result.mode === 'block' && result.withoutDisposition > 0 ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
