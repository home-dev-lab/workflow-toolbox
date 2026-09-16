// guard-journal.mjs — the ONE shared, durable record of a guard REFUSAL or WARNING.
//
// WHY THIS EXISTS. Of the 18 guard hooks under plugin/bin/*guard*.mjs, 14 wrote nothing durable
// at all: a guard fires, prints its JSON payload, and the fact that it fired is gone the moment
// the transcript scrolls past it. The insight "this recurring defect deserves a mechanism" is a
// judgement call and cannot itself be mechanised — but REPETITION can be counted, and counting
// is what turns "I think this happened before" (an impression that erodes at every recurrence)
// into "this guard fired 3 times this week" (a number). This module is the write side of that
// count; wt-guard-journal-scan.mjs (its sibling in plugin/bin/) is the read side.
//
// WHAT IT RECORDS, DELIBERATELY NARROW. Only decision === 'blocked' | 'warned' | 'silent' — a
// refusal, a warning surfaced through the hook payload, or an intentional journal-only detection.
// Anything else is not this module's concern — recordGuardEvent() no-ops on an unknown value, so a
// caller that passes the wrong string fails silently rather than polluting the count.
//
// FAIL-OPEN, STRUCTURALLY. A guard's whole POINT can be to refuse a dangerous command; if this
// journal's bookkeeping could throw, a guard that already decided to block/warn correctly could
// be made to fail on a full disk or a read-only home directory — worse than no journal at all.
// Same posture as plugin/bin/lib/fail-open-trace.mjs's writeFailOpenTrace(): every failure mode
// is swallowed, nothing here ever throws, and the call always returns.
//
// WEEKLY ROTATION, NDJSON, APPEND-ONLY. The question this journal answers is "has this recurred
// THIS WEEK" — rotation falls out of that for free, and gives an unbounded number of guard
// events an unbounded lifetime shape (old weeks age out by simply not being read, never deleted
// here). NDJSON append is the one shape that survives two concurrent sessions writing to the
// same file without a lock: `fs.appendFileSync` on a POSIX filesystem is atomic for writes this
// small, so two interleaved single-line appends land as two complete lines, never a torn one.
// Windows note in the cross-platform verdict below.
//
// CROSS-PLATFORM VERDICT (this plugin ships on Linux, Windows, macOS — see the project rule
// naming that requirement):
//   - Location: resolve the active config dir (`CLAUDE_CONFIG_DIR`, else ~/.claude), then look up
//     workflow-toolbox's marketplace in plugins/installed_plugins.json. Every caller uses
//     plugins/data/workflow-toolbox-<marketplace>/wt-guard-journal when installed, regardless of
//     its own CLAUDE_PLUGIN_DATA. An uninstalled --plugin-dir session can use its matching env dir;
//     otherwise the legacy XDG path remains the fallback. Node's path helpers supply native
//     separators; the legacy fallback stays unconventional-but-functional on Windows.
//   - Concurrency: POSIX small-append atomicity (no interleaved/torn lines) is a property of
//     Linux and macOS filesystems. NTFS's guarantee for concurrent small appends from separate
//     processes is not the same documented guarantee — two sessions racing a write on the SAME
//     millisecond, on Windows, is UNVERIFIED here and stated as such rather than assumed safe.
//     The single-writer case (the overwhelmingly common one — one guard, one hook invocation)
//     is unaffected on every platform.
//   - Origin: an absolute target under Node's native `os.tmpdir()` is `test`; another absolute
//     target is `real`; no usable target is `unknown`. Windows drive letters/separators are handled
//     by the native `path` implementation, and macOS's per-user /var/folders temp root is supplied
//     by `os.tmpdir()`. A non-native path spelling cannot be recognised safely and stays `unknown`,
//     never `real`. Selftests set `WT_GUARD_JOURNAL_TEST_ORIGIN=1` so guards that omit cwd are still
//     marked at this one write seam.
//   - `WT_GUARD_JOURNAL_DIR` / `WT_GUARD_JOURNAL_NOW` / `WT_GUARD_JOURNAL_TEST_ORIGIN` env
//     overrides exist for tests only (see guard-journal.test.ts) — normal operation never sets them.

import { appendFileSync, mkdirSync, realpathSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pluginName, resolvePluginDataDir } from './plugin-data-dir.mjs'

const MAX_REASON_LEN = 400
const MAX_SAFE_FIELD_LEN = 24
const MAX_EVIDENCE_KEYS = 6
const MAX_SECRET_CANDIDATE_LEN = 400
// Keys stay strict; VALUES also allow a comma, which is how a guard lists several items in one
// field (`after: "pnpm,git"`). A comma cannot carry a secret — the protection against that is
// that arguments are never SELECTED in the first place, not the charset. Excluding it only
// mangled a separator into `?` and made the record harder to read.
const SAFE_FIELD = /^[A-Za-z0-9._/-]+$/
const SAFE_VALUE_STRIP = /[^A-Za-z0-9._/,-]+/g

