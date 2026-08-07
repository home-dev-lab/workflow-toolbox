// lane-activity-core.mjs — pure functions for wt-lane-activity.mjs.
//
// No I/O here: every function takes already-read data (a session DB row, a log file's text,
// timestamps) and returns a plain value. This is what makes the three degraded-path invariants
// (unreadable store, unreadable log, disagreeing sources -> unknown, never a guessed zero)
// testable without a live opencode process or a real SQLite file.

// ---------------------------------------------------------------------------------------------
// Session row -> normalized activity summary (model + token totals)
// ---------------------------------------------------------------------------------------------

// `row` is a raw `session` table row as node:sqlite's DatabaseSync returns it (an object with a
// null prototype, snake_case columns, `model` as a JSON string). Returns null when the row
// itself is missing or its `model`/timestamp fields can't be parsed — callers must not
// substitute a zero for a row that failed to parse; they report `unknown` instead.
export function normalizeSessionRow(row) {
  if (!row || typeof row !== 'object') return null
  let model = null
  if (typeof row.model === 'string' && row.model.length > 0) {
    try {
      const parsed = JSON.parse(row.model)
      if (parsed && typeof parsed === 'object') {
        model = { id: parsed.id ?? null, providerID: parsed.providerID ?? null, variant: parsed.variant ?? null }
      }
    } catch {
      model = null // malformed JSON in the model column — reported as null, never guessed
    }
  }
  const lastUpdatedMs = Number(row.time_updated)
  if (!Number.isFinite(lastUpdatedMs)) return null // no usable timestamp -> caller must treat as unreadable

  const tokenField = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
  const tokensInput = tokenField(row.tokens_input)
  const tokensOutput = tokenField(row.tokens_output)
  const tokensReasoning = tokenField(row.tokens_reasoning)
  const tokensCacheRead = tokenField(row.tokens_cache_read)
  const tokensCacheWrite = tokenField(row.tokens_cache_write)

  return {
    sessionId: typeof row.id === 'string' ? row.id : null,
    directory: typeof row.directory === 'string' ? row.directory : null,
    model,
    tokensInput,
    tokensOutput,
    tokensReasoning,
    tokensCacheRead,
    tokensCacheWrite,
    tokensTotal: tokensInput + tokensOutput + tokensReasoning,
    lastUpdatedMs,
  }
}

// Picks the most-recently-updated session row whose `directory` column matches
// `worktreeRealPath` EXACTLY (opencode writes one row per session with the cwd it was started
// in — no prefix/substring matching here, unlike wt-lane-probe's cwd-under-worktree rule, since
// a session's directory is a single recorded value, not a live process cwd that can be a
// subdirectory of the worktree). Returns null when nothing matches — never picks "close enough".
export function pickLatestSessionRow(rows, worktreeRealPath) {
  if (!Array.isArray(rows) || rows.length === 0) return null
  let best = null
  for (const row of rows) {
    if (row?.directory !== worktreeRealPath) continue
    const updated = Number(row?.time_updated)
    if (!Number.isFinite(updated)) continue
    if (!best || updated > Number(best.time_updated)) best = row
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// Log text -> latest human-readable activity for one worktree
// ---------------------------------------------------------------------------------------------

const LOG_LINE_RE = /^timestamp=(\S+)\s+level=\S+\s+(.*)$/
// `message=` can be a bare token (`message=fromDirectory`) or a double-quoted phrase
// (`message="watcher backend"`) — opencode's own logger switches shape depending on whether
// the message contains a space, so both forms are real, not a hypothetical.
const MESSAGE_RE = /message=(?:"((?:[^"\\]|\\.)*)"|(\S+))/

