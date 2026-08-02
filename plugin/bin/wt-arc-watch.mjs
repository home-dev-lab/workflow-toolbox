#!/usr/bin/env node
// Delegated-arc watcher, shipped as a plugin monitor.
//
// WHAT IT WATCHES: the subagent transcripts of the CURRENT project's sessions.
// It emits only on TERMINAL states — a transcript that stopped growing, or one
// that disappeared. It stays silent while agents are writing, so its silence
// means "everyone is still working", which is a checkable claim.
//
// WHY A MONITOR AND NOT A REMINDER: a delegated agent that dies to a quota wall,
// a lost turn, or a crash produces NO completion event. Transcript staleness is
// the one signal that always fires. Model-token cost of this watcher: zero.
//
// ⚠ STALENESS DETECTS SILENCE, NOT DEATH. An agent legitimately waiting on a
// background executor writes nothing while it waits, which looks identical to a
// dead one. Treat a STALE line as an observation to check, never as a verdict.
//
// Every line goes to STDOUT: the monitor mechanism reads stdout only, so a
// failure written to stderr would be indistinguishable from this watcher never
// having been armed.
//
// GATED ON THIS SESSION'S OWN FIRST DELEGATION, not on session start. The
// manifest can only declare `"when": "always"` — Claude Code's monitor schema
// accepts no other trigger (confirmed against the installed CLI: `when` is
// `"always"` or `"on-skill-invoke:<skill>"`, and delegation is not a skill
// invocation) — so every session that loads this plugin used to start this
// watcher, including a read-only relay that never spawns a subagent and can
// do nothing with a STALE/GONE event. A relay measured 2026-07-30 armed
// before it even received its own role.
//
// The fix does not try to answer "am I a main session?" — that information
// does not exist yet when the manifest runs, so no heuristic can read it
// (the relay above proved this: its role arrived AFTER the ARMED banner).
// Instead it answers a question that IS observable: "has THIS session
// delegated anything yet?" The process starts immediately either way (so a
// session that delegates within the gate's poll interval is never at risk of
// missing coverage), but withholds every stdout line — including the ARMED
// banner itself — until this session's own subagent transcript directory
// (keyed by CLAUDE_CODE_SESSION_ID, present in this process's own env) shows
// at least one transcript. A session that never delegates then never emits
// anything, for its whole lifetime, without ever risking the failure mode
// that matters most: it NEVER self-terminates while waiting, so a session
// that delegates an hour in is still covered — unlike a fixed-idle-timeout
// self-exit would be, since nothing rearms a monitor mid-session once it has
// exited (monitors only (re)arm at session start or plugin reload).

