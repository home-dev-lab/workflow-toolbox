#!/usr/bin/env node
// wt-lane-activity.mjs — answer "what is this GPT lane actually DOING", not just "is something
// running on it" (wt-lane-probe.mjs answers the latter — WHERE a lane runs, via cwd
// attribution — and is deliberately not extended here: one script with two verdicts would make
// its silence ambiguous. This is its sibling, reading the two sources wt-lane-probe never
// touches).
//
// Origin (see the card that requested this): the opencode CLI writes everything needed, live,
// on disk — a per-turn log line naming the current sub-task, and a SQLite row per session
// carrying model + cumulative token totals — and none of it reached anyone; every adopter
// running a GPT lane saw only "something is running". Order of value, from the card, verbatim:
//   1. Name the current sub-task, from the log — answers "what is it doing", the actual
//      complaint.
//   2. Show the running token total and model, from the database.
//   3. Flag a genuine stall — process alive, no new turn AND no new log line for N minutes.
//      Both signals, never one: a stall verdict built on a single source INVERTS instead of
//      degrading. Measured on a live lane while the card was written: the database's newest row
//      said `finish:stop` 26 minutes earlier while the process had been alive 29 — read alone
//      that says "stuck"; the log tail said otherwise (sub-agents actively running). Database
//      alone reports a healthy lane as frozen; elapsed time alone reports a frozen lane as
//      healthy.
//
// Every field is either a MEASUREMENT or an explicit "unavailable"/"unknown" reason — never a
// zero standing in for "could not read" (a reader printing `0 tokens` where it cannot open the
// store is worse than no reader: it looks healthy while broken).
//
// Nothing here writes anywhere or mutates any lane state — the SQLite handle is opened
// read-only (`mode=ro`), and the log file is only ever read.
//
// Platform: the DEFAULT data-dir resolution below is Linux-only (XDG data dir), because that is
// the only opencode install this script could verify against a real store. macOS and Windows
// report `dataDirSupported:false` explicitly rather than a guessed path that would silently
// return an empty, plausible-looking result on every worktree — pass --data-dir to point this
// script at a real install on those platforms once one is verified. `node:sqlite` itself is
// only available from Node 22.5 onward (this plugin's floor is Node >=20); its absence degrades
// storeReadable to false with a stated reason, never a crash.
//
// Usage:
//   node wt-lane-activity.mjs --worktree /abs/path/one [--worktree /abs/path/two ...] \
//     [--pattern opencode] [--stall-minutes 10] [--data-dir <abs>] [--archive <path>]
//
// Exit codes: 0 = the probe ran (regardless of what it found — findings are not a gate);
// 2 = usage error. Read the JSON on stdout (one line) for the actual verdict.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { homedir, platform } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

import { computeStallVerdict, extractLatestLogActivity, normalizeSessionRow, pickLatestSessionRow } from './lib/lane-activity-core.mjs'
import { handleHelpFlag } from './lib/cli-help.mjs'

const HELP = `wt-lane-activity — answer "what is this GPT lane actually DOING" for one or more
worktrees: names the current sub-task from opencode's own log, the running token total and
model from its SQLite store, and a genuine-stall verdict (process alive, no new turn AND no new
log line for N minutes). Every field is a measurement or an explicit "unavailable" reason.

Usage:
  node wt-lane-activity.mjs --worktree /abs/path/one [--worktree /abs/path/two ...]
    [--pattern opencode] [--stall-minutes 10] [--data-dir <abs>] [--archive <path>]
    --worktree <path>      a worktree to check (repeatable, at least one required)
    --pattern <name>       lane CLI process-name pattern (default: opencode)
    --stall-minutes <n>    idle minutes before flagging a stall (default: 10)
    --data-dir <abs>       override the opencode data-dir (Linux-only default)
    --archive <path>       also append the JSON result line to this file

Exit codes: 0 the probe ran (findings are not a gate) · 2 usage error. Read the JSON on stdout.
`

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_LANE_PROBE = path.join(HERE, 'wt-lane-probe.mjs')

// Bound the log tail read to the LAST N bytes of what can be a multi-GB shared log file
// (opencode writes ONE log for every session on the machine, not one per lane — measured 43 MB
// on this machine after a few days). A worktree's most recent activity is always near the end
// of the file; reading the whole thing on every probe would make this script slower than the
// staleness window it is trying to detect.
const DEFAULT_LOG_TAIL_BYTES = 2_000_000

