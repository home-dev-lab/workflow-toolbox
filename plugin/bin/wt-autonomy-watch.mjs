#!/usr/bin/env node
// Autonomy watcher for the Monitor tool, shipped as a plugin monitor.
//
// WHAT IT WATCHES: an autonomous session that declared a mandate, still has
// actionable queued work, has nothing else moving, and has gone idle long
// enough that the harness should hand it another turn.
//
// WHY THIS EXISTS: the event-driven monitors only speak when some OTHER thing
// changes. A long stretch of inline work can end with no delegated arc, no quota
// threshold, and no service transition, leaving an autonomous session asleep
// until something remembers to schedule its next wake manually.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { isServiceDegraded } from './lib/service-flag.mjs'
import { classifyMandate } from './lib/autonomy-mandate.mjs'

const MAX_TIMER_MS = 0x7fffffff
const MAX_POLL_SECONDS = Math.floor(MAX_TIMER_MS / 1000)
const DEFAULT_POLL_SECONDS = 60
const DEFAULT_IDLE_MINUTES = Number(process.env.WT_AUTONOMY_WATCH_IDLE_MINUTES || 15)
const DEFAULT_INFLIGHT_MINUTES = Number(process.env.WT_AUTONOMY_WATCH_INFLIGHT_MINUTES || 3)
const DEFAULT_QUEUE_STALE_MINUTES = Number(process.env.WT_AUTONOMY_WATCH_QUEUE_STALE_MINUTES || 120)
// ⚠ THE FRESHNESS WINDOW, and why 8 hours. The mandate marker is keyed on the PROJECT, not the
// session, precisely so a restart (a new CLAUDE_CODE_SESSION_ID) inherits whatever mandate is
// still live rather than losing it — see wt-autonomy-arm.mjs. That inheritance needs a ceiling, or
// it becomes the silent failure it replaces, wearing a louder costume: a mandate declared once and
// never revisited would keep waking sessions indefinitely, long after the human stopped caring.
//
// Both directions of getting this wrong are real, and neither is free:
//   - TOO SHORT defeats the whole point of keying on the project: a session restarted after a
//     lunch break, a crash, or a routine version bump loses the mandate exactly like the old
//     per-session scheme did, and the fix collapses back into "re-arm by hand".
//   - TOO LONG reintroduces the failure this route was chosen over — see AUTONOMY.md's
//     loud-vs-silent argument — but LOUD, not silent: a stale wake is visible in the transcript
//     and killable with `--disarm`, where the old per-session bug woke nobody and said nothing.
//
// 8 hours covers a full working day of restarts (the reported case: three restarts in one day)
// while resetting overnight — a mandate declared this afternoon should not still be walking
// tonight. Override with WT_AUTONOMY_WATCH_MANDATE_FRESHNESS_MINUTES for a project that needs a
// different rhythm; the watcher and `--status`/arm side never need to agree on this number because
// only the watcher enforces it — the marker itself carries no opinion about its own expiry.
const DEFAULT_MANDATE_FRESHNESS_MINUTES = Number(process.env.WT_AUTONOMY_WATCH_MANDATE_FRESHNESS_MINUTES || 480)
const DEFAULT_LANE_PATTERNS = ['opencode run', 'codex exec']

function write(line) {
  process.stdout.write(`${line}\n`)
}

process.stdout.on('error', () => {
  process.exit(0)
})

