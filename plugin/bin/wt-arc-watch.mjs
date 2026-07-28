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

import { readdir, stat } from 'node:fs/promises'
import { writeSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const MAX_TIMER_MS = 0x7fffffff
const MAX_POLL_SECONDS = Math.floor(MAX_TIMER_MS / 1_000)
const MAX_STALE_MINUTES = Math.floor(MAX_TIMER_MS / 60_000)

function write(line) {
  process.stdout.write(`${line}\n`)
}

process.stdout.on('error', (error) => {
  // The notification channel is gone; continuing could not signal anything.
  if (error?.code === 'EPIPE') process.exit(0)
})

// Paths and error text are echoed back to the user, so scrub anything that
// looks like a credential and flatten newlines (one event must stay one line).
function redact(text) {
  return String(text)
    .replace(/[A-Za-z0-9_.-]*[A-Za-z0-9][A-Za-z0-9_.-]{15,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? '<redacted>' : m))
    .replace(/(bearer|token|authorization|api[-_ ]?key|secret)\s*[:=]?\s*\S+/gi, '$1 <redacted>')
    .replace(/[\r\n]+/g, ' ')
}

// writeSync + exit: a callback-based exit is ASYNC, so execution would continue
// past the failure and emit further, contradictory lines.
function fail(detail, code) {
  writeSync(1, `ARC WATCH FAILED: ${detail}\n`)
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
  const value = process.argv[i + 1]
  if (option === '--project') {
    if (!value) fail('missing value for --project', 2)
    projectDir = value
  } else if (option === '--reports') {
    if (!value) fail('missing value for --reports', 2)
    reportsDir = value
  } else if (option === '--stale') {
    const n = readNumber(value)
    if (n === null || n > MAX_STALE_MINUTES) fail(`invalid --stale (maximum ${MAX_STALE_MINUTES}min): ${value ?? '(missing)'}`, 2)
    staleMinutes = n
  } else if (option === '--poll') {
    const n = readNumber(value)
    if (n === null || n > MAX_POLL_SECONDS) fail(`invalid --poll (maximum ${MAX_POLL_SECONDS}s): ${value ?? '(missing)'}`, 2)
    pollSeconds = n
  } else {
    fail(`unknown option: ${option}`, 2)
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
async function transcripts() {
  const found = new Map()
  let sessions
  try {
    sessions = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return found // no session yet — not a failure
    throw error
  }
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const dir = path.join(sessionsRoot, session.name, 'subagents')
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (!/^agent-.+\.jsonl$/.test(entry.name)) continue
      try {
        const info = await stat(path.join(dir, entry.name))
        if (info.isFile()) found.set(`${session.name}/${entry.name}`, info.mtimeMs)
      } catch (error) {
        // Removed between readdir and stat: absent for this pass, not a failure.
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  return found
}

async function reportFiles() {
  const found = new Set()
  if (!reportsDir) return found
  const entries = await readdir(reportsDir, { withFileTypes: true })
  for (const entry of entries) {
    try {
      if ((await stat(path.join(reportsDir, entry.name))).isFile()) found.add(entry.name)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return found
}

let previousTranscripts
try {
  previousTranscripts = await transcripts()
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

// Seeded with the transcripts that are ALREADY stale at arming time — and with
// nothing else. The two failure modes this threads between are both real and
// both were observed:
//   - seeding with EVERY transcript present makes STALE unreachable for exactly
//     the agents that were already working when the watcher was armed, which is
//     the normal case. The watcher then stays silent forever and its silence
//     looks like health.
//   - seeding with NOTHING makes the first pass announce every historical
//     transcript of every past session (hundreds here), which floods the
//     channel and gets the monitor auto-stopped — manufacturing the same
//     silence by the opposite route.
// A transcript that is FRESH at arming and later goes quiet still fires, which
// is the case that matters.
const announcedStale = new Set()
const announcedGone = new Set()
const announcedFuture = new Set()
// Reports present at arming are already known to the user; only NEW ones matter.
const announcedReports = new Set(previousReports)
const degraded = new Set()
const staleMs = staleMinutes * 60_000

{
  const armedAt = Date.now()
  for (const [name, modifiedAt] of previousTranscripts) {
    if (modifiedAt <= armedAt && armedAt - modifiedAt >= staleMs) announcedStale.add(name)
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

write(`ARC WATCH ARMED: project=${redact(path.resolve(projectDir))} stale=${staleMinutes}min poll=${pollSeconds}s`)

while (true) {
  let currentTranscripts
  let currentReports
  const failures = []

  try {
    currentTranscripts = await transcripts()
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

  if (currentTranscripts) {
    for (const name of previousTranscripts.keys()) {
      if (currentTranscripts.has(name)) continue
      if (!announcedGone.has(name)) {
        write(`GONE: ${name} — the transcript no longer exists`)
        announcedGone.add(name)
      }
      announcedStale.delete(name)
      announcedFuture.delete(name)
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
          write(`FUTURE TIMESTAMP: ${name} — modification time is in the future`)
          announcedFuture.add(name)
        }
        continue
      }
      announcedFuture.delete(name)
      if (now - modifiedAt >= staleMs && !announcedStale.has(name)) {
        write(`STALE: ${name} — no write for ${staleMinutes}+ min`)
        announcedStale.add(name)
      }
    }

    previousTranscripts = currentTranscripts
  }

  if (currentReports) {
    for (const name of previousReports) {
      if (!currentReports.has(name)) announcedReports.delete(name)
    }
    for (const name of currentReports) {
      if (previousReports.has(name) || announcedReports.has(name)) continue
      write(`REPORT: ${name}`)
      announcedReports.add(name)
    }
    previousReports = currentReports
  }

  if (failures.length === 0) degraded.clear()
  await wait(pollSeconds * 1_000)
}
