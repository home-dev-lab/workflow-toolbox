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
//   1. It merely PRINTS a reminder → ignorable → a hope with a filename. So it BLOCKS (see the
//      emission-shape comment near the bottom of this file for exactly how).
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
// OPTIONAL "IS WORKING EVEN POSSIBLE" FIELDS on the SAME marker — observed on an adopter's own
// machine: this hook shouted through a spent usage window and a saturated context alike, both
// conditions where nothing could act on the queue it kept naming —
// this hook must NOT shout about a queue nobody can act on right now (an exhausted usage window,
// a saturated context that can no longer safely verify a result, an unreachable dependency). It
// also must NOT go silent just because the constraint is merely tight — a resource limit is a
// door, not a loss, and stopping early while capacity remains is precisely the fault this class
// of guard exists to catch. So this hook never probes a provider itself (that would make a
// tracker-agnostic hook specific to one vendor) — it only respects a signal from whatever DOES
// know, written onto the same marker:
//   workPossible: false        — set ONLY on a condition that makes ALL further work genuinely
//                                 impossible right now, never on "getting tight". Absent, or
//                                 true, means no opinion — normal behavior, unaffected.
//   workBlockedUntil: <epoch-ms> — REQUIRED alongside workPossible:false. The self-expiring
//                                 deadline past which the block is assumed lifted (a quota
//                                 reset time, or a short conservative re-check window for a
//                                 transient condition like context saturation). A block with no
//                                 valid future workBlockedUntil is ignored — malformed input
//                                 must fail CLOSED (keep shouting), never silence the guard.
//   workBlockedReason: "<string>" — optional, human-readable; this hook never prints it (see
//                                 next paragraph) — it exists for whoever inspects the marker.
// When active and unexpired, this hook goes SILENT — not a softer message, nothing at all. When
// nothing can be decided, there is nothing to say; a quieter warning here would be the same
// noise in a quieter costume. Writing these fields is entirely the adopter's own business: which
// provider, which threshold counts as "exhausted" vs "just low", how staleness/context-saturation
// is measured — none of that belongs in a tracker-agnostic hook.
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
// RESIDUAL BLIND SPOT: this hook can only respect a "work is impossible" signal it is TOLD —
// via workPossible/workBlockedUntil above — it never detects an exhausted window or a saturated
// context on its own. An adopter who wires nothing to those fields gets the exact prior
// behavior: the hook still cannot tell "stopping for no reason" from "cannot work right now".
// State this in any adopter-facing note.
//
// Ship / keep-private: this file IS the shipped, generalized copy, ported from a private,
// single-project original (that copy stays wired at PROJECT scope, never machine-wide — a
// project with no tracker at all must never inherit a guard it cannot satisfy).
//
// ⚠ SUPERSEDED, KEPT FOR BACKWARD COMPATIBILITY — this file is deliberately NOT wired into
// plugin.json's Stop hooks array. It was replaced there by wt-actionable-gate-hook.mjs, a
// consecutive-block, tracker-agnostic successor with the same silent-block emission shape. This
// file was restored after a deletion attempt broke live sessions whose own settings.json still
// references it directly by path — an adopter migrating off it should point their Stop hook at
// wt-actionable-gate-hook.mjs instead. It still gets the same noise fix here because a
// still-shipped, still-invocable file is still a defect for whoever invokes it.

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const STATE_DIR = process.env.WT_QUEUE_GATE_DIR
  || join(homedir(), '.local', 'state', 'wt-queue-gate')
const HELP_PATH = new URL('wt-queue-not-empty-gate-hook.help.md', import.meta.url).pathname
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
// ⚠ A COUNT WITHOUT ITS AGE READS AS CURRENT. This snapshot is refreshed only when something
// actually reads the queue, so a session that closes several items without re-reading it is
// shown the pre-closure number — accurate when it was measured, wrong now, and indistinguishable
// from fresh. The age is already computed below to decide staleness; carrying it into the
// message costs nothing and stops the number from lying by omission.
let snapshotAgeMin = null
try {
  const snap = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))

  // --- 3a. Is working even possible right now? -------------------------------------------
  // See the "IS WORKING EVEN POSSIBLE" header section. Strict on both fields — a malformed or
  // missing workBlockedUntil must fail CLOSED (keep shouting), never silence the guard. Checked
  // BEFORE the openCount logic below: a genuine block silences regardless of how many items are
  // open, and it does NOT borrow the open/next freshness window — it lives and dies by its own
  // deadline, so a condition that clears exactly at a known time (a quota reset) clears exactly
  // then, not up to two hours later.
  const until = snap.workBlockedUntil
  const validDeadline = typeof until === 'number' && Number.isFinite(until)
  if (snap.workPossible === false && validDeadline && Date.now() < until) bail()

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
    snapshotAgeMin = Math.round(age / 60_000)
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

// Emission shape — three exist for a Stop hook; this is a deliberate choice among them, not the
// original one. Grounded against the official hook docs (2026-08-06) AND a direct terminal
// measurement, because the two disagree on one point:
//   1. stderr + exit 2                                    — blocks; renders to BOTH the model
//                                                            AND the user's terminal transcript.
//                                                            This is what this hook used to do,
//                                                            and it is the noisiest form.
//   2. stdout {"decision":"block","reason":...} + exit 0  — blocks; the docs describe `reason`
//                                                            as context fed to the model, not a
//                                                            user-facing message — but a direct
//                                                            terminal measurement on this harness
//                                                            (the sibling actionability gate, and
//                                                            this project's own private copy)
//                                                            showed `reason` STILL renders to the
//                                                            user as a "<hook> hook error". The
//                                                            measurement wins over the doc's
//                                                            paraphrase here.
//   3. stdout {"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":...}} + exit 0
//                                                          — blocks (docs: "the conversation
//                                                            continues so Claude can act on the
//                                                            feedback"), and ALSO renders to the
//                                                            user, as a "<hook> hook feedback".
//                                                            Different label from shape 2, same
//                                                            visibility.
//   3 + {"suppressOutput": true}                           — blocks, and reaches NOBODY: not the
//                                                            user, and not the model either.
//
// ⚠ An earlier version of this comment claimed shape 3 was silent for the user, citing the docs'
// "doesn't appear as a chat message in the interface" as agreeing with measurement. That was
// WRONG, and it was wrong in the most expensive way — a doc sentence read as a measurement. Under
// direct observation on a real terminal (2026-08-06) shape 3 renders, and `suppressOutput` then
// hides it from the model too, which is strictly worse than noise: a refused turn nobody can
// explain.
//
// So: there is NO shape that reaches the model while sparing the user. LENGTH is the only lever
// anyone has demonstrated, which is why the message below is ONE line and everything else lives
// in HELP_PATH. Do not grow it back, and do not re-derive a quieter shape from the documentation
// — that path has now been walked twice and cost the user two rounds of noise.
//
// The phrasing stays FACTUAL rather than imperative: text framed as an out-of-band command can
// trigger the model's own prompt-injection defenses and be resurfaced to the user anyway.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      // ⚠ The UNKNOWN case must stay distinguishable from a known count. Squeezing it out to
      // save characters was caught by the suite: a reader could no longer tell "nobody measured
      // the queue" from "the queue is small", which is the whole reason the gate assumes
      // non-empty in that state.
      additionalContext:
        `open work remains, nothing running · ` +
        (openCount === null ? 'Queue size is unknown (stale snapshot)' : `${openCount} open`) +
        `${nextItem ? ` · next: ${nextItem}` : ''} — chain or say why · ${HELP_PATH}`,
    },
  }),
)
process.exit(0)