function fail(msg) {
  process.stderr.write(`wt-lane-activity: ${msg}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  handleHelpFlag(argv, HELP)
  const args = {
    worktrees: [],
    pattern: 'opencode',
    stallMinutes: 10,
    dataDir: null,
    lanProbeScript: DEFAULT_LANE_PROBE,
    logTailBytes: DEFAULT_LOG_TAIL_BYTES,
    archive: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--worktree') args.worktrees.push(argv[++i])
    else if (arg === '--pattern') args.pattern = argv[++i]
    else if (arg === '--stall-minutes') args.stallMinutes = Number(argv[++i])
    else if (arg === '--data-dir') args.dataDir = argv[++i]
    else if (arg === '--lane-probe-script') args.lanProbeScript = argv[++i]
    else if (arg === '--log-tail-bytes') args.logTailBytes = Number(argv[++i])
    else if (arg === '--archive') args.archive = argv[++i]
    else fail(`unknown flag '${arg}'`)
  }
  if (args.worktrees.length === 0) fail('at least one --worktree <abs-path> is required')
  if (!args.pattern) fail('--pattern must not be empty')
  if (!Number.isFinite(args.stallMinutes) || args.stallMinutes <= 0) fail('--stall-minutes must be a positive number')
  if (!Number.isFinite(args.logTailBytes) || args.logTailBytes <= 0) fail('--log-tail-bytes must be a positive number')
  return args
}

function safeRealpath(p) {
  const resolved = path.resolve(p)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

// Resolve opencode's data directory. Returns { supported, dir, reason }.
// Linux: `$XDG_DATA_HOME/opencode`, defaulting to `~/.local/share/opencode` — this is the
// resolution this script's own real-store fixture was captured against (see
// toolkit/packages/build/test/fixtures/lane-activity/README.md).
// macOS/Windows/anything else: `supported:false` — see the header note on why this is a
// deliberate, stated gap rather than a guess.
function resolveDataDir(explicitDataDir) {
  if (explicitDataDir) {
    return { supported: true, dir: path.resolve(explicitDataDir) }
  }
  if (process.env.OPENCODE_DATA_DIR) {
    return { supported: true, dir: path.resolve(process.env.OPENCODE_DATA_DIR) }
  }
  if (platform() === 'linux') {
    const xdgDataHome = process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share')
    return { supported: true, dir: path.join(xdgDataHome, 'opencode') }
  }
  return {
    supported: false,
    dir: null,
    reason: `opencode's data directory on platform '${platform()}' has not been verified against a real install by this script — pass --data-dir or set OPENCODE_DATA_DIR`,
  }
}

// Opens `<dataDir>/opencode.db` READ-ONLY and returns every `session` row whose `directory`
// column is exactly `worktreeRealPath` (pickLatestSessionRow then narrows to the freshest).
// Returns { readable, rows, reason }. `node:sqlite` is only available from Node 22.5 — its
// absence is caught here and reported as unreadable, never allowed to crash the whole probe
// (this plugin's floor is Node >=20).
function readSessionRows(dbPath, worktreeRealPath) {
  let DatabaseSync
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync
  } catch (error) {
    return { readable: false, rows: [], reason: `node:sqlite unavailable in this Node runtime: ${error.message}` }
  }
  if (!fs.existsSync(dbPath)) {
    return { readable: false, rows: [], reason: `no store at ${dbPath}` }
  }
  let db
  try {
    db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true })
    const rows = db.prepare('select * from session where directory = ?').all(worktreeRealPath)
    return { readable: true, rows }
  } catch (error) {
    return { readable: false, rows: [], reason: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      db?.close()
    } catch {
      // already closed or never opened — fine
    }
  }
}

// Reads the last `tailBytes` of the log file. Returns { readable, text, reason }.
function readLogTail(logPath, tailBytes) {
  let stat
  try {
    stat = fs.statSync(logPath)
  } catch (error) {
    return { readable: false, text: null, reason: `no log file at ${logPath}: ${error.message}` }
  }
  try {
    const start = Math.max(0, stat.size - tailBytes)
    const fd = fs.openSync(logPath, 'r')
    try {
      const length = stat.size - start
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, start)
      return { readable: true, text: buffer.toString('utf8') }
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    return { readable: false, text: null, reason: error instanceof Error ? error.message : String(error) }
  }
}

