#!/usr/bin/env node
// Mechanize the harvest of a closure report's own "## Lessons for the memory" section — the
// section a pilot or executor already writes at the end of its dev-loop arc.
//
// This tool does DETECTION + EXTRACTION only. It never writes to a knowledge base
// (single-writer constraint: only the session integrating the card writes memory) and it
// never invents wording, a fiche type, or an index line — it hands the caller a manifest of
// candidate items, verbatim from the report, for a human/session to turn into real fiches
// with its own judgment (naming, type classification, dedup against the existing index).
//
// Usage:
//   node harvest-lessons.mjs <report.md> [--json] [--heading "Lessons for the memory"]
//
// Exit codes:
//   0 — section found (whether or not it carries lessons)
//   1 — the report file could not be read
//   2 — the report has NO section with the given heading at all (distinct from an explicit
//       "None." — a report missing the section entirely is malformed and needs a human to
//       read it directly, not a silent skip)

import { readFileSync } from 'node:fs'

const HEADING_DEFAULT = 'Lessons for the memory'

/**
 * Extract the body of a markdown "## <heading>" section: everything after the heading line,
 * up to (but not including) the next "## " heading, or end of file. Sub-headings ("### ...")
 * do NOT close the section — only a sibling or higher H2 does.
 */
export function extractSection(markdown, heading) {
  const lines = markdown.split(/\r?\n/)
  const headingRe = new RegExp('^##\\s+' + escapeRegExp(heading) + '\\s*$', 'i')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) { start = i; break }
  }
  if (start === -1) return { found: false, body: '' }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i])) { end = i; break }
  }
  const body = lines.slice(start + 1, end).join('\n').trim()
  return { found: true, body }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Split a section body into its top-level list items. A top-level item starts a line with
 * "- " or "N. " at column 0; any subsequent line that is indented (or blank, followed by more
 * indented text) is a continuation of that same item. This is deliberately narrow — the pilot
 * report template always emits a flat top-level list here, never nested lists.
 */
export function splitItems(body) {
  if (!body) return []
  const lines = body.split(/\r?\n/)
  const itemStartRe = /^(?:-|\d+\.)\s+(.*)$/
  const items = []
  let current = null
  for (const line of lines) {
    const m = itemStartRe.exec(line)
    if (m) {
      if (current !== null) items.push(current.trim())
      current = m[1]
    } else if (current !== null) {
      if (line.trim() === '') continue
      current += '\n' + line.trim()
    }
  }
  if (current !== null) items.push(current.trim())
  return items
}

/**
 * A section body is "no lessons" only when it explicitly says so — the pilot report contract
 * requires an empty section to say "None." explicitly (never leave it blank), so that is the
 * one string this treats as the no-lessons case. Anything else, including a blank body that
 * DIDN'T say "None.", is reported as having content — a malformed-but-present section is worth
 * a human's eyes, not a silent skip.
 */
export function isExplicitNone(body) {
  return /^none\.?$/i.test(body.trim())
}

export function harvest(markdown, heading = HEADING_DEFAULT) {
  const { found, body } = extractSection(markdown, heading)
  if (!found) return { sectionFound: false, hasLessons: false, items: [] }
  if (isExplicitNone(body)) return { sectionFound: true, hasLessons: false, items: [] }
  const items = splitItems(body)
  // A section that is neither an explicit "None." nor a parseable list (free prose, or an
  // empty body that forgot to say "None.") still counts as "has content" — items may be empty
  // while hasLessons stays true, which is the caller's cue to go read the raw section itself.
  return { sectionFound: true, hasLessons: true, items }
}

function main() {
  const args = process.argv.slice(2)
  const jsonMode = args.includes('--json')
  const headingIdx = args.indexOf('--heading')
  const heading = headingIdx !== -1 ? args[headingIdx + 1] : HEADING_DEFAULT
  const reportPath = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--heading')
  if (!reportPath) {
    process.stderr.write('usage: harvest-lessons.mjs <report.md> [--json] [--heading "..."]\n')
    process.exit(1)
  }
  let markdown
  try {
    markdown = readFileSync(reportPath, 'utf8')
  } catch (err) {
    process.stderr.write(`could not read ${reportPath}: ${err.message}\n`)
    process.exit(1)
  }
  const result = harvest(markdown, heading)
  if (jsonMode) {
    process.stdout.write(JSON.stringify(result) + '\n')
  } else if (!result.sectionFound) {
    process.stdout.write(
      `NO "## ${heading}" SECTION in ${reportPath} — malformed report, read it directly.\n`,
    )
  } else if (!result.hasLessons) {
    process.stdout.write(`No reusable lesson in ${reportPath} (section says "None.").\n`)
  } else {
    process.stdout.write(
      `${result.items.length} candidate${result.items.length === 1 ? '' : 's'} in ${reportPath}:\n\n`,
    )
    result.items.forEach((item, i) => {
      process.stdout.write(`${i + 1}. ${item}\n\n`)
    })
  }
  process.exit(result.sectionFound ? 0 : 2)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