// Scans `logText` (the raw content of opencode's log file, or a bounded tail of it) for lines
// that reference `worktreeRealPath` anywhere in the line, and returns the one with the LATEST
// `timestamp=` field as { description, timestampMs, timestampIso } — or null when no line
// mentions the worktree at all (a legitimate "nothing found", never conflated with "log
// unreadable", which the caller reports separately).
//
// Matching is substring-on-the-whole-line rather than parsing out a specific `directory=`/
// `cwd=`/`file=` field: opencode's own log emits the worktree path under at least three
// different field names depending on the event (`directory=`, `cwd=`, `file=`), and a new event
// shape is expected to keep appearing — a substring match degrades gracefully to "line
// mentions this worktree", which is exactly the invariant this reader needs (a sub-task
// description), not a strict schema of the logger's own field names.
export function extractLatestLogActivity(logText, worktreeRealPath) {
  if (typeof logText !== 'string' || logText.length === 0) return null
  if (typeof worktreeRealPath !== 'string' || worktreeRealPath.length === 0) return null

  let latest = null
  for (const line of logText.split('\n')) {
    if (!line.includes(worktreeRealPath)) continue
    const lineMatch = LOG_LINE_RE.exec(line)
    if (!lineMatch) continue
    const [, timestampRaw, rest] = lineMatch
    const timestampMs = Date.parse(timestampRaw)
    if (!Number.isFinite(timestampMs)) continue
    if (latest && timestampMs <= latest.timestampMs) continue

    const messageMatch = MESSAGE_RE.exec(rest)
    const description = messageMatch ? (messageMatch[1] ?? messageMatch[2] ?? '').replace(/\\"/g, '"') : rest.trim()

    latest = { description, timestampMs, timestampIso: new Date(timestampMs).toISOString() }
  }
  return latest
}

// ---------------------------------------------------------------------------------------------
// Stall verdict — requires BOTH readable sources to agree, per the card's own order of value
// ---------------------------------------------------------------------------------------------

// Inputs are already-resolved facts, never raw rows/text:
//   nowMs               - current time
//   storeLastUpdatedMs  - session.time_updated, or null when the store/session was unreadable
//   logLastTimestampMs  - latest matching log line's timestamp, or null when the log was
//                         unreadable OR simply had no line for this worktree
//   thresholdMs         - the stall window
//   processAlive        - true | false | 'unknown' (from the process probe; a dead process is
//                         reported as 'gone', never folded into 'stalled')
//
// Returns { verdict, reason }. verdict is one of:
//   'stalled' - process alive, AND both the store and the log independently show no movement
//               for >= thresholdMs. This is the ONLY branch invariant 3 allows to say "stalled".
//   'active'  - process alive, AND at least one readable source shows movement inside the
//               window (the two sources are not required to agree on "active" the way they are
//               required to agree on "stalled" — a fresh log line during a still-computing turn
//               is real activity even if the store hasn't been written yet).
//   'gone'    - the process itself is confirmed not alive; a stopped process is a different
//               fact than a frozen one and must not be reported as a stall.
//   'unknown' - process aliveness could not be determined, OR fewer than two sources were
//               readable (one silent instrument is exactly the inverting failure this card
//               documents — see its own header quote).
export function computeStallVerdict({ nowMs, storeLastUpdatedMs, logLastTimestampMs, thresholdMs, processAlive }) {
  if (processAlive === false) {
    return { verdict: 'gone', reason: 'process is not running' }
  }
  if (processAlive !== true) {
    return { verdict: 'unknown', reason: 'process liveness could not be determined' }
  }

  const storeReadable = Number.isFinite(storeLastUpdatedMs)
  const logReadable = Number.isFinite(logLastTimestampMs)

  if (!storeReadable && !logReadable) {
    return { verdict: 'unknown', reason: 'neither the store nor the log produced a timestamp for this worktree' }
  }
  if (!storeReadable || !logReadable) {
    return {
      verdict: 'unknown',
      reason: `only one source was readable (${storeReadable ? 'store' : 'log'}) — a stall verdict needs both to agree`,
    }
  }

  const storeStale = nowMs - storeLastUpdatedMs >= thresholdMs
  const logStale = nowMs - logLastTimestampMs >= thresholdMs

  if (storeStale && logStale) {
    return { verdict: 'stalled', reason: 'both the store and the log show no movement past the threshold' }
  }
  return { verdict: 'active', reason: 'at least one source shows movement inside the threshold' }
}
