#!/usr/bin/env node
// Writes the two release records that repository checks consume. Keep this small and
// deterministic: the skill is the policy interface; this CLI is the write mechanism.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SECTIONS = new Set(['Added', 'Changed', 'Fixed'])
const PRIVATE_ID = /\b18\d{17}\b/g

function fail(message) {
  process.stderr.write(`ERROR: ${message}\n`)
  process.exitCode = 1
}

function args(argv) {
  const result = { dryRun: false, paths: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--dry-run') result.dryRun = true
    else if (flag === '--summary' || flag === '--section' || flag === '--paths' || flag === '--version') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
      if (flag === '--paths') result.paths.push(...value.split(',').map((path) => path.trim()).filter(Boolean))
      else result[flag.slice(2)] = value
    } else throw new Error(`unknown argument: ${flag}`)
  }
  return result
}

function branch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function changedPaths() {
  try {
    return execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8' })
      .split('\n')
      .map((path) => path.trim())
      .filter(Boolean)
  } catch {
    throw new Error('could not read changed paths; pass --paths explicitly')
  }
}

function insertEntry(changelog, heading, section, entry) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headingMatch = new RegExp(
    heading === 'Unreleased'
      ? `^## \\[${escapedHeading}\\]$`
      : `^## \\[${escapedHeading}\\](?:\\s+-.*)?$`,
    'm',
  )
  const headingIndex = changelog.search(headingMatch)
  if (headingIndex === -1) throw new Error(`plugin/CHANGELOG.md has no ## [${heading}] heading`)
  const nextHeading = changelog.indexOf('\n## ', headingIndex + 1)
  const end = nextHeading === -1 ? changelog.length : nextHeading
  const block = changelog.slice(headingIndex, end)
  if (block.includes(`- ${entry}`)) return changelog
  const sectionMatch = new RegExp(`^### ${section}\\s*$`, 'm').exec(block)
  if (sectionMatch) {
    const after = headingIndex + sectionMatch.index + sectionMatch[0].length
    return `${changelog.slice(0, after)}\n- ${entry}${changelog.slice(after)}`
  }
  return `${changelog.slice(0, end).replace(/\n*$/, '\n\n')}### ${section}\n- ${entry}\n${changelog.slice(end)}`
}

function publishedPackages(paths) {
  const packages = new Map()
  for (const path of paths) {
    const match = /^toolkit\/packages\/([^/]+)\/src\//.exec(path)
    if (!match || packages.has(match[1])) continue
    const packageJson = join('toolkit', 'packages', match[1], 'package.json')
    if (!existsSync(packageJson)) continue
    const meta = JSON.parse(readFileSync(packageJson, 'utf8'))
    if (meta.publishConfig && meta.private !== true && typeof meta.name === 'string') packages.set(match[1], meta.name)
  }
  return [...packages.values()].sort()
}

function slug(summary) {
  return summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'release-record'
}

function changeset(name, summary) {
  return `---\n'${name}': patch\n---\n\n${summary}\n`
}

function main() {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    process.stdout.write(
      'Usage: wt-changelog-entry.mjs --summary <text> --section <Added|Changed|Fixed> [--paths <comma-separated paths>] [--version <x.y.z>] [--dry-run]\n',
    )
    return
  }
  let input
  try {
    input = args(process.argv.slice(2))
  } catch (error) {
    fail(error.message)
    return
  }
  if (!input.summary || !input.section) return fail('--summary and --section are required')
  if (!SECTIONS.has(input.section)) return fail('--section must be Added, Changed, or Fixed')
  if (input.version && branch() !== 'main') return fail('versions are bumped on main only; branches write ## [Unreleased] entries')

  const summary = input.summary.replace(PRIVATE_ID, '').replace(/\s{2,}/g, ' ').trim()
  if (!summary) return fail('summary is empty after stripping private tracker id(s)')
  const paths = input.paths.length > 0 ? input.paths : changedPaths()
  const heading = input.version || 'Unreleased'
  const changelogPath = 'plugin/CHANGELOG.md'
  if (!existsSync(changelogPath)) return fail(`${changelogPath} does not exist`)

  let changelog
  try {
    changelog = insertEntry(readFileSync(changelogPath, 'utf8'), heading, input.section, summary)
  } catch (error) {
    fail(error.message)
    return
  }

  const packageNames = publishedPackages(paths)
  const changesets = packageNames.map((name) => ({
    path: join('toolkit', '.changeset', `changelog-${slug(summary)}-${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.md`),
    body: changeset(name, summary),
  }))
  if (input.dryRun) {
    process.stdout.write(`DRY RUN: ${changelogPath}; ${changesets.length} changeset(s)\n`)
    return
  }
  writeFileSync(changelogPath, changelog)
  for (const item of changesets) {
    mkdirSync(join(item.path, '..'), { recursive: true })
    if (!existsSync(item.path)) writeFileSync(item.path, item.body)
  }
  if (summary !== input.summary) process.stdout.write('stripped private tracker id from changelog entry\n')
  process.stdout.write(`wrote ${changelogPath}; created ${changesets.length} changeset(s)\n`)
}

main()
