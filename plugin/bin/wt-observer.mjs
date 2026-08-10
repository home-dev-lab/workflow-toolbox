#!/usr/bin/env node

import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { classifyMandate } from './lib/autonomy-mandate.mjs'
import { handleHelpFlag } from './lib/cli-help.mjs'
import { runObserverLane, buildObserverPrompt, observerLaneInputBytes } from './lib/observer-lane.mjs'
import { queueSnapshotSlug, resolveQueueSnapshotPath } from './lib/queue-snapshot-path.mjs'
import { readTranscriptDelta } from './lib/transcript-delta.mjs'

const HELP = `wt-observer — watches this session's own transcript, checks for a mechanical
premature-stop condition, and otherwise asks an external model whether the session's actions match
a recorded lesson. Silence is the steady state; degraded passes explain themselves on stderr.

Options:
  --project <dir>   project whose session transcript to watch (default: cwd)
  --index <path>    lesson knowledge-base index (default: project memory/MEMORY.md)
  --poll <seconds>  unconditional poll floor (default: 60)
  --once            run one pass immediately, then exit
  --help, -h        print this text and exit 0

Environment:
  WT_OBSERVER_LESSON_INDEX          lesson knowledge-base index path
  WT_OBSERVER_LANE_INTERVAL_MINUTES  minimum time between model calls (default: 30)
  WT_OBSERVER_IDLE_MINUTES           transcript quiet time before a stop (minimum: 5)
  WT_OBSERVER_COST_LOG               cost log path (default: state/wt-observer/lane-cost.jsonl)
  WT_OBSERVER_STATE_DIR              shared rate-limit state (default: state/wt-observer)
`

const MAX_TIMER_MS = 0x7fffffff
const MAX_POLL_SECONDS = Math.floor(MAX_TIMER_MS / 1000)
const DEFAULT_POLL_SECONDS = 60
const DEFAULT_TIMEOUT_SECONDS = Number(process.env.WT_OBSERVER_TIMEOUT_SECONDS || 45)
const DEFAULT_MAX_DELTA_BYTES = Number(process.env.WT_OBSERVER_MAX_DELTA_BYTES || 12_000)
const DEFAULT_MANDATE_FRESHNESS_MINUTES = Number(process.env.WT_AUTONOMY_WATCH_MANDATE_FRESHNESS_MINUTES || 480)

process.stdout.on('error', () => {
  process.exit(0)
})

function writeError(line) {
  try {
    process.stderr.write(`${line}\n`)
  } catch {
    // stderr failure leaves exit status as the remaining signal.
  }
}

function fail(detail) {
  writeError(`WT_OBSERVER FAILED: ${String(detail).replace(/[\r\n]+/g, ' ')}`)
  process.exit(2)
}

function readNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function parseArgs(argv) {
  handleHelpFlag(argv, HELP)
  let projectDir = process.cwd()
  let indexPath = null
  let pollSeconds = DEFAULT_POLL_SECONDS
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
    if (option === '--index') {
      if (!value) fail(`missing value for --index (got ${shown})`)
      indexPath = value
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

  return { once, pollSeconds, projectDir, indexPath }
}

function projectSlug(dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function wakeSpool() {
  return process.env.WT_WAKE_SPOOL || path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'wt-wake-channel', 'inbox')
}

function queueStateDir() {
  return process.env.WT_QUEUE_GATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'wt-queue-gate')
}

function defaultCostLog() {
  return path.join(defaultObserverStateDir(), 'lane-cost.jsonl')
}

function defaultObserverStateDir() {
  return path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'wt-observer')
}

function lessonIndexPath(configuredPath, projectDir, configDir) {
  const selected = configuredPath || process.env.WT_OBSERVER_LESSON_INDEX
  if (typeof selected === 'string' && selected.trim()) return path.resolve(selected)
  return path.join(configDir, 'projects', projectSlug(projectDir), 'memory', 'MEMORY.md')
}

function readQueueSnapshot(stateDir, cwd, freshnessMs, now) {
  const resolved = resolveQueueSnapshotPath(stateDir, cwd)
  if (!resolved) return { kind: 'absent' }
  const parsed = JSON.parse(readFileSync(resolved.path, 'utf8'))
  const at = parsed?.at
  const open = parsed?.open
  const next = parsed?.next
  if (typeof at !== 'number' || !Number.isFinite(at)) return { kind: 'malformed' }
  if (now - at > freshnessMs) return { kind: 'stale' }
  if (typeof open !== 'number' || !Number.isFinite(open) || open < 0 || typeof next !== 'string') {
    return { kind: 'malformed' }
  }
  return { kind: 'known', open, next: next.trim(), at, ancestor: resolved.ancestor }
}

function hasInflightDelegation(subagentsDir, cutoffMs) {
  try {
    for (const entry of readdirSync(subagentsDir)) {
      if (!entry.endsWith('.jsonl')) continue
      if (statSync(path.join(subagentsDir, entry)).mtimeMs >= cutoffMs) return true
    }
  } catch {
    return false
  }
  return false
}

