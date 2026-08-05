// command-repeat-core.mjs — pure shape/result discrimination for repeated
// command executions. Kept filesystem-free so tests can drive the exact
// third-occurrence contract without depending on session files.

import { createHash } from 'node:crypto'

export const DEFAULT_THRESHOLD = 3
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000
export const DEFAULT_MAX_PAIRS = 256
// Cap on how many distinct shapeHashes a single class+verdict bucket remembers.
// `maxPairs` bounds the NUMBER of seenClasses entries, but does nothing to
// bound the shapeHashes list WITHIN one entry — a class that keeps recurring
// with a fresh literal argument each time (e.g. grepping a different pattern
// every call) would otherwise grow that one entry's array without limit for
// as long as the entry stays within TTL. Once a bucket has accumulated this
// many distinct shapes it has long since cleared any reasonable threshold, so
// capping loses no detection value.
export const DEFAULT_MAX_CLASS_SHAPES = 64

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

function safeStringArray(value) {
  return Array.isArray(value) ? value.map((entry) => asText(entry)).filter(Boolean) : []
}

function basenameToken(token) {
  const text = asText(token)
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

// Shared quote-aware scanner. A backslash immediately before the CURRENT
// quote character is treated as an escape (the quote stays open) rather than
// a closer — without this, a shell-escaped quote like `"foo\" | bar"` closes
// early and everything after it is misread as unquoted, which can split a
// pipeline at a `|` that was actually inside a quoted string. Nested/doubled
// backslashes (`\\"`) are not specially handled — a rare enough shape that
// treating it the same as a single backslash is an accepted, stated limit.
function scanQuoted(text, onChar) {
  const source = asText(text)
  let quote = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      const escaped = char === quote && source[index - 1] === '\\'
      if (char === quote && !escaped) quote = ''
      onChar(char, { inQuote: true })
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      onChar(char, { inQuote: false })
      continue
    }
    onChar(char, { inQuote: false })
  }
}

function splitUnquoted(text, separator) {
  const parts = []
  let current = ''
  scanQuoted(text, (char, { inQuote }) => {
    if (!inQuote && char === separator) {
      parts.push(current)
      current = ''
      return
    }
    current += char
  })
  parts.push(current)
  return parts
}

function tokenizeSegment(text) {
  const tokens = []
  let current = ''
  scanQuoted(text, (char, { inQuote }) => {
    if (!inQuote && /\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      return
    }
    current += char
  })
  if (current) tokens.push(current)
  return tokens
}

// Flag-set classification is deliberately structural, not semantic: a token
// is a "flag" only by its position/shape, never by what tool it belongs to.
// - Stop collecting flags at a bare `--` (POSIX end-of-options): whatever
//   follows is positional, even if it happens to start with `-`.
// - Strip a `=value` suffix from a LONG option (`--include=*.js` -> `--include`)
//   so the literal value does not leak into the class key.
// - Sort the collected flags so `-c -i -n` and `-n -i -c` classify identically
//   — flag ORDER is not part of the "same flag set" invariant this exists to
//   express, and leaving it unsorted let equivalent invocations dodge the
//   detector just by reordering options.
// Combined short flags (`-cf` vs `-c -f`) are NOT expanded/split — treating
// them as equivalent risks folding together tools where combination changes
// meaning, and is left as a stated, narrower remaining gap.
function classifySegment(text) {
  const tokens = tokenizeSegment(text)
  const verb = basenameToken(tokens[0])
  const flags = []
  let pastTerminator = false
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (pastTerminator) continue
    if (token === '--') {
      pastTerminator = true
      continue
    }
    if (!token.startsWith('-')) continue
    const eq = token.indexOf('=')
    const flagOnly = token.startsWith('--') && eq !== -1 ? token.slice(0, eq) : token
    flags.push(flagOnly)
  }
  flags.sort()
  return [verb, ...flags].filter(Boolean).join(' ')
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

export function classifyCommandShape({ command = '' } = {}) {
  const classSignature = splitUnquoted(command, '|').map(classifySegment).join(' | ')
  return {
    classSignature,
    classKey: sha256(classSignature),
  }
}

