#!/usr/bin/env node
// Read-only differential against real frontmatter; usage: node scripts/frontmatter-corpus-diff.mjs [--examples N] root...
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createRequire } from 'node:module'
import { splitFrontmatter, parseFrontmatter } from '../../plugin/bin/lib/frontmatter.mjs'

const { parse } = createRequire(new URL('../packages/build/package.json', import.meta.url))('yaml')

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('usage: node scripts/frontmatter-corpus-diff.mjs [--examples N] root...')
  process.exit(0)
}
let maxExamples = 3
if (args[0] === '--examples') {
  maxExamples = Number(args[1])
  args.splice(0, 2)
}
if (!args.length || !Number.isInteger(maxExamples) || maxExamples < 0) {
  console.error('usage: node scripts/frontmatter-corpus-diff.mjs [--examples N] root...')
  process.exit(2)
}
const counts = { files: 0, distinct: 0, agree: 0, readerRejectYamlOk: 0, readerOkYamlReject: 0, extension: 0, mismatch: 0, bothReject: 0, opaque: 0 }
const examples = Object.create(null)
const seen = new Set()
const home = process.env.HOME
const display = (file) => home && (file === home || file.startsWith(`${home}${path.sep}`)) ? `~${file.slice(home.length)}` : file
function independentExtension(block) {
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const match = /^([^\s#:'"\[\]{}][^:]*:[ \t]+)([^\n]*)$/.exec(lines[i])
    if (!match) continue
    const value = match[2].replace(/[ \t]+#.*$/, '').trimEnd()
    if (!value.includes(': ') || /^[-?:,\[\]{}#&*!|>'"%@`]/.test(value) || /[\x00-\x1f\x7f]/.test(value) || /^[ \t]+\S/.test(lines[i + 1] ?? '')) continue
    lines[i] = match[1] + JSON.stringify(value)
    try { return parse(lines.join('\n'), { schema: 'failsafe', uniqueKeys: true, strict: true }) } catch { return null }
  }
  return null
}
function record(kind, file, detail) {
  counts[kind]++
  if ((examples[kind]?.length ?? 0) < maxExamples) (examples[kind] ??= []).push({ file: display(file), detail })
}
function inspect(file) {
  counts.files++
  let source
  try { source = fs.readFileSync(file, 'utf8') } catch { return }
  const split = splitFrontmatter(source)
  if (!split.ok || seen.has(split.block)) return
  seen.add(split.block)
  counts.distinct++
  const actual = parseFrontmatter(source)
  let expected, error
  try { expected = parse(split.block, { schema: 'failsafe', uniqueKeys: true, strict: true }) } catch (caught) { error = caught }
  if (error) {
    if (!actual.ok) record('bothReject', file, String(error))
    else if (actual.extension && independentExtension(split.block) && isDeepStrictEqual(actual.data, independentExtension(split.block))) record('extension', file, String(error))
    else record('readerOkYamlReject', file, String(error))
  } else if (!actual.ok) record('readerRejectYamlOk', file, actual.reason + ': ' + actual.detail)
  else if (!isDeepStrictEqual(actual.data, expected)) record('mismatch', file, 'parsed values differ')
  else record('agree', file, '')
}
function walk(root) {
  let stat
  try { stat = fs.lstatSync(root) } catch { return }
  if (stat.isDirectory()) {
    let entries
    try { entries = fs.readdirSync(root) } catch { return }
    for (const entry of entries) walk(path.join(root, entry))
  } else if (stat.isFile() && root.endsWith('.md')) inspect(root)
}
for (const root of args) walk(path.resolve(root))
console.log(JSON.stringify(counts))
console.log(JSON.stringify(examples, null, 2))
if (counts.mismatch || counts.readerOkYamlReject || counts.readerRejectYamlOk) process.exitCode = 1
