#!/usr/bin/env node
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createVitest } from 'vitest/node'
import { parse } from '../../plugin/bin/lib/vendor/yaml.mjs'

const toolkit = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const difference = (left, right) => {
  const keys = new Set(right)
  return left.filter((file) => !keys.has(file))
}

function shardCount() {
  const workflow = parse(readFileSync(resolve(toolkit, '../.github/workflows/cross-os.yml'), 'utf8'))
  const entries = workflow.jobs.matrix.strategy.matrix.include.filter(({ os }) => os === 'ubuntu-latest')
  const indices = entries.map(({ shard }) => shard)
  if (entries.length < 2 || indices.some((index, offset) => index !== offset + 1)) {
    throw new Error('Ubuntu matrix shards must be numbered exactly 1..N with N >= 2')
  }
  return entries.length
}

function relativeFile(file, base = toolkit) {
  if (typeof file !== 'string') throw new Error('Test report file name must be a string')
  const name = relative(base, file).replaceAll('\\', '/')
  if (name.startsWith('../') || isAbsolute(name) || !name) throw new Error(`Test file outside toolkit: ${file}`)
  return name
}

// Use the configured globbing and sequencer used by Vitest's pool, without running tests.
// `vitest list --filesOnly --shard=...` does not invoke sequencer.shard in the pinned Vitest version.
export async function collectPlan() {
  const count = shardCount()
  const ctx = await createVitest('test', { root: toolkit, watch: false, coverage: { enabled: false } })
  try {
    const specs = await ctx.getRelevantTestSpecifications()
    const full = specs.map(({ moduleId }) => relativeFile(moduleId)).sort()
    if (!full.length || new Set(full).size !== full.length) throw new Error('Full suite must contain unique test files')
    const shards = []
    for (let index = 1; index <= count; index++) {
      ctx.config.shard = { index, count }
      const sequencer = new ctx.config.sequence.sequencer(ctx)
      shards.push((await sequencer.shard([...specs])).map(({ moduleId }) => relativeFile(moduleId)).sort())
    }
    return { full, shards }
  } finally {
    await ctx.close()
  }
}

export function assertPartition(full, shards) {
  const union = shards.flat()
  const counts = new Map()
  for (const file of union) counts.set(file, (counts.get(file) ?? 0) + 1)
  const missing = difference(full, union)
  const extra = difference([...counts.keys()], full)
  const duplicated = [...counts].filter(([, count]) => count > 1).map(([file]) => file)
  const proof = { missing, extra, duplicated }
  if (missing.length || extra.length || duplicated.length) {
    throw new Error(`Shard union mismatch: ${JSON.stringify(proof)}`)
  }
  return proof
}

function requireNames(actual, expected, label) {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label}: expected ${expected.join(', ')}; received ${actual.join(', ')}`)
  }
}

function readReports(directory, count) {
  const names = Array.from({ length: count }, (_, index) => `ubuntu-shard-${index + 1}.json`)
  requireNames(readdirSync(directory).filter((name) => /^ubuntu-shard-.*\.json$/.test(name)), names, 'Shard reports')
  return names.map((name) => {
    const report = json(resolve(directory, name))
    if (!Array.isArray(report.testResults)) throw new Error(`Missing testResults in ${name}`)
    return report.testResults.map(({ name }) => relativeFile(name)).sort()
  })
}

// BlobReporter uses a flatted reference table. Decode only its graph format; reject
// invalid references instead of treating an ordinary JSON document as a blob.
function decodeBlob(text) {
  const table = JSON.parse(text)
  if (!Array.isArray(table) || !Array.isArray(table[0])) throw new Error('Invalid Vitest blob reference table')
  const decoded = new Map()
  function dereference(index) {
    if (!/^\d+$/.test(String(index)) || !Object.hasOwn(table, index)) throw new Error('Invalid Vitest blob reference')
    if (decoded.has(index)) return decoded.get(index)
    const node = table[index]
    if (node === null || typeof node !== 'object') return node
    const output = Array.isArray(node) ? [] : Object.create(null)
    decoded.set(index, output)
    for (const [key, value] of Object.entries(node)) output[key] = typeof value === 'string' ? dereference(value) : value
    return output
  }
  return dereference('0')
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

export function assertCoverageBlobs(directory, shards, base = toolkit) {
  requireNames(readdirSync(directory), shards.map((_, index) => `blob-${index + 1}.json`), 'Coverage blobs')
  const fingerprints = new Map()
  for (const [index, files] of shards.entries()) {
    const label = `Shard ${index + 1}`
    try {
      const [, tasks, , coverage] = decodeBlob(readFileSync(resolve(directory, `blob-${index + 1}.json`), 'utf8'))
      if (!Array.isArray(tasks)) throw new Error('blob has no test membership')
      requireNames(tasks.map(({ filepath }) => relativeFile(filepath, base)), files, 'blob membership')
      if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage) || !Object.keys(coverage).length) {
        throw new Error('coverage payload is empty')
      }
      const fingerprint = createHash('sha256').update(canonical(coverage)).digest('hex')
      if (fingerprints.has(fingerprint)) throw new Error(`coverage payload duplicates shard ${fingerprints.get(fingerprint)}`)
      fingerprints.set(fingerprint, index + 1)
    } catch (error) {
      throw new Error(`${label} ${error.message}`)
    }
  }
}

function printProof(full, shards, proof) {
  console.log(`FULL count=${full.length}\n${full.join('\n')}`)
  shards.forEach((files, index) => console.log(`SHARD ${index + 1}/${shards.length} count=${files.length}\n${files.join('\n')}`))
  console.log(`FULL_MINUS_UNION=${JSON.stringify(proof.missing)}`)
  console.log(`UNION_MINUS_FULL=${JSON.stringify(proof.extra)}`)
  console.log(`DUPLICATES=${JSON.stringify(proof.duplicated)}`)
}

function validateArguments(args) {
  if (args.length > 2 || (args[0]?.startsWith('--') && (args[0] !== '--plan' || args.length !== 1))) {
    throw new Error('usage: check-posix-shards.mjs [--plan | <JSON report directory> [<blob directory>]]')
  }
}

export async function runCli(args) {
  try {
    validateArguments(args)
    const plan = await collectPlan()
    const shards = args.length && args[0] !== '--plan' ? readReports(args[0], plan.shards.length) : plan.shards
    const proof = assertPartition(plan.full, shards)
    for (const [index, files] of shards.entries()) {
      requireNames(files, plan.shards[index], `Shard ${index + 1} membership`)
    }
    if (args[1]) assertCoverageBlobs(args[1], shards)
    if (args[0] === '--plan') console.log(JSON.stringify(plan))
    else printProof(plan.full, shards, proof)
    return 0
  } catch (error) {
    console.error(error.message)
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await runCli(process.argv.slice(2))
}