function renderMessage(lines) {
  return lines.filter(Boolean).slice(0, 3).join('\n')
}

function writeSpoolMessage(spoolDir, body) {
  mkdirSync(spoolDir, { recursive: true })
  const base = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`
  const tempPath = path.join(spoolDir, `.${base}.tmp`)
  const finalPath = path.join(spoolDir, `${base}.txt`)
  writeFileSync(tempPath, `${body}\n`, 'utf8')
  renameSync(tempPath, finalPath)
}

function writeCostRecord(logPath, record) {
  mkdirSync(path.dirname(logPath), { recursive: true })
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
}

function transcriptIsQuiet(transcriptPath, delta, quietMs) {
  const current = statSync(transcriptPath)
  return current.size === delta.watermark
    && current.mtimeMs === delta.transcriptMtimeMs
    && Date.now() - current.mtimeMs >= quietMs
}

function acquireLaneLease(statePath, intervalMs, timeoutMs, now) {
  mkdirSync(path.dirname(statePath), { recursive: true })
  const lockPath = `${statePath}.lock`
  const createLock = () => mkdirSync(lockPath)
  try {
    createLock()
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    try {
      if (now - statSync(lockPath).mtimeMs <= timeoutMs + 10_000) return null
      rmSync(lockPath, { recursive: true, force: true })
      createLock()
    } catch {
      return null
    }
  }

  const release = () => rmSync(lockPath, { recursive: true, force: true })
  try {
    let previous = null
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
      previous = Number.isFinite(parsed?.lastCallAt) ? parsed.lastCallAt : null
      if (previous === null) throw new Error('lane rate state is malformed')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (previous !== null && now - previous < intervalMs) {
      release()
      return null
    }
    const tempPath = `${statePath}.${process.pid}.tmp`
    writeFileSync(tempPath, `${JSON.stringify({ lastCallAt: now })}\n`, 'utf8')
    renameSync(tempPath, statePath)
    return { release }
  } catch (error) {
    release()
    throw error
  }
}

function transcriptPathFor(projectDir, sessionId, configDir) {
  return path.join(configDir, 'projects', projectSlug(projectDir), `${sessionId}.jsonl`)
}

function subagentsDirFor(projectDir, sessionId, configDir) {
  return path.join(configDir, 'projects', projectSlug(projectDir), sessionId, 'subagents')
}

const args = parseArgs(process.argv.slice(2))
const projectDir = path.resolve(args.projectDir)
const sessionId = process.env.CLAUDE_CODE_SESSION_ID || ''
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
const transcriptPath = transcriptPathFor(projectDir, sessionId, configDir)
const subagentsDir = subagentsDirFor(projectDir, sessionId, configDir)
const stateDir = queueStateDir()
const mandatePath = path.join(process.env.WT_AUTONOMY_WATCH_MANDATE_DIR || stateDir, `engine-${projectSlug(projectDir)}.json`)
const spoolDir = wakeSpool()
const observerBin = process.env.WT_OBSERVER_BIN || 'opencode'
const observerModel = process.env.WT_OBSERVER_MODEL || 'openai/gpt-5.4'
const indexPath = lessonIndexPath(args.indexPath, projectDir, configDir)
const laneIntervalMinutes = readNumber(process.env.WT_OBSERVER_LANE_INTERVAL_MINUTES) ?? 30
const laneIntervalMs = laneIntervalMinutes * 60_000
const idleMinutes = Math.max(5, args.pollSeconds / 60, readNumber(process.env.WT_OBSERVER_IDLE_MINUTES) ?? 0)
const idleMs = idleMinutes * 60_000
const costLog = process.env.WT_OBSERVER_COST_LOG || defaultCostLog()
const observerStateDir = process.env.WT_OBSERVER_STATE_DIR || defaultObserverStateDir()
const laneState = path.join(observerStateDir, `lane-rate-${queueSnapshotSlug(projectDir)}-${sessionId.replace(/[^A-Za-z0-9-]/g, '-')}.json`)

if (!sessionId) fail('CLAUDE_CODE_SESSION_ID is required')

let watermark = 0
let lastPrematureKey = ''
const accumulatedTriggers = new Set()
let running = false
let pending = false
let pendingTrigger = ''
async function runPass(trigger) {
  const now = Date.now()
  let delta
  try {
    delta = readTranscriptDelta(transcriptPath, watermark, DEFAULT_MAX_DELTA_BYTES)
  } catch (error) {
    writeError(`WT_OBSERVER DEGRADED: transcript unreadable at ${transcriptPath} (${error instanceof Error ? error.message : String(error)})`)
    return
  }
  if (delta.lastRecordDegradedReason) {
    writeError(`WT_OBSERVER DEGRADED: ${delta.lastRecordDegradedReason} at ${transcriptPath}`)
    return
  }

  const mandate = classifyMandate(mandatePath, DEFAULT_MANDATE_FRESHNESS_MINUTES * 60_000, now, sessionId)
  let queue
  try {
    queue = readQueueSnapshot(stateDir, projectDir, 120 * 60_000, now)
  } catch (error) {
    writeError(`WT_OBSERVER DEGRADED: queue snapshot unreadable (${error instanceof Error ? error.message : String(error)})`)
    queue = { kind: 'malformed' }
  }

  let transcriptQuiet = false
  if (delta.lastRealRecordType === 'assistant') {
    try {
      transcriptQuiet = transcriptIsQuiet(transcriptPath, delta, idleMs)
    } catch (error) {
      writeError(`WT_OBSERVER DEGRADED: transcript could not be rechecked at ${transcriptPath} (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  const prematureStop = delta.lastRealRecordType === 'assistant'
    && transcriptQuiet
    && mandate.kind === 'live'
    && queue.kind === 'known'
    && queue.open > 0
    && !hasInflightDelegation(subagentsDir, now - 3 * 60_000)

  if (prematureStop) {
    const key = `${delta.watermark}:${mandate.declaredAtMs}:${queue.at}:${queue.next}`
    if (key !== lastPrematureKey) {
      writeSpoolMessage(spoolDir, renderMessage([
        'Observer: possible premature stop while open work remains.',
        `Card: ${queue.next || `${queue.open} open item(s)`}`,
      ]))
      lastPrematureKey = key
    }
    return
  }

  lastPrematureKey = ''
  if (!delta.deltaText.trim()) {
    watermark = delta.watermark
    return
  }

  let indexText
  try {
    indexText = readFileSync(indexPath, 'utf8')
    if (!indexText.trim()) throw new Error('index is empty')
  } catch (error) {
    writeError(`WT_OBSERVER DEGRADED: lesson index unreadable at ${indexPath} (${error instanceof Error ? error.message : String(error)})`)
    return
  }

  accumulatedTriggers.add(trigger)
  let lease
  try {
    lease = acquireLaneLease(laneState, laneIntervalMs, (DEFAULT_TIMEOUT_SECONDS + 5) * 1000, now)
  } catch (error) {
    writeError(`WT_OBSERVER DEGRADED: lane rate state unreadable at ${laneState} (${error instanceof Error ? error.message : String(error)})`)
    return
  }
  if (!lease) return

  const prompt = buildObserverPrompt({ indexText, deltaText: delta.deltaText })
  const laneTrigger = [...accumulatedTriggers].join(',')
  accumulatedTriggers.clear()
  let lane
  try {
    lane = runObserverLane({
      projectDir,
      prompt,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      model: observerModel,
      binPath: observerBin,
    })
  } catch (error) {
    lane = { outcome: { kind: 'error', reason: error instanceof Error ? error.message : String(error) }, usage: null }
  } finally {
    lease.release()
  }

  try {
    writeCostRecord(costLog, {
      timestamp: new Date(now).toISOString(),
      inputBytes: observerLaneInputBytes(prompt),
      tokens: lane.usage ?? null,
      outcome: lane.outcome.kind,
      trigger: laneTrigger,
    })
  } catch (error) {
    writeError(`WT_OBSERVER DEGRADED: cost log unwritable at ${costLog} (${error instanceof Error ? error.message : String(error)})`)
  }

  if (lane.outcome.kind === 'error') {
    writeError(`WT_OBSERVER DEGRADED: ${lane.outcome.reason}`)
    return
  }

  watermark = delta.watermark
  if (lane.outcome.kind !== 'finding') return
  writeSpoolMessage(spoolDir, renderMessage([
    `Observer: ${lane.outcome.observation}`,
    `Fiche: ${lane.outcome.fiche}`,
    delta.truncated ? `Evidence: ${lane.outcome.evidence} [delta truncated]` : `Evidence: ${lane.outcome.evidence}`,
  ]))
}

async function triggerPass(trigger) {
  if (running) {
    pending = true
    pendingTrigger = pendingTrigger ? `${pendingTrigger},${trigger}` : trigger
    return
  }
  running = true
  try {
    await runPass(trigger)
  } finally {
    running = false
    if (pending) {
      pending = false
      const nextTrigger = pendingTrigger || 'pending'
      pendingTrigger = ''
      await triggerPass(nextTrigger)
    }
  }
}

function watchDir(dir) {
  try {
    const watcher = watch(dir, { persistent: false }, () => {
      void triggerPass('watch')
    })
    watcher.on('error', () => {})
  } catch {
    // Poll floor remains the correctness path.
  }
}

if (args.once) {
  await triggerPass('once')
  process.exit(0)
}

watchDir(path.dirname(transcriptPath))
watchDir(subagentsDir)
watchDir(stateDir)
watchDir(path.dirname(mandatePath))

for (;;) {
  await wait(args.pollSeconds * 1000)
  await triggerPass('poll')
}
