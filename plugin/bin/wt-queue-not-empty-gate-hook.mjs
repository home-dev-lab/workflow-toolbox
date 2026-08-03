#!/usr/bin/env node
// queue-not-empty-gate — a Stop hook that refuses a SILENT stop while tracked work remains.
//
// THE FAILURE THIS CLOSES, measured on an adopter's own machine (2026-08-02): under a standing
// "keep taking work" mandate, a session finished the batch it had itself created, wrote "the
// queue is empty", and stopped. Its tracker held 114 open items — the finished BATCH had been
// mistaken for the whole QUEUE. The claim was checkable in one query and the query was never
// run.
//
// WHY A RULE WAS NOT ENOUGH. A standing instruction ("announce a decision to stop, never make
// it silently") already existed, auto-loaded, and was violated anyway. An instruction a model
// can silently fail to follow is not a fix. This hook EXECUTES: it fires whether or not anyone
// remembered.
//
// WHAT IT DOES AND DOES NOT JUDGE. It never judges the REASON for stopping — a deliberate stop
// is legitimate at any time, for any reason. It makes it impossible to stop WITHOUT stating one
// while open work remains and nothing is running. Terminating a second time always succeeds.
//
// ⚠ A FIRST VERSION OF THIS MECHANISM CHECKED THE WRONG THING. It asked "was the queue LISTED
// recently?" — so listing it and then stopping anyway satisfied it perfectly, and it stayed
// silent through the exact failure it was built to catch. Looking at the queue is not the same
// as continuing to work on it; this version checks whether the queue is EMPTY, not whether it
// was looked at.
//
// ⚠ THE TWO WAYS THIS CLASS OF GUARD DIES, both deliberately designed against:
//   1. It merely PRINTS a reminder → ignorable → a hope with a filename. So it BLOCKS (exit 2).
//   2. It blocks too often → becomes an always-red gate → gets bypassed, then removed. So it
//      fires on a narrow, checkable conjunction, and at most once per COOLDOWN_MIN.
//      Silence is its normal state; if it ever becomes chatty, that is a defect in IT.
//
// TRACKER-AGNOSTIC BY DESIGN — the abstraction this shipped version adds over a private,
// single-project original. That original recognized "the queue was checked" by grepping the
// transcript for one tracker's own MCP tool names — unusable by any adopter on a different
// tracker, or none. Two ways to remove that coupling were considered:
//   (a) a configurable pattern list (tool/command names that count as "the queue was queried"),
//       read from settings;
//   (b) an inversion — read a freshness MARKER that whatever tracks the adopter's work updates,
//       instead of recognizing tool names.
// (b) is what this file does. (a) was rejected: it still requires every adopter to author
// regex against their own tracker's internal tool-call shape (which varies by MCP server
// version, CLI wrapper, or may not be a "tool call" at all — a plain file, a cron job) before
// the guard does anything — and an unconfigured guard is functionally absent either way, so (a)
// buys nothing over (b)'s default-silent posture while asking more of the adopter. (b) costs
// exactly one write of one JSON file after checking the queue — semantic ("I confirmed the
// queue's state"), not syntactic ("this string appeared in a transcript").
//
// THE MARKER CONTRACT — write this file after checking the queue, whatever your tracker is:
//   <state-dir>/queue-<project-slug>.json = {"open": <int>, "at": <epoch-ms>, "next": "<string>"}
// project-slug is derived from this cwd by `projectSlug()` below (a readable prefix plus a hash
// of the full path, so two different cwds never collide on the same filename). No tool ever
// writes this file for you — this hook only CONSUMES it. Nothing written, ever ⇒ this hook has
// nothing to say and never blocks (see "NO TRACKER" below). This is deliberate: better silent
// wrongly than loud wrongly — a guard that blocks an adopter who structurally cannot satisfy it
// becomes an always-red gate, gets bypassed, then removed, taking with it the adopters where it
// WAS useful.
//
// FAIL-CLOSED ONCE A MARKER EXISTS, deliberately: an unreadable or STALE marker counts as "work
// remains". The self-written-evidence hazard is real — the checked party writes the file — but
// it only runs one way: writing a marker that claims "0 open" is the only way to silence this,
// and that claim is checkable by anyone against the real tracker. Never writing one does not
// help, and neither does writing a stale one.
//
// It FAILS OPEN on its own malfunction, always: any unreadable input lets the turn end. A guard
// that blocks because a probe of ITS OWN broke would be failing INTO the thing it protects
// against.
//
// KNOWN BLIND SPOT, INHERITED FROM THE PRIVATE ORIGINAL AND NOT CLOSED HERE: this hook cannot
// tell "stopping for no reason" from "cannot work right now" (an exhausted usage window, a
// blocking external dependency). It will still fire in that case, because nothing available to
// it distinguishes the two. State this in any adopter-facing note.
//
// Ship / keep-private: this file IS the shipped, generalized copy — see plugin.json's Stop
// hooks array. It was ported from a private, single-project original (that copy stays wired at
// PROJECT scope, never machine-wide: a project with no tracker at all must never inherit a
// guard it cannot satisfy).

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const STATE_DIR = process.env.WT_QUEUE_GATE_DIR
  || join(homedir(), '.local', 'state', 'wt-queue-gate')
const COOLDOWN_MIN = 45 // never block more often than this, per session
const INFLIGHT_MIN = 3 // a subagent transcript touched this recently ⇒ work is running
const SNAPSHOT_MAX_AGE_MIN = 120