import { lstat, readdir } from 'node:fs/promises'
import { writeSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { isServiceDegraded } from './lib/service-flag.mjs'
import { hasRecordedStop, lastStopTimestamps } from './lib/stop-correlation.mjs'

const MAX_TIMER_MS = 0x7fffffff
const MAX_POLL_SECONDS = Math.floor(MAX_TIMER_MS / 1_000)
const MAX_STALE_MINUTES = Math.floor(MAX_TIMER_MS / 60_000)

// Set once per poll (see the main loop) from the shared service-degraded flag
// (see plugin/bin/wt-service-watch.mjs). While true, `write()` drops every
// line — but ONLY the emission: every Set/Map this file tracks (transcripts,
// announced-* sets, reports) keeps updating underneath exactly as it always
// has. That is what makes recovery backlog-free — nothing is queued during
// the blackout, so lifting the flag just resumes normal diffing from
// whatever the state already is, instead of dumping everything that was
// suppressed.
let suppressEmission = false

function write(line) {
  if (suppressEmission) return
  process.stdout.write(`${line}\n`)
}

process.stdout.on('error', () => {
  // ANY stdout error ends the watch. Staying alive on a broken channel is the
  // worst outcome available: the process looks healthy while every subsequent
  // event is written into the void. Exiting is observable; silent survival is not.
  process.exit(0)
})

// A filename reaches stdout, and one stdout line is one notification. A name
// containing a newline would forge a second, fabricated event; a long name would
// drown the line. Control characters are stripped, not escaped, and the result is
// bounded.
function safeName(name) {
  const flat = String(name).replace(/[\p{Cc}\p{Cf}]/gu, '?')
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat
}

// Paths and error text are echoed back to the user, so scrub anything that
// looks like a credential and flatten newlines (one event must stay one line).
function redact(text) {
  return String(text)
    .replace(/[A-Za-z0-9_.-]*[A-Za-z0-9][A-Za-z0-9_.-]{15,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<redacted>' : m))
    .replace(/(bearer|token|authorization|api[-_ ]?key|secret)\s*[:=]?\s*\S+/gi, '$1 <redacted>')
    .replace(/[\r\n]+/g, ' ')
}

// writeSync + exit: a callback-based exit is ASYNC, so execution would continue
// past the failure and emit further, contradictory lines. The write is guarded:
// on a closed stdout it would throw, and an uncaught throw here would replace a
// clear failure line with a stack trace.
function fail(detail, code) {
  try {
    writeSync(1, `ARC WATCH FAILED: ${detail}\n`)
  } catch {
    // Nothing can be reported; the exit code is the only remaining signal.
  }
  process.exit(code)
}

function readNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

let staleMinutes = 10
let pollSeconds = 60
let projectDir = process.cwd()
let reportsDir = ''

for (let i = 2; i < process.argv.length; i += 2) {
  const option = process.argv[i]
  const raw = process.argv[i + 1]
  // An option name is never a value. Without this, `--project --poll` silently
  // sets the project to "--poll" and the watcher starts up watching nothing,
  // which is the failure this whole file exists to make impossible.
  const value = typeof raw === 'string' && raw.startsWith('--') ? undefined : raw
  // Argument text can carry a secret (a token pasted into a path). Diagnostics
  // echo it back to stdout, so it goes through the same scrubbing as everything else.
  const shown = value === undefined ? '(missing)' : redact(value)
  if (option === '--project') {
    if (!value) fail(`missing value for --project (got ${shown})`, 2)
    projectDir = value
  } else if (option === '--reports') {
    if (!value) fail(`missing value for --reports (got ${shown})`, 2)
    reportsDir = value
  } else if (option === '--stale') {
    const n = readNumber(value)
    if (n === null || n > MAX_STALE_MINUTES) fail(`invalid --stale (maximum ${MAX_STALE_MINUTES}min): ${shown}`, 2)
    staleMinutes = n
  } else if (option === '--poll') {
    const n = readNumber(value)
    if (n === null || n > MAX_POLL_SECONDS) fail(`invalid --poll (maximum ${MAX_POLL_SECONDS}s): ${shown}`, 2)
    pollSeconds = n
  } else {
    fail(`unknown option: ${redact(option)}`, 2)
  }
}

// poll=0 would spin a tight loop re-reading directories continuously.
if (pollSeconds < 5) fail(`invalid --poll (minimum 5s): ${pollSeconds}`, 2)

// The harness stores a project's sessions under a slug built from the project's
// absolute path with every character outside [A-Za-z0-9-] replaced by '-'.
function projectSlug(dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
const sessionsRoot = path.join(configDir, 'projects', projectSlug(projectDir))

// ⚠ DISCRIMINATOR — cards 1829924641678820839 + 1832820166895863516. Measured on 2026-08-02
// across 422+ real spawn records (three independent audits, including a disposable headless bench
// that produced an ACCIDENTAL genuine kill — an agent terminated mid-generation by a content-
// filter API error, zero stop/nudged records, contrasted against a control agent in the same mode
// that produced two clean stop records seconds apart): the dominant cause of a stale-but-alive
// transcript is either legitimate idle-between-turns (proven live: agent a1f5eb82662eb4d75,
// repeated stop/resume cycles, a STALE alert landing inside one of its idle gaps) or a NAME
// correlation miss (s-fence-125: the stop record's `name` carries the underlying subagent_type,
// not the explicit spawn name). Before emitting STALE, corroborate against the outbound-guard
// journal wt-outbound-guard-hook.mjs already writes on every SubagentStop — if a stop record
// AT OR AFTER this transcript's last write accounts for it (by name OR by agentType, see
// lib/stop-correlation.mjs), the silence is benign and nothing is emitted.
//
// ⚠⚠ WHY "AT OR AFTER", NOT MERELY "A STOP RECORD EXISTS SOMEWHERE IN THIS AGENT'S HISTORY". The
// same bench proved a single agent produces ONE stop record PER TURN BOUNDARY, not one per agent
// lifetime (838 stop events / 380 agents measured elsewhere, ~2.2 per agent). A discriminator that
// matched on "any past stop record for this name" would wrongly suppress an agent that stopped
// cleanly on an earlier turn and then died mid-turn on a LATER one — an old, already-resumed stop
// proves nothing about the CURRENT silence. lib/stop-correlation.mjs's hasRecordedStop() takes
// this transcript's own last-write time and only accepts a stop record timestamped at or after it
// (minus a small tolerance for write-then-hook-fires ordering).
//
// ⚠ FAILS TOWARD EMITTING, NEVER TOWARD SILENCE. A journal that cannot be read (missing,
// malformed, wrong permissions) must never be read as "accounted for" — that would suppress the
// exact death case this watcher exists to catch. Only a POSITIVE, TIME-RELEVANT match suppresses;
// every read failure, absent match, or stale-but-irrelevant old match falls through to the
// ordinary STALE line, unchanged.
const OUTBOUND_GUARD_DIR = process.env.WT_OUTBOUND_GUARD_DIR
  || path.join(homedir(), '.local', 'state', 'wt-outbound-guard')

function loadLastStopTimestamps(sessionName) {
  try {
    const raw = readFileSync(path.join(OUTBOUND_GUARD_DIR, `${sessionName}.jsonl`), 'utf8')
    const records = raw.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
    return lastStopTimestamps(records)
  } catch {
    return null // unreadable/missing journal — cannot corroborate, caller falls through to STALE
  }
}

function readTranscriptMeta(sessionName, transcriptFile) {
  try {
    const metaPath = path.join(sessionsRoot, sessionName, 'subagents', transcriptFile.replace(/\.jsonl$/, '.meta.json'))
    return JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch {
    return null
  }
}

// ⚠⚠⚠ WHY THIS READS THE TRANSCRIPT'S OWN CONTENT, NOT THE FILE'S mtime — the THIRD correction on
// this discriminator, from an independent measurement done AFTER the timestamp-aware fix already
// shipped with mtime as its anchor. Measured on 2026-08-02, the SAME 325 (stop, transcript) pairs,
// two instruments:
//   anchored on file MTIME    : 217/325 negative (stop "before" mtime), worst -46.4s
//   anchored on the transcript's OWN last-record `timestamp` field : 45-46/325 negative, worst
//     -46.3s (this pilot's own re-run: 46/325, worst -106.9s — the journal kept growing between
//     the two measurements; both runs agree on the shape that matters, see below)
// mtime overstated the negative population by ~4.8x: a FILESYSTEM property was being used to
// answer a question about when the agent last recorded a turn — the same error class as every
// other wrong-instrument case catalogued in this fix's history. Using mtime as the anchor with a
// small backward tolerance would have WRONGLY rejected the ~170 benign cases where mtime merely
// lags the true last-turn time, flooding the channel with exactly the false STALE alerts this fix
// exists to remove. The transcript's own last-record timestamp is the right anchor; mtime is kept
// ONLY as the fallback when the transcript is unreadable (fails toward the ORIGINAL, weaker
// behavior — still safe, since the original behavior was "always alert").
//
// SHAPE CHECK (why a small tolerance is safe on the true-anchor side): both measurements' negative
// populations have NO cluster near zero — this pilot's own sorted list of 46 negatives has its
// nearest-to-zero value at -2.79s, nothing between -2.79s and 0. So BACKWARD_TOLERANCE_MS well
// under that gap (1s, see lib/stop-correlation.mjs) cleanly separates genuine cross-process clock/
// ordering skew (the hook is written by a different process than the transcript) from a real
// unaccounted later turn.
function lastRecordTimestampMs(sessionName, transcriptFile) {
  try {
    const raw = readFileSync(path.join(sessionsRoot, sessionName, 'subagents', transcriptFile), 'utf8')
    let best = null
    for (const line of raw.split('\n')) {
      if (!line) continue
      let r
      try { r = JSON.parse(line) } catch { continue }
      for (const key of ['timestamp', 'at', 'ts', 'createdAt', 'time']) {
        const v = r?.[key]
        if (typeof v === 'string' && v.length >= 20) {
          const t = Date.parse(v)
          if (Number.isFinite(t) && (best === null || t > best)) best = t
          break
        }
      }
    }
    return best
  } catch {
    return null
  }
}

// Transcript filenames are `agent-<rawId>.jsonl` — the SAME raw id the outbound-guard journal
// records as `stop.agentId` (verified byte-identical against a real record; see the CORRECTION 4
// note in lib/stop-correlation.mjs). Extracted here, once, so isAccountedForByStop can offer it
// as the first, least-ambiguous correlation candidate.
const TRANSCRIPT_RAW_ID_RE = /^agent-(.+)\.jsonl$/

// `name` here is the `${sessionId}/${transcriptFile}` key used throughout this watcher's maps.
// `modifiedAt` (file mtime) is the FALLBACK anchor only — the transcript's own last-record
// timestamp is preferred (see the note above on why mtime is the wrong instrument for this).
function isAccountedForByStop(name, modifiedAt) {
  const slash = name.indexOf('/')
  if (slash < 0) return false
  const sessionName = name.slice(0, slash)
  const transcriptFile = name.slice(slash + 1)
  const stops = loadLastStopTimestamps(sessionName)
  if (!stops) return false // journal unreadable — never suppress on an unreadable source
  const meta = readTranscriptMeta(sessionName, transcriptFile)
  const anchorMs = lastRecordTimestampMs(sessionName, transcriptFile) ?? modifiedAt
  const rawId = TRANSCRIPT_RAW_ID_RE.exec(transcriptFile)?.[1]
  return hasRecordedStop(stops, meta, anchorMs, rawId)
}

// The gate this file's header describes: has THIS session (identified by the
// env var the harness sets on every process it spawns, monitors included)
// delegated at least once? `currentSessionId` empty means the check cannot be
// made — fail toward coverage (arm immediately) rather than toward silence.
const currentSessionId = process.env.CLAUDE_CODE_SESSION_ID || ''
const GATE_POLL_MS = Math.min(pollSeconds * 1000, 30_000)

async function ownSessionHasDelegated() {
  if (!currentSessionId) return true
  try {
    const entries = await readdir(path.join(sessionsRoot, currentSessionId, 'subagents'), { withFileTypes: true })
    return entries.some((entry) => entry.isFile() && /^agent-.+\.jsonl$/.test(entry.name))
  } catch (error) {
    // No subagents dir yet is the normal "hasn't delegated" case. Any other
    // error (permissions, a transient mount blip) must not block arming
    // behind a check that cannot be answered — fail toward coverage.
    if (error?.code === 'ENOENT') return false
    return true
  }
}

while (!(await ownSessionHasDelegated())) {
  await wait(GATE_POLL_MS)
}

// Transcripts live at <sessionsRoot>/<sessionId>/subagents/agent-*.jsonl. The
// session ids are not known in advance, so each pass re-enumerates them: a
// session started AFTER this watcher was armed must be covered too.
// `complete` is the honest half of the result. An INCOMPLETE scan must never be
// read as "everything vanished": a config sync or a mount blip that removes the
// sessions root for one pass would otherwise announce GONE for every transcript
// at once — hundreds of lines, monitor auto-stopped, silence. An absent root is
// only genuine emptiness the FIRST time; once observed, its disappearance is
// uncertainty, not news.
let rootEverObserved = false

async function transcripts() {
  const found = new Map()
  let sessions
  try {
    sessions = await readdir(sessionsRoot, { withFileTypes: true })
    rootEverObserved = true
  } catch (error) {
    if (error?.code === 'ENOENT') return { found, complete: !rootEverObserved }
    throw error
  }
  let complete = true
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const dir = path.join(sessionsRoot, session.name, 'subagents')
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      // A session without a subagents dir is normal; anything else means this
      // session's transcripts could not be enumerated, so the scan is partial.
      if (error?.code === 'ENOENT') continue
      complete = false
      continue
    }
    for (const entry of entries) {
      if (!/^agent-.+\.jsonl$/.test(entry.name)) continue
      try {
        // lstat, not stat: a symlink is not followed. Following one would let a
        // link point the watcher at arbitrary files outside the watched tree.
        const info = await lstat(path.join(dir, entry.name))
        if (info.isFile()) found.set(`${session.name}/${entry.name}`, info.mtimeMs)
      } catch (error) {
        // Removed between readdir and lstat: absent for this pass, not a failure.
        if (error?.code !== 'ENOENT') complete = false
      }
    }
  }
  return { found, complete }
}

async function reportFiles() {
  const found = new Set()
  if (!reportsDir) return found
  const entries = await readdir(reportsDir, { withFileTypes: true })
  for (const entry of entries) {
    try {
      if ((await lstat(path.join(reportsDir, entry.name))).isFile()) found.add(entry.name)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return found
}

let previousTranscripts
let previousComplete = true
try {
  const initial = await transcripts()
  previousTranscripts = initial.found
  previousComplete = initial.complete
} catch (error) {
  fail(`sessions directory unreadable: ${redact(sessionsRoot)} (${redact(error?.message ?? error)})`, 1)
}

let previousReports = new Set()
if (reportsDir) {
  try {
    previousReports = await reportFiles()
  } catch (error) {
    fail(`reports directory unreadable: ${redact(reportsDir)} (${redact(error?.message ?? error)})`, 1)
  }
}

const announcedStale = new Set()
const announcedGone = new Set()
const announcedFuture = new Set()
// Reports present at arming are already known to the user; only NEW ones matter.
const announcedReports = new Set(previousReports)
const degraded = new Set()
const staleMs = staleMinutes * 60_000

// No single poll may emit more than this. A monitor that floods its channel is
// auto-stopped by the host, and a stopped monitor is silent — the exact failure
// this watcher exists to prevent. Past the cap, the remainder is COUNTED and
// announced as one line, so the events are never silently dropped.
const MAX_EVENTS_PER_POLL = 20

function makeBudget() {
  let spent = 0
  let suppressed = 0
  return {
    emit(line) {
      if (spent < MAX_EVENTS_PER_POLL) {
        spent += 1
        write(line)
      } else {
        suppressed += 1
      }
    },
    close() {
      if (suppressed > 0) write(`ARC WATCH TRUNCATED: ${suppressed} further event(s) this poll were counted, not listed`)
    },
  }
}

// Transcripts ALREADY stale when the watcher is armed are not tracked as events:
// they are almost always finished agents from past sessions, and announcing them
// individually floods the channel (472 such directories on the machine this was
// written for). They are NOT hidden either — the count is stated once, so a reader
// who expected zero can go look. This is the middle of two failure modes that were
// both observed: seeding with EVERY present transcript makes STALE unreachable for
// the agents already working at arming (the normal case, watcher silent forever);
// seeding with NOTHING floods at arming and the monitor is stopped. A transcript
// alive at arming that later goes quiet still fires, which is the case that matters.
// The same set also suppresses GONE for those transcripts, and that is not an
// optimisation — it is the same principle applied to the other event. This watcher
// covers EVERY session of the project (thousands of transcripts on a long-lived
// one), so ordinary retention cleanup of old sessions deletes transcripts by the
// directory-full. Reporting those as GONE is technically true and practically
// misleading: it looks like agents dying, and it buries the one death that matters.
// A transcript that was alive at arming and then vanishes is still reported.
const preexistingSilent = new Set()
{
  const armedAt = Date.now()
  for (const [name, modifiedAt] of previousTranscripts) {
    if (modifiedAt <= armedAt && armedAt - modifiedAt >= staleMs) {
      announcedStale.add(name)
      preexistingSilent.add(name)
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Checked before the very first line too — a service outage already live at
// arming time must suppress the ARMED banner exactly like every later line.
suppressEmission = Boolean(await isServiceDegraded())

write(`ARC WATCH ARMED: stale=${staleMinutes}min poll=${pollSeconds}s tracking=${previousTranscripts.size} transcript(s)`)
if (announcedStale.size > 0) {
  write(`ARC WATCH BASELINE: ${announcedStale.size} transcript(s) were already silent at arming and are not tracked`)
}
if (!previousComplete) {
  write('ARC WATCH DEGRADED: the initial scan was incomplete — disappearance reporting starts from a partial baseline')
}

while (true) {
  // Re-checked every poll: a service outage can start or end between polls,
  // and the flag itself expires — a stale read would either blind this
  // watcher past the outage or resume it too early. Only emission is gated
  // (see `write()` above); the scan below still runs unconditionally.
  suppressEmission = Boolean(await isServiceDegraded())

  let currentTranscripts
  let currentComplete = true
  let currentReports
  const failures = []

  try {
    const scan = await transcripts()
    currentTranscripts = scan.found
    currentComplete = scan.complete
  } catch (error) {
    failures.push([sessionsRoot, error])
  }

  if (reportsDir) {
    try {
      currentReports = await reportFiles()
    } catch (error) {
      failures.push([reportsDir, error])
    }
  }

  // One notice per directory, not one per cycle: repeating would flood the
  // channel and get the monitor auto-stopped, manufacturing the very silence
  // this watcher exists to remove.
  for (const [dir, error] of failures) {
    if (degraded.has(dir)) continue
    write(`ARC WATCH DEGRADED: ${redact(dir)} (${redact(error?.message ?? error)})`)
    degraded.add(dir)
  }

  const budget = makeBudget()

  if (currentTranscripts) {
    // ⚠ An INCOMPLETE scan cannot support a disappearance claim. A transient
    // unreadable directory would otherwise turn every known transcript into a
    // GONE event at once. Absence of evidence is not evidence of absence.
    if (currentComplete) {
      for (const name of previousTranscripts.keys()) {
        if (currentTranscripts.has(name)) continue
        // Already silent before this watch began: its deletion is cleanup, not death.
        if (!announcedGone.has(name) && !preexistingSilent.has(name)) {
          budget.emit(`GONE: ${safeName(name)} — the transcript no longer exists`)
          announcedGone.add(name)
        }
        announcedStale.delete(name)
        announcedFuture.delete(name)
        preexistingSilent.delete(name)
      }
    } else if (!degraded.has(sessionsRoot)) {
      write('ARC WATCH DEGRADED: partial scan — disappearances not reported this poll')
      degraded.add(sessionsRoot)
    }

    const now = Date.now()
    for (const [name, modifiedAt] of currentTranscripts) {
      announcedGone.delete(name)
      const previous = previousTranscripts.get(name)
      // A fresh write re-arms STALE: a second silent period is a second event.
      if (previous !== undefined && previous !== modifiedAt) announcedStale.delete(name)
      if (modifiedAt > now) {
        // A future mtime makes (now - modifiedAt) negative, which would suppress
        // STALE indefinitely. Say so rather than going quiet.
        if (!announcedFuture.has(name)) {
          budget.emit(`FUTURE TIMESTAMP: ${safeName(name)} — modification time is in the future`)
          announcedFuture.add(name)
        }
        continue
      }
      announcedFuture.delete(name)
      // ⚠⚠ ORDERING IS LOAD-BEARING, VERIFIED ON REQUEST — do not reorder this `if`. The mtime
      // staleness gate (`now - modifiedAt >= staleMs`) MUST run and short-circuit BEFORE
      // isAccountedForByStop() is ever called. A live, currently-working agent has a FRESH mtime
      // (its transcript is actively growing), so it never satisfies this gate at all and
      // isAccountedForByStop() is never reached for it — this is what stops a live agent with an
      // OLD last-stop record (e.g. deep into a long-running multi-turn mandate) from being wrongly
      // matched by that stale stop and reported. The discriminator's own anchor (the transcript's
      // last-record timestamp, see isAccountedForByStop) is a SEPARATE, later check that only ever
      // runs on an agent already judged stale by THIS gate — moving the discriminator ahead of, or
      // independent of, this condition would let a live agent's old stop satisfy it and misreport
      // a working agent as accounted-for-and-silenced instead of correctly never being asked about.
      if (now - modifiedAt >= staleMs && !announcedStale.has(name)) {
        // Corroborate before alerting: a recorded SubagentStop (by name or by agentType) means
        // this agent's last turn ended cleanly — idle-between-turns or a benign shutdown, not a
        // silent death. See the DISCRIMINATOR block above for the evidence and the fail-toward-
        // emitting guarantee. `announcedStale` is still marked either way, so a suppressed entry
        // is not re-checked every poll — only a fresh write (which clears it above) re-arms it.
        if (!isAccountedForByStop(name, modifiedAt)) {
          budget.emit(`STALE: ${safeName(name)} — no write for ${staleMinutes}+ min`)
        }
        announcedStale.add(name)
      }
    }

    // Only a COMPLETE scan may become the new baseline; adopting a partial one
    // would make the missing entries look like they had never existed.
    if (currentComplete) previousTranscripts = currentTranscripts
  }

  if (currentReports) {
    for (const name of previousReports) {
      if (!currentReports.has(name)) announcedReports.delete(name)
    }
    for (const name of currentReports) {
      if (previousReports.has(name) || announcedReports.has(name)) continue
      budget.emit(`REPORT: ${safeName(name)}`)
      announcedReports.add(name)
    }
    previousReports = currentReports
  }

  budget.close()

  if (failures.length === 0) degraded.clear()
  await wait(pollSeconds * 1_000)
}