function redact(text) {
  return String(text)
    .replace(/[A-Za-z0-9_.-]*[A-Za-z0-9][A-Za-z0-9_.-]{15,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<redacted>' : m))
    .replace(/(bearer|token|authorization|api[-_ ]?key|secret)\s*[:=]?\s*\S+/gi, '$1 <redacted>')
    .replace(/[\r\n]+/g, ' ')
}

function fail(detail, code) {
  try {
    writeSync(1, `AUTONOMY WATCH FAILED: ${detail}\n`)
  } catch {
    // Exit code is the remaining signal.
  }
  process.exit(code)
}

function readNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function parseArgs(argv) {
  let pollSeconds = DEFAULT_POLL_SECONDS
  let projectDir = process.cwd()
  let once = false

  for (let i = 0; i < argv.length; i += 1) {
    const option = argv[i]
    if (option === '--once') {
      once = true
      continue
    }
    const raw = argv[i + 1]
    const value = typeof raw === 'string' && raw.startsWith('--') ? undefined : raw
    const shown = value === undefined ? '(missing)' : redact(value)
    if (option === '--project') {
      if (!value) fail(`missing value for --project (got ${shown})`, 2)
      projectDir = value
      i += 1
      continue
    }
    if (option === '--poll') {
      const n = readNumber(value)
      if (n === null || n < 1 || n > MAX_POLL_SECONDS) fail(`invalid --poll (minimum 1s, maximum ${MAX_POLL_SECONDS}s): ${shown}`, 2)
      pollSeconds = n
      i += 1
      continue
    }
    fail(`unknown option: ${redact(option)}`, 2)
  }

  return { pollSeconds, projectDir, once }
}

function projectSlug(dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

/** The QUEUE-SNAPSHOT slug — a DIFFERENT convention from projectSlug() above, and they must
 *  not be confused.
 *
 *  `projectSlug` names a directory under `<configDir>/projects/`: path with non-alphanumerics
 *  dashed, no hash. This one must reproduce, byte for byte, what
 *  `wt-queue-not-empty-gate-hook.mjs` writes and reads: a readable prefix capped at 120 chars
 *  PLUS a 12-char sha1 of the full path.
 *
 *  ⚠ Getting this wrong is silent and looks like success. A mismatched slug names a file that
 *  never exists, `readQueueSnapshot` returns `unknown`, and unknown keeps this watcher quiet by
 *  design — so a watcher reading the wrong path is indistinguishable from a working one with
 *  nothing to report. That is the exact failure mode this whole file exists to remove, so the
 *  duplication here is deliberate: one shared helper across two scripts the harness loads from
 *  different roots would couple them for no gain, but a DIVERGENCE must break a test, which is
 *  what the shipped-shape assertion in the suite is for. */
function queueSnapshotSlug(cwd) {
  const c = String(cwd || 'unknown')
  const readable = c.replace(/[^A-Za-z0-9]/g, '-').slice(0, 120)
  const hash = createHash('sha1').update(c).digest('hex').slice(0, 12)
  return `${readable}-${hash}`
}

function stateDir() {
  if (process.env.WT_AUTONOMY_WATCH_STATE_DIR) return process.env.WT_AUTONOMY_WATCH_STATE_DIR
  const base = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state')
  return path.join(base, 'wt-queue-gate')
}

function lanePatterns() {
  const raw = process.env.WT_AUTONOMY_WATCH_LANE_PATTERNS
  const patterns = typeof raw === 'string' && raw.trim()
    ? raw.split(',').map((value) => value.trim()).filter(Boolean)
    : DEFAULT_LANE_PATTERNS
  return patterns.length > 0 ? patterns : DEFAULT_LANE_PATTERNS
}

function safeProjectRoot(cwd) {
  try {
    return realpathSync(cwd)
  } catch {
    return path.resolve(cwd)
  }
}

function isSameOrNestedPath(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`)
}

function nearAncestorsOf(pid, depth) {
  const out = new Set()
  let current = Number(pid)
  for (let i = 0; i < depth && current > 1; i += 1) {
    const stat = readFileSync(`/proc/${current}/stat`, 'utf8')
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    if (!Number.isInteger(ppid) || ppid <= 1) break
    out.add(ppid)
    current = ppid
  }
  return out
}

function listMatchingPids(pattern) {
  try {
    const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0)
  } catch (error) {
    if (error?.status === 1) return []
    throw error
  }
}

function externalLaneRunning(cwd) {
  if (process.platform !== 'linux') return false
  const selfAndAncestors = new Set([process.pid, ...nearAncestorsOf(process.pid, 32)])
  const projectRoot = safeProjectRoot(cwd)

  for (const pattern of lanePatterns()) {
    for (const pid of listMatchingPids(pattern)) {
      if (selfAndAncestors.has(pid)) continue
      let candidateCwd
      try {
        candidateCwd = readlinkSync(`/proc/${pid}/cwd`)
      } catch {
        continue
      }
      if (isSameOrNestedPath(candidateCwd, projectRoot)) return true
    }
  }

  return false
}

function readQueueSnapshot(queuePath, now, staleAfterMs) {
  if (!existsSync(queuePath)) return { kind: 'unknown' }
  try {
    const parsed = JSON.parse(readFileSync(queuePath, 'utf8'))
    const at = parsed?.at
    const open = parsed?.open
    const next = parsed?.next
    if (typeof at !== 'number' || !Number.isFinite(at)) return { kind: 'unknown' }
    if (now - at > staleAfterMs) return { kind: 'unknown' }
    if (typeof open !== 'number' || !Number.isFinite(open) || open < 0) return { kind: 'unknown' }
    if (typeof next !== 'string') return { kind: 'unknown' }
    return { kind: 'known', open, next: next.trim() }
  } catch {
    return { kind: 'unknown' }
  }
}

function mostRecentSubagentWriteMs(subagentsDir) {
  try {
    let newest = 0
    for (const entry of readdirSync(subagentsDir)) {
      if (!entry.endsWith('.jsonl')) continue
      const mtimeMs = statSync(path.join(subagentsDir, entry)).mtimeMs
      if (mtimeMs > newest) newest = mtimeMs
    }
    return newest
  } catch {
    return 0
  }
}

function readMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return null
  }
}

function readMarker(markerPath) {
  if (!existsSync(markerPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8'))
    const transcriptMtimeMs = parsed?.transcriptMtimeMs
    const mandateDeclaredAtMs = parsed?.mandateDeclaredAtMs
    if (typeof transcriptMtimeMs !== 'number' || !Number.isFinite(transcriptMtimeMs)) return null
    if (typeof mandateDeclaredAtMs !== 'number' || !Number.isFinite(mandateDeclaredAtMs)) return null
    return { transcriptMtimeMs, mandateDeclaredAtMs }
  } catch {
    return null
  }
}

function writeMarker(markerPath, payload) {
  writeFileSync(markerPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function poll(context) {
  const now = Date.now()
  // ⚠ SAME CLASSIFICATION THE BANNER USES — see lib/autonomy-mandate.mjs for why this is a shared
  // function rather than a second copy of "is this marker still fresh". Only 'live' proceeds;
  // 'absent' and 'expired' both stay silent, for different reasons the banner distinguishes.
  const mandate = classifyMandate(context.mandatePath, context.mandateFreshnessMs, now, context.sessionId)
  if (mandate.kind !== 'live') return

  const transcriptMtimeMs = readMtimeMs(context.transcriptPath)
  if (transcriptMtimeMs === null) return

  const queue = readQueueSnapshot(context.queuePath, now, context.queueStaleMs)
  if (queue.kind !== 'known') return
  if (queue.open <= 0 || queue.next.length === 0) return

  const newestSubagentWriteMs = mostRecentSubagentWriteMs(context.subagentsDir)
  if (newestSubagentWriteMs >= now - context.inflightMs) return
  if (externalLaneRunning(context.projectDir)) return

  if (transcriptMtimeMs > now) return
  if (now - transcriptMtimeMs < context.idleMs) return

  const previousMarker = readMarker(context.markerPath)
  if (previousMarker && previousMarker.transcriptMtimeMs === transcriptMtimeMs && previousMarker.mandateDeclaredAtMs === mandate.declaredAtMs) {
    return
  }

  // ⚠ INHERITANCE IS ANNOUNCED, NEVER SILENT — this is the half that keeps the chosen failure
  // shape (loud, killable) loud rather than letting it decay back into the silent one it replaced.
  // A session picking up a mandate it did not itself stamp says so, and says how old the mandate
  // is and which session stamped it — a reader can then judge whether that inheritance is still
  // wanted, rather than discovering only that "something woke me".
  const ageMin = Math.round(mandate.ageMin)
  const provenance = mandate.inherited
    ? ` (inherited from session ${mandate.declaredBy}, mandate declared ${ageMin}min ago)`
    : ''

  writeMarker(context.markerPath, {
    emittedAt: new Date(now).toISOString(),
    transcriptMtimeMs,
    mandateDeclaredAtMs: mandate.declaredAtMs,
    mandateSessionId: mandate.declaredBy,
    inherited: mandate.inherited,
    idleForMs: now - transcriptMtimeMs,
    open: queue.open,
    next: queue.next,
  })
  write(`AUTONOMY WAKE: idle session with mandate${provenance}, ${queue.open} open, next: ${queue.next}`)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const { pollSeconds, projectDir, once } = parseArgs(process.argv.slice(2))
const sessionId = process.env.CLAUDE_CODE_SESSION_ID || ''
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
const watchStateDir = stateDir()

try {
  mkdirSync(watchStateDir, { recursive: true })
} catch (error) {
  fail(`state dir unavailable: ${redact(watchStateDir)} (${redact(error?.message ?? error)}) — autonomy is NOT being watched`, 1)
}

if (!sessionId) process.exit(0)

const projectStateRoot = path.join(configDir, 'projects', projectSlug(projectDir))
const transcriptPath = path.join(projectStateRoot, `${sessionId}.jsonl`)
const subagentsDir = path.join(projectStateRoot, sessionId, 'subagents')
// ⚠ PER-PROJECT, matching the SHIPPED stop gate. An earlier draft read a single machine-global
// `queue.json` — the shape a PRIVATE copy of that gate on this machine still uses. Reading the
// global file would make this watcher answer with whichever project last wrote a count, which is
// worse than silence: it would wake a session about another project's queue.
const queuePath = path.join(watchStateDir, `queue-${queueSnapshotSlug(projectDir)}.json`)
const mandateDir = process.env.WT_AUTONOMY_WATCH_MANDATE_DIR || watchStateDir
// ⚠ KEYED ON THE PROJECT, NOT THE SESSION — the contract with wt-autonomy-arm.mjs. A per-session
// path died the instant its session restarted (new CLAUDE_CODE_SESSION_ID, marker unreachable);
// this reads whatever mandate is still fresh for THIS PROJECT, however many sessions have come
// and gone since it was declared. See wt-autonomy-arm.mjs for the full rationale.
const mandatePath = path.join(mandateDir, `engine-${projectSlug(projectDir)}.json`)
const markerPath = path.join(watchStateDir, `autonomy-watch-${sessionId}.json`)

const context = {
  projectDir,
  sessionId,
  transcriptPath,
  subagentsDir,
  queuePath,
  mandatePath,
  markerPath,
  idleMs: DEFAULT_IDLE_MINUTES * 60_000,
  inflightMs: DEFAULT_INFLIGHT_MINUTES * 60_000,
  queueStaleMs: DEFAULT_QUEUE_STALE_MINUTES * 60_000,
  mandateFreshnessMs: DEFAULT_MANDATE_FRESHNESS_MINUTES * 60_000,
}

// ⚠ ARMED BANNER, and it is not decoration. This watcher's whole purpose is to close a silence
// gap, and until this line existed it had the very defect it was built to remove: an unarmed
// watcher and a watcher with nothing to report produced the identical observation — nothing. A
// reader could not tell "running and quiet because all is well" from "running and structurally
// unable to ever fire here".
//
// So the line names the two preconditions a session can actually get WRONG, with their live
// state, rather than merely announcing that a process started. Both are absent by default: a
// session that never declared a mandate has no marker, and a project whose stop gate never ran
// has no queue snapshot. Either one absent means this watcher can never emit, however healthy
// its process looks.
//
// It prints in EVERY session, including ordinary interactive ones with no mandate — one line,
// matching what the other three monitors already cost. That is deliberate: the case worth
// seeing is exactly `mandate=absent`, and a banner suppressed in that case would be silent in
// the only situation it exists for.
// ⚠ SAME `classifyMandate` THE GATE USES (lib/autonomy-mandate.mjs), and that sentence is the
// whole fix for the defect this replaces: `--status` and this banner used to each carry their own
// freshness check, and they drifted — the gate correctly refused to fire on an expired mandate
// while `--status` still reported `armed`, because it only ever checked the file's EXISTENCE.
// Routing both readouts through one classifier makes that kind of drift structurally impossible —
// there is no second copy left to disagree with this one.
function mandateArmedState(mandatePath, freshnessMs, now, currentSessionId) {
  const mandate = classifyMandate(mandatePath, freshnessMs, now, currentSessionId)
  if (mandate.kind === 'absent') return 'absent'
  if (mandate.kind === 'expired') return `stale(${mandate.ageMin.toFixed(0)}min)`
  return `present(${mandate.inherited ? 'inherited' : 'own'})`
}

// ⚠ Freshness is read the SAME WAY `poll()` reads it — from the snapshot's own `at` field, never
// from the file's mtime. Those two can disagree (a file copied or touched carries a new mtime over
// an old `at`), and a banner that judged freshness differently from the code it describes would
// announce "fresh" about a snapshot the watcher itself treats as stale. A banner that lies about
// why the watcher is quiet is worse than no banner: it moves the reader's suspicion somewhere else.
// It deliberately does NOT reuse readQueueSnapshot(): that function collapses absent, unreadable
// and stale into one `unknown`, which is exactly right for deciding whether to fire and exactly
// wrong for telling a reader WHY nothing will happen. Those three call for three different
// actions — write a snapshot, fix a malformed one, refresh an old one.
function queueArmedState(queuePath, staleMs, now) {
  if (!existsSync(queuePath)) return 'absent'
  try {
    const at = JSON.parse(readFileSync(queuePath, 'utf8'))?.at
    if (typeof at !== 'number' || !Number.isFinite(at)) return 'unreadable'
    const ageMin = (now - at) / 60_000
    return now - at > staleMs ? `stale(${ageMin.toFixed(0)}min)` : `fresh(${ageMin.toFixed(0)}min)`
  } catch {
    return 'unreadable'
  }
}

const nowAtArming = Date.now()
const mandateState = mandateArmedState(context.mandatePath, context.mandateFreshnessMs, nowAtArming, sessionId)
const queueState = queueArmedState(context.queuePath, context.queueStaleMs, nowAtArming)
const canFire = mandateState.startsWith('present') && queueState.startsWith('fresh')
// ⚠ A DIAGNOSIS CARRIES ITS REMEDY. Naming what is missing without naming what supplies it moves a
// reader from "I cannot tell whether this works" to "I know it is broken and not what to do" —
// better, but still short of actionable, and the second state is where a reader gives up. So each
// missing piece names the thing that provides it.
const remedies = []
if (!mandateState.startsWith('present')) remedies.push('run `wt-autonomy-arm.mjs` to declare a mandate')
if (!queueState.startsWith('fresh')) remedies.push('register `wt-queue-not-empty-gate-hook.mjs` (Stop) to write the queue snapshot')
write(
  `AUTONOMY WATCH ARMED: idle=${DEFAULT_IDLE_MINUTES}min poll=${pollSeconds}s · ` +
    `mandate=${mandateState} · queue=${queueState}` +
    (canFire ? '' : ` · CANNOT FIRE — ${remedies.join('; ')}`),
)

for (;;) {
  try {
    if (!(await isServiceDegraded())) poll(context)
  } catch {
    // Skip this poll and keep watching.
  }
  if (once) break
  await wait(pollSeconds * 1000)
}
