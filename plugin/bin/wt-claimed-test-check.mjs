#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const HELP = `Usage: node plugin/bin/wt-claimed-test-check.mjs [--root <repo-root>]

Scans the plugin's normative documentation for claims that a test exists and
warns when no plausibly relevant test file under toolkit/ mentions its subject.
Findings never make this command fail.
`

function usage(message) {
  if (message) process.stderr.write(`${message}\n`)
  process.stderr.write(HELP)
  process.exit(2)
}

function parseArgs(argv) {
  let root = REPO_ROOT
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP)
      process.exit(0)
    }
    if (arg !== '--root') usage(`unknown argument: ${arg}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) usage('--root requires a directory')
    root = resolve(value)
    index += 1
  }
  return root
}

function markdownFiles(root) {
  const files = []
  const addDirectory = (dir) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const file = join(dir, name)
      if (name.endsWith('.md') && statSync(file).isFile()) files.push(file)
    }
  }
  addDirectory(join(root, 'plugin/rules'))
  addDirectory(join(root, 'plugin/autonomy'))
  addDirectory(join(root, 'plugin/agent-templates'))
  const readme = join(root, 'README.md')
  if (existsSync(readme)) files.push(readme)
  addDirectory(join(root, 'docs/public'))
  return files.sort()
}

function walk(dir, files = []) {
  if (!existsSync(dir)) return files
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) walk(file, files)
    else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) files.push(file)
  }
  return files
}

function nearestSubject(line, claimStart, claimEnd) {
  const subjects = []
  for (const match of line.matchAll(/`([^`\n]+)`/g)) {
    const subject = (match[1] ?? '').trim()
    if (subject) subjects.push({ subject, index: match.index ?? 0 })
  }
  for (const match of line.matchAll(/\b[\w.-]+\.test\.[cm]?[jt]sx?\b/g)) {
    subjects.push({ subject: match[0] ?? '', index: match.index ?? 0 })
  }
  subjects.sort((a, b) => {
    const distance = (value) => value < claimStart ? claimStart - value : value > claimEnd ? value - claimEnd : 0
    return distance(a.index) - distance(b.index)
  })
  const subject = subjects[0]?.subject
  return subject && /\.test\.[cm]?[jt]sx?$/.test(subject) ? basename(subject) : subject ?? null
}

function claimsIn(line) {
  const patterns = [
    /\ba test fails (?:if|when)\b/gi,
    /`[^`\n]*\.test\.[cm]?[jt]sx?`/gi,
    /\blocked by a test\b/gi,
    /\bthe suite fails when\b/gi,
  ]
  const claims = []
  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      const subject = nearestSubject(line, start, end)
      if (subject && !subject.includes('*')) claims.push({ subject, start, end })
    }
  }
  return claims
}

function hasPlausibleTest(subject, tests) {
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matcher = new RegExp(escaped, 'i')
  return tests.some((file) => matcher.test(basename(file)) || matcher.test(readFileSync(file, 'utf8')))
}

const root = parseArgs(process.argv.slice(2))
const tests = walk(join(root, 'toolkit'))
for (const file of markdownFiles(root)) {
  for (const [offset, line] of readFileSync(file, 'utf8').split('\n').entries()) {
    for (const claim of claimsIn(line)) {
      if (hasPlausibleTest(claim.subject, tests)) continue
      process.stdout.write(
        `${relative(root, file)}:${offset + 1}: ${line.trim()} (searched: ${claim.subject})\n`,
      )
    }
  }
}
