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

import { lstat, readdir } from 'node:fs/promises'
import { writeSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const MAX_TIMER_MS = 0x7fffffff
const MAX_POLL_SECONDS = Math.floor(MAX_TIMER_MS / 1_000)
const MAX_STALE_MINUTES = Math.floor(MAX_TIMER_MS / 60_000)

function write(line) {
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
{
  const armedAt = Date.now()
  for (const [name, modifiedAt] of previousTranscripts) {
    if (modifiedAt <= armedAt && armedAt - modifiedAt >= staleMs) announcedStale.add(name)
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

write(`ARC WATCH ARMED: stale=${staleMinutes}min poll=${pollSeconds}s tracking=${previousTranscripts.size} transcript(s)`)
if (announcedStale.size > 0) {
  write(`ARC WATCH BASELINE: ${announcedStale.size} transcript(s) were already silent at arming and are not tracked`)
}
if (!previousComplete) {
  write('ARC WATCH DEGRADED: the initial scan was incomplete — disappearance reporting starts from a partial baseline')
}

while (true) {
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
        if (!announcedGone.has(name)) {
          budget.emit(`GONE: ${safeName(name)} — the transcript no longer exists`)
          announcedGone.add(name)
        }
        announcedStale.delete(name)
        announcedFuture.delete(name)
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
      if (now - modifiedAt >= staleMs && !announcedStale.has(name)) {
        budget.emit(`STALE: ${safeName(name)} — no write for ${staleMinutes}+ min`)
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