function sanitiseValue(value, mask = (text) => text) {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const sanitised = mask(String(value))
    .slice(0, MAX_SAFE_FIELD_LEN)
    .replace(SAFE_VALUE_STRIP, '?')
  return sanitised || null
}

function sanitiseEvidence(evidence, mask) {
  try {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null
    const out = {}
    let count = 0
    for (const [key, value] of Object.entries(evidence)) {
      if (!key || key.length > MAX_SAFE_FIELD_LEN || !SAFE_FIELD.test(key)) continue
      const sanitised = sanitiseValue(value, mask)
      if (sanitised === null) continue
      out[key] = sanitised
      count++
      if (count === MAX_EVIDENCE_KEYS) break
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

let warnedAboutSecretStore = false

function warnSecretStoreUnavailable() {
  if (warnedAboutSecretStore) return
  warnedAboutSecretStore = true
  try { writeSync(2, 'wt-guard-journal: secret guard store unavailable; writing unmasked\n') } catch {}
}

function secretGuardMasker() {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const storeDir = path.join(configDir, 'plugins', 'store')
    const named = path.join(storeDir, 'wt-secret-guard.json')
    const storePath = (() => {
      try {
        statSync(named)
        return named
      } catch {}
      return readdirSync(storeDir)
        .filter((name) => /^wt-secret-guard_inline-[^.]+\.json$/.test(name))
        .map((name) => ({ path: path.join(storeDir, name), mtime: statSync(path.join(storeDir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0]?.path
    })()
    if (!storePath) throw new Error('store missing')
    const store = JSON.parse(readFileSync(storePath, 'utf8'))
    if (typeof store?.salt !== 'string' || !Array.isArray(store?.detections?.entries)) throw new Error('store invalid')
    const tokens = new Map(store.detections.entries
      .filter((entry) => typeof entry?.sha256 === 'string' && typeof entry?.token === 'string')
      .map((entry) => [entry.sha256, entry.token]))
    return (text) => {
      const tokenFor = (candidate) => tokens.get(createHash('sha256').update(`${store.salt}:${candidate}`).digest('hex'))
      const wholeToken = tokenFor(text)
      if (wholeToken) return wholeToken
      if (tokens.size === 0) return text

      // The secret store contains only salted hashes, not the source value. Check bounded exact
      // substrings so a stored secret is found when surrounded by URL, JSON, or prose punctuation.
      let masked = ''
      for (let start = 0; start < text.length;) {
        const endLimit = Math.min(text.length, start + MAX_SECRET_CANDIDATE_LEN)
        let replacement = null
        let end = endLimit
        for (; end > start; end--) {
          replacement = tokenFor(text.slice(start, end))
          if (replacement) break
        }
        if (replacement) {
          masked += replacement
          start = end
        } else {
          masked += text[start]
          start++
        }
      }
      return masked
    }
  } catch {
    warnSecretStoreUnavailable()
    return (text) => text
  }
}

function baseDir() {
  const override = process.env.WT_GUARD_JOURNAL_DIR
  if (override) return override
  return resolvePluginDataDir({
    fallback: path.join(os.homedir(), '.local', 'state', 'wt-guard-journal'),
    pluginName: pluginName(),
  }).dir
}

/** now(), overridable only for tests (WT_GUARD_JOURNAL_NOW) — never read in normal operation. */
function now() {
  const override = process.env.WT_GUARD_JOURNAL_NOW
  if (override) {
    const d = new Date(override)
    if (!Number.isNaN(d.getTime())) return d
  }
  return new Date()
}

// ISO-8601 week number (Monday-start, week 1 = the week containing the year's first Thursday).
// Used only as a filename key — "which week" needs no more precision than this.
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNum = (d.getUTCDay() + 6) % 7 // Monday=0 .. Sunday=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3) // move to this week's Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3)
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function journalPath() {
  return path.join(baseDir(), `${isoWeekKey(now())}.ndjson`)
}

/**
 * The directory the decision was made in. A guard hook runs in the session's own directory, so
 * when a call site omits `cwd` the guard PROCESS's cwd is that same directory — not a guess.
 *
 * ⚠ Without this fallback the origin split is honest and EMPTY: measured on this tree, 26 of the
 * 33 files that journal never pass `cwd`, and they include the loudest guards. Their `real` count
 * would be pinned at zero forever, so the recurrence threshold — which reads `real` only — could
 * never fire for them. A count structurally unable to reach its threshold is worse than an
 * inflated one, because the inflated one at least fired sometimes.
 *
 * It cannot misclassify a test: the explicit `WT_GUARD_JOURNAL_TEST_ORIGIN` marker is consulted
 * first, and the test harness sets it for every guard process it spawns.
 */
function effectiveCwd(cwd) {
  if (typeof cwd === 'string' && cwd) return cwd
  try { return process.cwd() } catch { return null }
}

function firingOrigin(cwd) {
  try {
    const marker = process.env.WT_GUARD_JOURNAL_TEST_ORIGIN
    if (marker !== undefined) return marker === '1' ? 'test' : 'unknown'
    if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return 'unknown'
    const canonical = (value) => {
      try { return realpathSync(value) } catch { return path.resolve(value) }
    }
    const relative = path.relative(canonical(os.tmpdir()), canonical(cwd))
    const underTempRoot = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    return underTempRoot ? 'test' : 'real'
  } catch {
    return 'unknown'
  }
}

export function guardMode() {
  const raw = process.env.WT_GUARD_MODE
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'observe' ? 'observe' : 'enforce'
}

export function emitGuardNotice({ payload = null, stdoutJson = null, stdoutText = '', stderrText = '' } = {}) {
  if (guardMode() === 'observe') return false
  if (typeof payload?.agent_id === 'string' && payload.agent_id) return false
  if (stdoutJson !== null) writeSync(1, `${JSON.stringify(stdoutJson)}`)
  else if (stdoutText) writeSync(1, stdoutText)
  if (stderrText) writeSync(2, stderrText)
  return true
}

/**
 * Record ONE guard decision durably. NEVER throws, always returns.
 *
 * @param {object} event
 * @param {string} event.guard   - the guard's own filename (e.g. 'wt-main-guard-hook.mjs').
 *                                 Required — no guard name, no write.
 * @param {'blocked'|'warned'|'silent'} event.decision - required, and the ONLY values recorded.
 *                                 Any other value (including a guard's own internal
 *                                 'allowed-journaled'/'override-allow' bookkeeping) is a no-op
 *                                 here by design.
 * @param {string} [event.class]  - the guard's own classification of what it matched, if any.
 * @param {string} [event.reason] - free text, truncated to 400 chars.
 * @param {string} [event.cwd]    - the cwd the decision was made in, if known.
 * @param {string} [event.session] - bounded session id, if known.
 * @param {string} [event.agent] - bounded agent id, if known.
 * @param {object} [event.evidence] - up to six bounded string/number fields chosen by the guard.
 */
export function recordGuardEvent(event = {}) {
  try {
    const { guard, decision, class: cls, reason, cwd, session, agent, evidence } = event || {}
    if (!guard || !['blocked', 'warned', 'silent'].includes(decision)) return
    // Classify from the raw target before secret masking can alter a path segment, and fall back
    // to this process's own directory when the call site omitted one — see effectiveCwd.
    const target = effectiveCwd(cwd)
    const origin = firingOrigin(target)
    const mask = secretGuardMasker()
    const dir = baseDir()
    mkdirSync(dir, { recursive: true })
    const safeSession = typeof session === 'string' ? sanitiseValue(session, mask) : null
    const safeAgent = typeof agent === 'string' ? sanitiseValue(agent, mask) : null
    const safeEvidence = sanitiseEvidence(evidence, mask)
    const mode = guardMode()
    // Observe mode keeps the detector and the record but the guard said nothing to the model:
    // the recorded decision is then `silent`, never `warned` — a downstream reader that counts
    // `warned` as "the hook spoke" must not see one for a guard that was muted.
    const recorded = mode === 'observe' && decision === 'warned' ? 'silent' : decision
    const entry = {
      ts: now().toISOString(),
      guard,
      decision: recorded,
      mode,
      origin,
      ...(cls ? { class: mask(String(cls)) } : {}),
      ...(reason ? { reason: mask(String(reason)).slice(0, MAX_REASON_LEN) } : {}),
      ...(target ? { cwd: mask(String(target)) } : {}),
      ...(safeSession ? { session: safeSession } : {}),
      ...(safeAgent ? { agent: safeAgent } : {}),
      pid: process.pid,
      ppid: process.ppid,
      ...(safeEvidence ? { evidence: safeEvidence } : {}),
    }
    appendFileSync(journalPath(), `${JSON.stringify(entry)}\n`)
  } catch {
    // Journalling must NEVER be the reason a guard's own decision fails to render. Same
    // fail-open posture as writeFailOpenTrace() in fail-open-trace.mjs.
  }
}

// Exposed for the reader (wt-guard-journal-scan.mjs) and for tests — never for a guard hook.
export const __internal = { baseDir, isoWeekKey, journalPath, now }
