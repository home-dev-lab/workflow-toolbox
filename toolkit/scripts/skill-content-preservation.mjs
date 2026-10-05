#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function normalizeLine(line) {
  return line.trim().replace(/\s+/gu, ' ')
}

// Multiset membership: each occurrence of an old line consumes one occurrence in the new texts,
// so deleting one copy of a line that the old body repeated is reported, not hidden by its twin.
export function findMissingLines(oldText, newTexts) {
  const available = new Map()
  for (const line of newTexts.flatMap((text) => text.split('\n').map(normalizeLine))) {
    available.set(line, (available.get(line) ?? 0) + 1)
  }
  return oldText.split('\n').flatMap((line, index) => {
    const normalized = normalizeLine(line)
    if (!normalized) return []
    const count = available.get(normalized) ?? 0
    if (count > 0) {
      available.set(normalized, count - 1)
      return []
    }
    return [{ lineNumber: index + 1, line: normalized }]
  })
}

export function findUnlinkedReferences(skillBody, referenceFileNames) {
  return referenceFileNames.filter((name) => {
    const path = name.startsWith('references/') ? name : `references/${name}`
    const literal = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return !new RegExp(`(?<![\\w./-])${literal}(?![\\w+/-]|\\.[\\w])`, 'u').test(skillBody)
  })
}

export function listReferenceFiles(skillDir) {
  const root = join(skillDir, 'references')
  return existsSync(root) ? walkReferences(root, 'references') : []
}

function walkReferences(directory, prefix) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const relative = `${prefix}/${entry.name}`
      return entry.isDirectory() ? walkReferences(join(directory, entry.name), relative) : [relative]
    })
}

function validArgumentPair(flag, value, options) {
  return ['--old', '--skill-dir', '--max-chars'].includes(flag) && !options.has(flag)
    && typeof value === 'string' && value.length > 0 && !value.startsWith('--')
}

function parseArguments(argv) {
  const options = new Map()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!validArgumentPair(flag, value, options)) return null
    options.set(flag, value)
  }
  const limit = options.get('--max-chars') ?? '15000'
  const maxChars = Number(limit)
  if (!/^\d+$/.test(limit) || !Number.isSafeInteger(maxChars) || maxChars < 1) return null
  if (!options.has('--old') || !options.has('--skill-dir')) return null
  return { old: options.get('--old'), skillDir: options.get('--skill-dir'), maxChars }
}

function checkFiles(options, print) {
  const body = readFileSync(join(options.skillDir, 'SKILL.md'), 'utf8')
  const names = listReferenceFiles(options.skillDir).filter((name) => name.endsWith('.md'))
  const references = names.map((name) => readFileSync(join(options.skillDir, name), 'utf8'))
  const missing = findMissingLines(readFileSync(options.old, 'utf8'), [body, ...references])
  const unlinked = findUnlinkedReferences(body, names)
  const sizeOk = body.length <= options.maxChars
  print(`PRESERVATION: ${missing.length ? 'fail' : 'ok'} (${missing.length} missing non-blank lines)`)
  for (const { lineNumber, line } of missing) print(`MISSING line ${lineNumber}: ${line}`)
  print(`LINKS: ${unlinked.length ? 'fail' : 'ok'} (${names.length} references)`)
  for (const name of unlinked) print(`UNLINKED: ${name}`)
  print(`SIZE: ${sizeOk ? 'ok' : 'fail'} (${body.length}/${options.maxChars} UTF-16 code units)`)
  const ok = !missing.length && !unlinked.length && sizeOk
  print(`RESULT: ${ok ? 'ok' : 'fail'}`)
  return ok ? 0 : 1
}

export function main(argv, print = console.log) {
  const options = parseArguments(argv)
  if (!options) {
    print('USAGE: node skill-content-preservation.mjs --old <old SKILL.md> --skill-dir <dir> [--max-chars 15000]')
    print('RESULT: fail')
    return 2
  }
  try {
    return checkFiles(options, print)
  } catch (error) {
    print(`ERROR: ${error.message}`)
    print('RESULT: fail')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
