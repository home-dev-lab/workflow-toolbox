// command-repeat-core.mjs — pure shape/result discrimination for repeated
// command executions. Kept filesystem-free so tests can drive the exact
// third-occurrence contract without depending on session files.

import { createHash } from 'node:crypto'

export const DEFAULT_THRESHOLD = 3
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000
export const DEFAULT_MAX_PAIRS = 256

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex')
}

function asText(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function asFiniteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

// Shape normalization is deliberately narrow. We only erase values that are
// operational noise in this repo's real failure mode: a repo path whose ONLY
// changing segment is the worktree name, temp-file leaf names created per run,
// explicit pid/timestamp spellings, UUIDs, and ISO/epoch timestamps. We do NOT
// normalize arbitrary numbers, because that would wrongly fold distinct
// gestures like `sleep 30` and `sleep 300` into one shape.
function normalizeWorktreeSegments(text) {
  return text.replace(/([/\\]worktrees[/\\])[^/\\\s'"`]+/g, '$1<worktree>')
}

function normalizeTmpPaths(text) {
  return text
    .replace(/\/(?:var\/folders\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+|tmp)\/[A-Za-z0-9._-]*?(?:tmp|temp|cache|log)?[A-Za-z0-9._-]*/g, (match) => {
      const root = match.includes('/var/folders/') ? '/var/folders/<tmp>' : '/tmp'
      return `${root}/<tmp>`
    })
    .replace(/\\(?:Temp|tmp)\\[A-Za-z0-9._-]*/g, '\\tmp\\<tmp>')
}

function normalizePidAndTimeMarkers(text) {
  return text
    .replace(/\bpid[=:]\d+\b/gi, 'pid=<pid>')
    .replace(/\bppid[=:]\d+\b/gi, 'ppid=<pid>')
    .replace(/\bproc[=:]\d+\b/gi, 'proc=<pid>')
    .replace(/\b(20\d{2}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\b/g, '<timestamp>')
    .replace(/\b\d{10,13}\b/g, '<epoch>')
}

function normalizeIdentifiers(text) {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/([._-])(\d{5,}|[0-9a-f]{8,})(?=(?:\.[A-Za-z0-9._-]+)?\b)/g, '$1<volatile>')
}

export function normalizeCommandShape({ command = '', cwd = '' } = {}) {
  const normalizedCommand = normalizeIdentifiers(
    normalizePidAndTimeMarkers(normalizeTmpPaths(normalizeWorktreeSegments(asText(command).trim()))),
  )
  const normalizedCwd = normalizeIdentifiers(
    normalizePidAndTimeMarkers(normalizeTmpPaths(normalizeWorktreeSegments(asText(cwd).trim()))),
  )
  const material = JSON.stringify({ cwd: normalizedCwd, command: normalizedCommand })
  return {
    normalizedCommand,
    normalizedCwd,
    material,
    shapeHash: sha256(material),
  }
}

export function fingerprintResult({ exitCode = 0, stdout = '', stderr = '', signal = '' } = {}) {
  const material = JSON.stringify({
    exitCode: asFiniteNumber(exitCode, 0),
    signal: asText(signal),
    stdout: asText(stdout),
    stderr: asText(stderr),
  })
  return {
    material,
    resultFingerprint: sha256(material),
    digest: sha256(`${asText(stdout)}\n\0\n${asText(stderr)}`),
  }
}

export function pruneState(state, { nowMs, ttlMs = DEFAULT_TTL_MS, maxPairs = DEFAULT_MAX_PAIRS } = {}) {
  const now = asFiniteNumber(nowMs, Date.now())
  const ttl = Math.max(0, asFiniteNumber(ttlMs, DEFAULT_TTL_MS))
  const max = Math.max(1, asFiniteNumber(maxPairs, DEFAULT_MAX_PAIRS))
  const parsed = safeObject(state)
  const seen = safeObject(parsed.seen)
  const entries = []

  for (const [pairKey, rawEntry] of Object.entries(seen)) {
    const entry = safeObject(rawEntry)
    const lastSeenMs = asFiniteNumber(entry.lastSeenMs, NaN)
    const count = Math.max(0, asFiniteNumber(entry.count, 0))
    if (!Number.isFinite(lastSeenMs) || count === 0) continue
    if (ttl > 0 && now - lastSeenMs > ttl) continue
    entries.push({
      pairKey,
      shapeHash: asText(entry.shapeHash),
      resultFingerprint: asText(entry.resultFingerprint),
      count,
      lastSeenMs,
    })
  }

  entries.sort((a, b) => b.lastSeenMs - a.lastSeenMs)
  const trimmed = entries.slice(0, max)
  const nextSeen = Object.fromEntries(
    trimmed.map((entry) => [entry.pairKey, {
      shapeHash: entry.shapeHash,
      resultFingerprint: entry.resultFingerprint,
      count: entry.count,
      lastSeenMs: entry.lastSeenMs,
    }]),
  )

  return {
    schemaVersion: 1,
    updatedAtMs: now,
    seen: nextSeen,
  }
}

export function observeCommandRepeat({
  state = {},
  command = '',
  cwd = '',
  exitCode = 0,
  stdout = '',
  stderr = '',
  signal = '',
  nowMs = Date.now(),
  threshold = DEFAULT_THRESHOLD,
  ttlMs = DEFAULT_TTL_MS,
  maxPairs = DEFAULT_MAX_PAIRS,
} = {}) {
  const effectiveThreshold = Math.max(1, asFiniteNumber(threshold, DEFAULT_THRESHOLD))
  const pruned = pruneState(state, { nowMs, ttlMs, maxPairs })
  const shape = normalizeCommandShape({ command, cwd })
  const result = fingerprintResult({ exitCode, stdout, stderr, signal })
  const pairKey = `${shape.shapeHash}:${result.resultFingerprint}`
  const prior = safeObject(pruned.seen[pairKey])
  const count = Math.max(0, asFiniteNumber(prior.count, 0)) + 1
  const nextState = {
    ...pruned,
    updatedAtMs: asFiniteNumber(nowMs, Date.now()),
    seen: {
      ...pruned.seen,
      [pairKey]: {
        shapeHash: shape.shapeHash,
        resultFingerprint: result.resultFingerprint,
        count,
        lastSeenMs: asFiniteNumber(nowMs, Date.now()),
      },
    },
  }

  return {
    state: pruneState(nextState, { nowMs, ttlMs, maxPairs }),
    normalizedCommand: shape.normalizedCommand,
    normalizedCwd: shape.normalizedCwd,
    shapeHash: shape.shapeHash,
    resultFingerprint: result.resultFingerprint,
    digest: result.digest,
    count,
    pairKey,
    flagged: count >= effectiveThreshold,
    newlyFlagged: count === effectiveThreshold,
  }
}
