// Read-only ownership snapshots; the only write here is the human review append.
//
// Only REGULAR files are ever opened: a FIFO, socket or device under one of these directories
// would block a synchronous read forever, and a blocked read is out of reach of the hook's
// fail-open wrapper — the spawn would hang instead of passing.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { validateLivenessRecord } from '../liveness.mjs'

function files(dir, accept) {
  try { return readdirSync(dir).filter(accept).sort().map(name => join(dir, name)) } catch { return [] }
}

/** Contents of a regular file, `null` when absent, or `undefined` when it exists but cannot be read safely. */
function readRegular(file) {
  let stat
  try { stat = statSync(file) } catch (error) { return error?.code === 'ENOENT' ? null : undefined }
  if (!stat.isFile()) return undefined
  try { return readFileSync(file, 'utf8') } catch { return undefined }
}

/** Parsed object lines plus whether every non-blank line parsed (`complete`). */
function records(file, { missingIsComplete = true } = {}) {
  const text = readRegular(file)
  if (text === null) return { records: [], complete: missingIsComplete }
  if (text === undefined) return { records: [], complete: false }
  let complete = true
  const parsed = text.split('\n').flatMap(line => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) return [value]
    } catch { /* counted below */ }
    complete = false
    return []
  })
  return { records: parsed, complete }
}

// Registry files last written before `minMtimeMs` cannot hold fresh ownership; they are never
// opened, so the hook's cost follows the active sessions, not the whole registry history.
export function pilotOwnershipSnapshot(livenessDir, registryDir, minMtimeMs = -Infinity) {
  const liveness = files(livenessDir, name => name.endsWith('.json')).flatMap(file => {
    try {
      const text = readRegular(file)
      if (typeof text !== 'string') return []
      const result = validateLivenessRecord(JSON.parse(text))
      return result.ok ? [{ file, ...result.record }] : []
    } catch { return [] }
  })
  const registries = files(registryDir, name => name.endsWith('.jsonl')).flatMap(file => {
    try {
      const stat = statSync(file)
      if (!stat.isFile() || stat.mtimeMs < minMtimeMs) return []
      return [{ file, mtime: stat.mtimeMs, records: records(file).records }]
    } catch { return [] }
  })
  return { liveness, registries }
}

const REVIEWS = 'wt-duplicate-pilot-guard-reviews.ndjson'
/** `complete` is false when any journal week or the review file could not be read or parsed in full. */
export function pilotReviewSnapshot(dir) {
  const weeks = files(dir, name => /^\d{4}-W\d{2}\.ndjson$/.test(name)).map(file => records(file))
  const reviews = records(join(dir, REVIEWS))
  return {
    events: weeks.flatMap(week => week.records),
    reviews: reviews.records,
    complete: weeks.every(week => week.complete) && reviews.complete,
  }
}

export function appendPilotReview(dir, record) {
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, REVIEWS), `${JSON.stringify(record)}\n`)
}