export function classifyVerdict({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  const trimmedStdout = asText(stdout).trim()
  const trimmedStderr = asText(stderr).trim()

  // This heuristic is intentionally coarse. Two rules, in order:
  // 1. A real, populated stderr message on exit 1 is a genuine ERROR, not a
  //    quiet empty result — never call that hollow.
  // 2. Otherwise, hollow means no MEANINGFUL stdout: nothing at all, or exactly
  //    `0` (the grep -c / pgrep -c "no match" convention).
  // Exit code alone is deliberately NOT a hollow signal: many correct tools use
  // exit 1 to report real, substantive output (`diff -u`, `git diff
  // --exit-code`) with empty stderr. An earlier version of this function used
  // "exit 1 + empty stderr" as a catch-all hollow branch, which misclassified
  // that real, non-empty diff content as hollow — non-empty, non-"0" stdout is
  // never hollow, regardless of exit code.
  if (asFiniteNumber(exitCode, 0) === 1 && trimmedStderr !== '') return 'non-hollow'
  if (trimmedStdout === '' || trimmedStdout === '0') return 'hollow'
  return 'non-hollow'
}

function pruneCountMap(rawMap, { nowMs, ttlMs, maxPairs, keyField, fields, arrayFields = [] }) {
  const seen = safeObject(rawMap)
  const entries = []

  for (const [entryKey, rawEntry] of Object.entries(seen)) {
    const entry = safeObject(rawEntry)
    const lastSeenMs = asFiniteNumber(entry.lastSeenMs, NaN)
    const count = Math.max(0, asFiniteNumber(entry.count, 0))
    if (!Number.isFinite(lastSeenMs) || count === 0) continue
    if (ttlMs > 0 && nowMs - lastSeenMs > ttlMs) continue
    entries.push({
      [keyField]: entryKey,
      count,
      lastSeenMs,
      ...Object.fromEntries(fields.map((field) => [field, asText(entry[field])])),
      ...Object.fromEntries(arrayFields.map((field) => [field, safeStringArray(entry[field])])),
    })
  }

  entries.sort((a, b) => b.lastSeenMs - a.lastSeenMs)
  return Object.fromEntries(
    entries.slice(0, maxPairs).map((entry) => [entry[keyField], {
      count: entry.count,
      lastSeenMs: entry.lastSeenMs,
      ...Object.fromEntries(fields.map((field) => [field, entry[field]])),
      ...Object.fromEntries(arrayFields.map((field) => [field, entry[field]])),
    }]),
  )
}

export function pruneState(state, { nowMs, ttlMs = DEFAULT_TTL_MS, maxPairs = DEFAULT_MAX_PAIRS } = {}) {
  const now = asFiniteNumber(nowMs, Date.now())
  const ttl = Math.max(0, asFiniteNumber(ttlMs, DEFAULT_TTL_MS))
  const max = Math.max(1, asFiniteNumber(maxPairs, DEFAULT_MAX_PAIRS))
  const parsed = safeObject(state)

  return {
    schemaVersion: 2,
    updatedAtMs: now,
    seen: pruneCountMap(parsed.seen, {
      nowMs: now,
      ttlMs: ttl,
      maxPairs: max,
      keyField: 'pairKey',
      fields: ['shapeHash', 'resultFingerprint'],
    }),
    seenClasses: pruneCountMap(parsed.seenClasses, {
      nowMs: now,
      ttlMs: ttl,
      maxPairs: max,
      keyField: 'classPairKey',
      fields: ['classKey', 'verdictBucket'],
      arrayFields: ['shapeHashes'],
    }),
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
  classThreshold = DEFAULT_THRESHOLD,
  ttlMs = DEFAULT_TTL_MS,
  maxPairs = DEFAULT_MAX_PAIRS,
  maxClassShapes = DEFAULT_MAX_CLASS_SHAPES,
} = {}) {
  const effectiveThreshold = Math.max(1, asFiniteNumber(threshold, DEFAULT_THRESHOLD))
  const effectiveClassThreshold = Math.max(1, asFiniteNumber(classThreshold, DEFAULT_THRESHOLD))
  const effectiveMaxClassShapes = Math.max(1, asFiniteNumber(maxClassShapes, DEFAULT_MAX_CLASS_SHAPES))
  const pruned = pruneState(state, { nowMs, ttlMs, maxPairs })
  const shape = normalizeCommandShape({ command, cwd })
  const commandClass = classifyCommandShape({ command })
  const result = fingerprintResult({ exitCode, stdout, stderr, signal })
  const verdictBucket = classifyVerdict({ exitCode, stdout, stderr })
  const pairKey = `${shape.shapeHash}:${result.resultFingerprint}`
  const classPairKey = `${shape.normalizedCwd}:${commandClass.classKey}:${verdictBucket}`
  const prior = safeObject(pruned.seen[pairKey])
  const priorClass = safeObject(pruned.seenClasses[classPairKey])
  const count = Math.max(0, asFiniteNumber(prior.count, 0)) + 1
  const priorClassShapeHashes = safeStringArray(priorClass.shapeHashes)
  const mergedClassShapeHashes = priorClassShapeHashes.includes(shape.shapeHash)
    ? priorClassShapeHashes
    : [...priorClassShapeHashes, shape.shapeHash]
  // Cap AFTER dedup, keeping the most RECENT distinct shapes — once the array
  // hits the cap it stops growing, but classCount (its length) still reflects
  // "at least this many distinct shapes", which is all flagging needs.
  const classShapeHashes = mergedClassShapeHashes.length > effectiveMaxClassShapes
    ? mergedClassShapeHashes.slice(mergedClassShapeHashes.length - effectiveMaxClassShapes)
    : mergedClassShapeHashes
  const classCount = classShapeHashes.length
  const shapeFlagged = count >= effectiveThreshold
  const shapeNewlyFlagged = count === effectiveThreshold
  const classFlagged = verdictBucket === 'hollow' && classCount >= effectiveClassThreshold
  const classNewlyFlagged = verdictBucket === 'hollow' && classCount === effectiveClassThreshold
  const flagged = shapeFlagged || classFlagged
  const newlyFlagged = shapeNewlyFlagged || classNewlyFlagged
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
    seenClasses: {
      ...pruned.seenClasses,
      [classPairKey]: {
        classKey: commandClass.classKey,
        verdictBucket,
        count: classCount,
        shapeHashes: classShapeHashes,
        lastSeenMs: asFiniteNumber(nowMs, Date.now()),
      },
    },
  }

  return {
    state: pruneState(nextState, { nowMs, ttlMs, maxPairs }),
    normalizedCommand: shape.normalizedCommand,
    normalizedCwd: shape.normalizedCwd,
    shapeHash: shape.shapeHash,
    classSignature: commandClass.classSignature,
    classKey: commandClass.classKey,
    verdictBucket,
    resultFingerprint: result.resultFingerprint,
    digest: result.digest,
    count,
    classCount,
    pairKey,
    classPairKey,
    shapeFlagged,
    shapeNewlyFlagged,
    classFlagged,
    classNewlyFlagged,
    flagged,
    newlyFlagged,
    flaggedAxis: shapeFlagged && classFlagged ? 'both' : shapeFlagged ? 'shape' : classFlagged ? 'class' : null,
  }
}