// ⚠ A readable slug ALONE is not a safe filename key: a lossy non-alnum→"-" transform plus a
// length cap means two DIFFERENT cwds can produce the SAME slug (e.g. "/a/b" and "/a-b"; or any
// two paths that only differ past the truncation point) — found by cross-family review of this
// file. That collision would let one project's snapshot answer for another's, which can turn
// "no tracker" into a false block, exactly the case this hook exists to never produce. So the
// key is the readable slug (for a human skimming the state dir) PLUS a hash of the FULL,
// untruncated cwd (for uniqueness) — the hash is what actually decides collisions.
function projectSlug(cwd) {
  const c = String(cwd || 'unknown')
  const readable = c.replace(/[^A-Za-z0-9]/g, '-').slice(0, 120)
  const hash = createHash('sha1').update(c).digest('hex').slice(0, 12)
  return `${readable}-${hash}`
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

// FAIL OPEN, ALWAYS. A guard that cannot read its inputs must let the turn end.
function bail() {
  process.exit(0)
}

const input = readStdin()
const transcriptPath = input.transcript_path
const sessionId = input.session_id || 'unknown'
const cwd = input.cwd || process.cwd()
if (!transcriptPath || !existsSync(transcriptPath)) bail()

// --- 1. Is work in flight? --------------------------------------------------------------
// A delegated agent writes to <session>/subagents/agent-*.jsonl. A recent write there means the
// arc is alive and stopping is just yielding between turns — never a decision to stop.
// ⚠ This reads the SUBAGENTS dir, never the session's own transcript: the session's own file is
// touched by this very turn, so it would always look "active" and the guard could never fire.
const subagentsDir = join(dirname(transcriptPath), sessionId, 'subagents')
try {
  const cutoff = Date.now() - INFLIGHT_MIN * 60_000
  for (const f of readdirSync(subagentsDir)) {
    if (!f.endsWith('.jsonl')) continue
    if (statSync(join(subagentsDir, f)).mtimeMs >= cutoff) bail() // something is running
  }
} catch {
  /* no subagents dir yet — nothing in flight, keep going */
}

// --- 2. Does this project have a tracker wired to this guard at all? ---------------------
// ⚠ THE ABSTRACTION POINT — see the header. No marker ever written ⇒ silent, permanently, for
// this project. This is a plain existence check, never a tool-name match: it works identically
// whatever wrote the marker.
const SNAPSHOT = join(STATE_DIR, `queue-${projectSlug(cwd)}.json`)
if (!existsSync(SNAPSHOT)) bail()

// --- 3. Is there open work? ---------------------------------------------------------------
// A marker that exists but is unreadable or older than SNAPSHOT_MAX_AGE_MIN counts as "work
// remains" (FAIL-CLOSED — see header). Only a snapshot that is BOTH readable AND fresh AND
// reports open:0 silences this guard.
let openCount = null
let nextItem = ''
try {
  const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
  const age = Date.now() - (snap.at || 0)
  // ⚠ `Number(snap.open)` alone was wrong — found by cross-family review. `Number('')`,
  // `Number(null)`, and `Number(false)` all coerce to 0, so a fresh but MALFORMED snapshot
  // (a truncated write, a wrong field type) would silently read as "queue empty" and bail —
  // exactly the fail-OPEN this section's own comment says never to allow. Only a genuine
  // non-negative finite NUMBER counts; anything else falls through with openCount left null,
  // which is the same "unknown ⇒ work remains" fail-closed path as an unreadable/stale file.
  const rawOpen = snap.open
  const isValidOpen = typeof rawOpen === 'number' && Number.isFinite(rawOpen) && rawOpen >= 0
  if (age <= SNAPSHOT_MAX_AGE_MIN * 60_000 && isValidOpen) {
    openCount = rawOpen
    nextItem = String(snap.next || '')
  }
} catch {
  /* marker exists but is unreadable/corrupt — treated as "work remains", see FAIL-CLOSED above */
}
if (openCount === 0) bail() // the queue really is empty — stopping needs no justification

// --- 4. Anti-loop / frequency ceiling ------------------------------------------------------
// ⚠ Keyed by session AND project (not session alone) — found by cross-family review: a bare
// session_id key would let a block recorded under one project's cooldown silence a DIFFERENT
// project sharing the same session_id. session_id is normally unique per session per project
// for its whole lifetime, so this was low-probability, but the fix is free.
const stateFile = join(
  STATE_DIR,
  `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '-')}-${projectSlug(cwd)}.json`,
)
let last = 0
try {
  last = JSON.parse(readFileSync(stateFile, 'utf8')).lastBlockedAt || 0
} catch {
  /* first time */
}
if (Date.now() - last < COOLDOWN_MIN * 60_000) bail()

try {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(stateFile, JSON.stringify({ lastBlockedAt: Date.now() }), 'utf8')
} catch {
  bail() // cannot record the block ⇒ cannot bound it ⇒ do not block at all
}

process.stderr.write(
  [
    "⚠ YOU ARE STOPPING WHILE WORK REMAINS AND NOTHING IS RUNNING.",
    openCount === null
      ? '  queue: UNKNOWN state (no recent marker) — treated as NOT EMPTY.'
      : `  queue: ${openCount} open item(s).`,
    nextItem ? `  next: ${nextItem}` : '',
    '',
    "This guard does not check whether you LOOKED at the queue — it checks whether you are",
    'ending a turn to REPORT while work continues. A report is the end of a turn, and the end',
    "of a turn is a full stop: nothing resumes until the user speaks again.",
    '',
    'So: CONTINUE in THIS turn (take the next item), or STATE why you are stopping. This guard',
    'never judges the reason; it only makes it impossible to give none.',
    '',
    `Stop again and the turn passes: this blocks at most once per ${COOLDOWN_MIN} min.`,
  ].filter(Boolean).join('\n'),
)
process.exit(2)
