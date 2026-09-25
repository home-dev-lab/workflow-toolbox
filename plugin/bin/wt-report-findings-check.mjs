#!/usr/bin/env node
// Validate a closing report's Findings dispositions and required report shape. This remains a
// separate CLI so lesson harvesting retains its stable extraction-only exit-code contract.

import { readFileSync } from 'node:fs'
import { handleHelpFlag } from './lib/cli-help.mjs'
import { isInvokedDirectly } from './lib/host/entry-guard.mjs'

export const PROBATION_UNTIL = '2026-09-14'

const HELP = `wt-report-findings-check — validate a closing report's Findings dispositions and shape.

Usage:
  node wt-report-findings-check.mjs [--no-shape] <report.md>

Checks ## Implemented, ## Verification, ## Independent Review, ## Decisions, and ## Remaining
Risks unless --no-shape is supplied for a non-closing report. Prints Findings disposition and
shape failures in the same warn/block probation mode. Verification should name the e2e output or
state "e2e not run" with a reason; omission is always warning-only. Set
WT_FINDINGS_DISPOSITION_MODE=block to block before ${PROBATION_UNTIL}.
`

const REQUIRED_SECTIONS = ['Implemented', 'Verification', 'Independent Review', 'Decisions', 'Remaining Risks']

function extractSection(markdown, name) {
  const lines = markdown.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${name}\\s*$`, 'i').test(line))
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
  const section = extractSection(markdown, 'Findings')
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

export function checkReportShape(markdown) {
  return REQUIRED_SECTIONS.filter((name) => {
    const section = extractSection(markdown, name)
    return !section.found || !section.body
  })
}

export function checkE2eVerification(markdown) {
  const section = extractSection(markdown, 'Verification')
  if (!section.found) return 'missing'
  if (/\be2e\s+not\s+run\b(?:[ \t]*(?::|-)\s*\S[^\n]*|[ \t]+(?:because|due to)\s+\S[^\n]*)/i.test(section.body)) {
    return 'not-run-with-reason'
  }
  if (/\be2e(?:\s+verification)?\s+output\b/i.test(section.body)) return 'output-recorded'
  return 'missing'
}

function main() {
  const args = process.argv.slice(2)
  handleHelpFlag(args, HELP)
  const skipShape = args.includes('--no-shape')
  const [reportPath] = args.filter((arg) => arg !== '--no-shape')
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
  const missingSections = skipShape ? [] : checkReportShape(markdown)
  const e2eVerification = skipShape ? 'skipped' : checkE2eVerification(markdown)
  process.stdout.write(
    `findings: ${result.rows} rows, ${result.withoutDisposition} without disposition (mode=${result.mode}, probation until ${PROBATION_UNTIL})\n`,
  )
  if (skipShape) {
    process.stdout.write('closing report shape: skipped (--no-shape)\n')
  } else if (missingSections.length > 0) {
    for (const name of missingSections) {
      process.stdout.write(`closing report section: ${name} is missing or empty\n`)
    }
    process.stdout.write(`closing report shape: ${missingSections.length} required section${missingSections.length === 1 ? '' : 's'} missing or empty\n`)
  }
  if (e2eVerification === 'output-recorded') {
    process.stdout.write('e2e verification: output recorded\n')
  } else if (e2eVerification === 'not-run-with-reason') {
    process.stdout.write('e2e verification: not run with reason\n')
  } else if (e2eVerification === 'missing') {
    process.stdout.write('e2e verification warning: name the e2e output or state "e2e not run" with a reason (non-blocking)\n')
  }
  process.exit(result.mode === 'block' && (result.withoutDisposition > 0 || missingSections.length > 0) ? 1 : 0)
}

if (isInvokedDirectly(import.meta.url)) main()