// Calls wt-lane-probe.mjs as a SUBPROCESS for the process-alive signal, rather than
// reimplementing its pid/cwd-matching logic here — one already-hardened source of truth for
// "is a matching process working in this worktree", never a second, divergent copy of it.
// Returns a Map<worktreeInput, true|false|'unknown'>.
function probeProcessLiveness(worktrees, pattern, lanProbeScript) {
  const liveness = new Map(worktrees.map((w) => [w, 'unknown']))
  let parsed
  try {
    const args = worktrees.flatMap((w) => ['--worktree', w])
    const stdout = execFileSync(process.execPath, [lanProbeScript, ...args, '--pattern', pattern], { encoding: 'utf8' })
    parsed = JSON.parse(stdout.trim().split('\n').pop())
  } catch {
    return liveness // every entry stays 'unknown' — the subprocess itself failed to run
  }
  if (!parsed || parsed.cwdSupported === false || parsed.pidsSupported === false) {
    return liveness // wt-lane-probe itself said it can't answer on this platform
  }
  for (const entry of parsed.worktrees ?? []) {
    if (entry.status === 'active') liveness.set(entry.worktree, true)
    else if (entry.status === 'idle') liveness.set(entry.worktree, false)
    // any other status (e.g. 'unknown-platform-unsupported') leaves the 'unknown' default
  }
  return liveness
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataDirResult = resolveDataDir(args.dataDir)
  const thresholdMs = args.stallMinutes * 60 * 1000
  const nowMs = Date.now()

  const liveness = probeProcessLiveness(args.worktrees, args.pattern, args.lanProbeScript)

  const result = {
    timestamp: new Date(nowMs).toISOString(),
    platform: platform(),
    dataDirSupported: dataDirResult.supported,
    dataDir: dataDirResult.dir,
    dataDirReason: dataDirResult.reason ?? null,
    stallMinutes: args.stallMinutes,
    worktrees: [],
  }

  const dbPath = dataDirResult.dir ? path.join(dataDirResult.dir, 'opencode.db') : null
  const logPath = dataDirResult.dir ? path.join(dataDirResult.dir, 'log', 'opencode.log') : null
  const logTail = dataDirResult.supported ? readLogTail(logPath, args.logTailBytes) : { readable: false, text: null, reason: dataDirResult.reason }

  for (const worktreeInput of args.worktrees) {
    const worktreeRealPath = safeRealpath(worktreeInput)

    let storeResult = { readable: false, rows: [], reason: dataDirResult.reason ?? 'data dir unsupported' }
    if (dataDirResult.supported) storeResult = readSessionRows(dbPath, worktreeRealPath)

    const bestRow = storeResult.readable ? pickLatestSessionRow(storeResult.rows, worktreeRealPath) : null
    const session = bestRow ? normalizeSessionRow(bestRow) : null

    const activity = logTail.readable ? extractLatestLogActivity(logTail.text, worktreeRealPath) : null

    const processAlive = liveness.get(worktreeInput) ?? 'unknown'

    const stall = computeStallVerdict({
      nowMs,
      storeLastUpdatedMs: session ? session.lastUpdatedMs : null,
      logLastTimestampMs: activity ? activity.timestampMs : null,
      thresholdMs,
      processAlive,
    })

    result.worktrees.push({
      worktree: worktreeInput,
      currentSubTask: activity ? activity.description : null,
      currentSubTaskAt: activity ? activity.timestampIso : null,
      logReadable: logTail.readable,
      logUnreadableReason: logTail.readable ? null : logTail.reason,
      session: session
        ? {
            id: session.sessionId,
            model: session.model,
            tokensInput: session.tokensInput,
            tokensOutput: session.tokensOutput,
            tokensReasoning: session.tokensReasoning,
            tokensCacheRead: session.tokensCacheRead,
            tokensCacheWrite: session.tokensCacheWrite,
            tokensTotal: session.tokensTotal,
            lastUpdatedAt: new Date(session.lastUpdatedMs).toISOString(),
          }
        : null,
      storeReadable: storeResult.readable,
      storeUnreadableReason: storeResult.readable ? null : storeResult.reason,
      process: { alive: processAlive },
      stall,
    })
  }

  emit(result, args.archive)
}

function emit(result, archivePath) {
  const line = JSON.stringify(result)
  process.stdout.write(`${line}\n`)
  if (archivePath) {
    try {
      fs.mkdirSync(path.dirname(archivePath), { recursive: true })
      fs.appendFileSync(archivePath, `${line}\n`)
    } catch (error) {
      process.stderr.write(
        `wt-lane-activity: WARNING — probe ran but could not archive to ${archivePath}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    }
  }
  process.exit(0)
}

main()
