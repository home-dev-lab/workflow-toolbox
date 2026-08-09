#!/usr/bin/env node
// Unconditional elapsed-time floor for sessions with a declared autonomous mandate.

import { homedir } from 'node:os'
import path from 'node:path'
import { classifyMandate } from './lib/autonomy-mandate.mjs'
import { handleHelpFlag } from './lib/cli-help.mjs'

const HELP = `wt-wake-floor — hands a turn back to a session with a declared autonomous mandate
after a fixed elapsed-time period, then repeats on the same cadence. It does not inspect work.

Options:
  --project <dir>   project whose mandate to read (default: cwd)
  --poll <seconds>  elapsed-time cadence (default: 900)
  --once            wait for one cadence, check the mandate once, then exit (used by tests)
  --help, -h        print this text and exit 0
`

const MAX_TIMER_MS = 0x7fffffff
const MAX_POLL_SECONDS = Math.floor(MAX_TIMER_MS / 1000)
const configuredIdleMinutes = Number(process.env.WT_WAKE_FLOOR_IDLE_MINUTES || 15)
const DEFAULT_IDLE_MINUTES = Number.isFinite(configuredIdleMinutes) && configuredIdleMinutes > 0
  ? configuredIdleMinutes
  : 15
const DEFAULT_MANDATE_FRESHNESS_MINUTES = Number(process.env.WT_AUTONOMY_WATCH_MANDATE_FRESHNESS_MINUTES || 480)

process.stdout.on('error', () => {
  process.exit(0)
})

function write(line) {
  process.stdout.write(`${line}\n`)
}

function fail(detail) {
  try {
    write(`WAKE FLOOR FAILED: ${String(detail).replace(/[\r\n]+/g, ' ')}`)
  } catch {
    // Exit code is the remaining signal.
  }
  process.exit(2)
}

function readNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function parseArgs(argv) {
  handleHelpFlag(argv, HELP)
  let pollSeconds = DEFAULT_IDLE_MINUTES * 60
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
    const shown = value === undefined ? '(missing)' : String(value).replace(/[\r\n]+/g, ' ')
    if (option === '--project') {
      if (!value) fail(`missing value for --project (got ${shown})`)
      projectDir = value
      i += 1
      continue
    }
    if (option === '--poll') {
      const number = readNumber(value)
      if (number === null || number < 1 || number > MAX_POLL_SECONDS) {
        fail(`invalid --poll (minimum 1s, maximum ${MAX_POLL_SECONDS}s): ${shown}`)
      }
      pollSeconds = number
      i += 1
      continue
    }
    fail(`unknown option: ${String(option).replace(/[\r\n]+/g, ' ')}`)
  }

  return { once, pollSeconds, projectDir }
}

function projectSlug(dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function formatMinutes(pollSeconds) {
  return String(Number((pollSeconds / 60).toFixed(4)))
}

const { once, pollSeconds, projectDir } = parseArgs(process.argv.slice(2))
const stateHome = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state')
const mandateDir = process.env.WT_AUTONOMY_WATCH_MANDATE_DIR || path.join(stateHome, 'wt-queue-gate')
const mandatePath = path.join(mandateDir, `engine-${projectSlug(projectDir)}.json`)
const mandateFreshnessMs = DEFAULT_MANDATE_FRESHNESS_MINUTES * 60_000
const sessionId = process.env.CLAUDE_CODE_SESSION_ID || ''
// ⚠ The wording is load-bearing twice over, and a first draft got the first half wrong.
//
// It said "no turn for N minutes". This process CANNOT know that: it measures its own cadence and
// nothing else, so a session working steadily would have been told it had been idle a quarter of
// an hour — an assertion about a thing never observed, which is the exact failure every other
// mechanism here exists to avoid. It now states what it did measure: that its interval elapsed.
//
// The second sentence is the one that stops a reader over-reading the first. An unconditional ping
// carries no evidence that anything is pending, and without saying so it gets taken for one.
const message = `FLOOR: ${formatMinutes(pollSeconds)} minutes elapsed on my interval. I measure only that — not whether you are idle, and not whether work remains. Check the queue yourself.`

for (;;) {
  await wait(pollSeconds * 1000)
  try {
    const mandate = classifyMandate(mandatePath, mandateFreshnessMs, Date.now(), sessionId)
    if (mandate.kind === 'live') write(message)
  } catch {
    // An unreadable declaration must leave the floor silent without killing its process.
  }
  if (once) break
}
