#!/usr/bin/env node
// Default-on prompt-cache refresh monitor. It reads only bounded transcript chunks and
// emits only after the session has made no real model call for its model's threshold.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { handleHelpFlag } from './lib/cli-help.mjs'
import { NATIVE_SKIP_REASON, rememberContext, skipReason } from './lib/cache-keepalive-policy.mjs'
import { evidenceOwnerIds, rememberEvidence, selectEvidence } from './lib/cache-keepalive-evidence.mjs'
import { compactionSettings } from './lib/host/cache-keepalive-settings.mjs'
import { callsSince } from './lib/host/cache-keepalive-transcript.mjs'

const HELP = `wt-cache-keepalive — prompt-cache refresh monitor

Options:
  --project <dir>   project whose session transcript to inspect (default: cwd)
  --poll <seconds>  polling interval (default: WT_CACHE_KEEPALIVE_POLL_SECONDS or 60)
  --once            inspect once and exit (used by tests and diagnostics)
  --now <epoch-ms>  injected clock; valid only with --once
  --help, -h        print this text and exit 0

On by default. Disable with WT_CACHE_KEEPALIVE_ENABLED=false (also 0, no, off).
Due requests yield to native idle compaction and skip expired known-TTL caches.
`

const MAX_TIMER_MS = 0x7fffffff
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off'])

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback
}

function parseArgs(argv) {
  handleHelpFlag(argv, HELP, {
    valueFlags: ['--project', '--poll', '--now'],
    booleanFlags: ['--once'],
  })
  let projectDir = process.cwd()
  let pollSeconds = positiveNumber(process.env.WT_CACHE_KEEPALIVE_POLL_SECONDS, 60)
  let once = false
  let nowMs = null

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--once') {
      once = true
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${option}`)
    if (option === '--project') projectDir = value
    else if (option === '--poll') pollSeconds = positiveNumber(value, 0)
    else if (option === '--now') nowMs = nonNegativeInteger(value, -1)
    else throw new Error(`unknown option: ${option}`)
    index += 1
  }
  if (pollSeconds <= 0 || pollSeconds * 1000 > MAX_TIMER_MS) throw new Error('invalid --poll')
  if (nowMs === -1) throw new Error('invalid --now')
  if (nowMs !== null && !once) throw new Error('--now requires --once')
  return { nowMs, once, pollSeconds, projectDir }
}

function projectSlug(dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

function modelPolicy(model, anthropicMinutes, openaiMinutes) {
  if (model.startsWith('claude-')) return { provider: 'anthropic', thresholdMinutes: anthropicMinutes }
  if (model.startsWith('gpt-')) return { provider: 'openai', thresholdMinutes: openaiMinutes }
  return null
}

function freshState() {
  return { cappedLogged: false, cacheEvidence: null, lastContext: null, lastRefreshedAtMs: null, nativeSkipId: null,
    lastReason: '', lastRealAtMs: null, lastCadenceAtMs: null, lastRealId: '', lastWakeAtMs: null, pendingWake: null, refreshCount: 0 }
}

async function loadState(statePath) {
  try {
    const state = { ...freshState(), ...JSON.parse(await readFile(statePath, 'utf8')) }
    state.lastCadenceAtMs ??= state.lastRealAtMs
    return state
  } catch {
    return freshState()
  }
}

async function saveState(statePath, state) {
  await writeFile(statePath, `${JSON.stringify(state)}\n`, 'utf8')
}

async function journal(journalPath, entry) {
  await appendFile(journalPath, `${JSON.stringify({ at: new Date(entry.nowMs).toISOString(), ...entry, nowMs: undefined })}\n`, 'utf8')
}

function newestReal(calls) {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (!calls[index].synthetic) return calls[index]
  }
  return null
}

function resetIdle(state) {
  state.refreshCount = 0
  state.cappedLogged = false
}

function observeReal(state, call) {
  state.lastRealId = call.id
  state.lastRealAtMs = call.atMs
  if (call.atMs !== null) state.lastCadenceAtMs = call.atMs
  clearIdleReason(state)
  rememberContext(state, call)
}

function clearIdleReason(state) {
  if (state.lastReason === NATIVE_SKIP_REASON || state.lastReason === 'prompt cache freshness expired') state.lastReason = ''
}

async function recordSkip(context, state, nowMs, reason, includeModel = true) {
  const model = includeModel ? { model: state.lastModel || null } : {}
  if (shouldJournalSkip(state, reason)) await journal(context.journalPath, { kind: 'skip', ...model, nowMs, reason })
  if (reason === NATIVE_SKIP_REASON) state.nativeSkipId = state.lastRealId
  state.lastReason = reason
  await saveState(context.statePath, state)
  return null
}

function shouldJournalSkip(state, reason) {
  if (reason === NATIVE_SKIP_REASON) return state.nativeSkipId !== state.lastRealId
  return state.lastReason !== reason
}

function clearTransientReason(state) {
  if (state.lastReason !== NATIVE_SKIP_REASON && state.lastReason !== 'prompt cache freshness expired') state.lastReason = ''
}

function discoveryStopId(state) {
  return state.lastRealId || null
}

function transcriptReason(error) {
  return `transcript unavailable: ${error?.code ?? error?.message ?? 'read error'}`
}

async function discover(context, state, nowMs) {
  let discovery
  try {
    const stopId = discoveryStopId(state)
    discovery = await callsSince(context.transcriptPath, stopId,
      { cursor: state.transcriptCursor, ownerIds: evidenceOwnerIds(state) })
  } catch (error) {
    await recordSkip(context, state, nowMs, transcriptReason(error), false)
    return null
  }
  rememberEvidence(state, discovery)
  return discoveredCalls(context, state, nowMs, discovery.calls)
}

async function discoveredCalls(context, state, nowMs, calls) {
  const stopCall = calls.find((call) => call.id === state.lastRealId)
  const latestReal = newestReal(calls)
  if (stopCall && latestReal?.id === stopCall.id) {
    rememberContext(state, stopCall)
    state.lastRealAtMs = stopCall.atMs
    if (stopCall.atMs !== null) state.lastCadenceAtMs = stopCall.atMs
    state.lastModel = stopCall.model
  }
  if (state.lastRealId) return { calls: calls.filter((call) => call.id !== state.lastRealId),
    latestReal: latestReal?.id === state.lastRealId ? null : latestReal }
  const baseline = latestReal
  if (!baseline || baseline.atMs === null) {
    await recordSkip(context, state, nowMs, 'no timestamped real assistant call in transcript', false)
    return null
  }
  observeReal(state, baseline)
  state.lastModel = baseline.model
  selectEvidence(state)
  state.lastReason = ''
  await saveState(context.statePath, state)
  return { calls: [], latestReal: null }
}

function resolveOutcome(context, state, calls, nowMs) {
  if (!state.pendingWake) {
    if (calls.some((call) => !call.synthetic)) resetIdle(state)
    return null
  }
  const outcomeIndex = calls.findIndex((call) => call.atMs === null || call.atMs >= state.pendingWake.atMs)
  if (outcomeIndex < 0) return null
  return recordOutcome(context, state, calls, outcomeIndex, nowMs)
}

async function recordOutcome(context, state, calls, outcomeIndex, nowMs) {
  const outcome = calls[outcomeIndex]
  await journal(context.journalPath, {
    kind: outcome.synthetic ? 'uncallable' : 'refreshed', model: outcome.model, nowMs,
    refreshCount: state.refreshCount, usage: outcome.usage, cacheTtl: outcome.cacheTtl,
    wakeAt: new Date(state.pendingWake.atMs).toISOString(),
  })
  if (!outcome.synthetic) state.lastRefreshedAtMs = outcome.atMs ?? nowMs
  state.pendingWake = null
  if (calls.slice(outcomeIndex + 1).some((call) => !call.synthetic)) resetIdle(state)
}

function clearOrphan(context, state, nowMs, thresholdMs) {
  if (!state.pendingWake || nowMs - state.pendingWake.atMs <= thresholdMs) return null
  return recordUnresolved(context, state, nowMs)
}

async function recordUnresolved(context, state, nowMs) {
  await journal(context.journalPath, { kind: 'unresolved', model: state.pendingWake.model, nowMs,
    refreshCount: state.refreshCount, wakeAt: new Date(state.pendingWake.atMs).toISOString() })
  state.pendingWake = null
}

async function dueWake(context, state, policy, nowMs, metadataChanged = false) {
  const reason = skipReason(state, await compactionSettings(context.configDir, context.projectDir), nowMs)
  if (reason) return recordSkip(context, state, nowMs, reason)
  state.lastReason = ''
  if (state.refreshCount >= context.maxRefreshes) {
    if (!state.cappedLogged) {
      await journal(context.journalPath, { kind: 'capped', model: state.lastModel, nowMs, refreshCount: state.refreshCount })
      state.cappedLogged = true
      await saveState(context.statePath, state)
    } else if (metadataChanged) await saveState(context.statePath, state)
    return null
  }
  state.refreshCount += 1
  state.lastWakeAtMs = nowMs
  state.pendingWake = { atMs: nowMs, model: state.lastModel }
  state.cappedLogged = false
  await journal(context.journalPath, { kind: 'wake', model: state.lastModel, nowMs,
    provider: policy.provider, refreshCount: state.refreshCount, thresholdMinutes: policy.thresholdMinutes })
  await saveState(context.statePath, state)
  return 'CACHE KEEPALIVE: Reply with exactly one word: warm. Do not perform any other work.'
}

function observeLatest(state, latestReal) {
  if (latestReal) observeReal(state, latestReal)
  const model = latestReal?.model || state.pendingWake?.model || state.lastModel || ''
  if (model) state.lastModel = model
}

function attemptAnchor(state) {
  // An unknown latest timestamp affects freshness, not the last known cadence anchor.
  return Math.max(state.lastCadenceAtMs ?? state.lastRealAtMs ?? 0, state.lastWakeAtMs ?? 0)
}

function contextSnapshot(state) {
  return JSON.stringify([state.cacheEvidence, state.cacheEvidenceByModel, state.lastContext, state.transcriptCursor])
}

async function inspect(context, nowMs) {
  const state = await loadState(context.statePath)
  const metadataBefore = contextSnapshot(state)
  const discovery = await discover(context, state, nowMs)
  if (discovery === null) return null
  const { calls, latestReal } = discovery
  const outcome = resolveOutcome(context, state, calls, nowMs)
  if (outcome) await outcome
  observeLatest(state, latestReal)
  selectEvidence(state)
  const policy = modelPolicy(state.lastModel || '', context.anthropicMinutes, context.openaiMinutes)
  if (!policy) return recordSkip(context, state, nowMs, `unrecognised model: ${state.lastModel || '(unknown)'}`)
  clearTransientReason(state)
  const anchorMs = attemptAnchor(state)
  const thresholdMs = policy.thresholdMinutes * 60_000
  const orphan = clearOrphan(context, state, nowMs, thresholdMs)
  if (orphan) await orphan
  if (nowMs - anchorMs < thresholdMs || state.pendingWake) {
    await saveState(context.statePath, state)
    return null
  }
  return dueWake(context, state, policy, nowMs, contextSnapshot(state) !== metadataBefore)
}

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`wt-cache-keepalive: ${error.message}\n`)
  process.exit(2)
}

// Owner decision 2026-09-14: on by default; it only acts on a session idle past its provider threshold.
if (FALSE_VALUES.has(String(process.env.WT_CACHE_KEEPALIVE_ENABLED ?? '').trim().toLowerCase())) process.exit(0)

const sessionId = String(process.env.CLAUDE_CODE_SESSION_ID ?? '')
const safeSessionId = /^[A-Za-z0-9._-]+$/.test(sessionId) ? sessionId : 'unknown-session'
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
const transcriptPath = path.join(configDir, 'projects', projectSlug(args.projectDir), `${safeSessionId}.jsonl`)
const journalDir = process.env.WT_CACHE_KEEPALIVE_JOURNAL_DIR || path.join(configDir, 'cache-keepalive')
const context = {
  anthropicMinutes: positiveNumber(process.env.WT_CACHE_KEEPALIVE_ANTHROPIC_MINUTES, 50),
  configDir,
  journalPath: path.join(journalDir, `${safeSessionId}.jsonl`),
  maxRefreshes: nonNegativeInteger(process.env.WT_CACHE_KEEPALIVE_MAX_REFRESHES, 10),
  openaiMinutes: positiveNumber(process.env.WT_CACHE_KEEPALIVE_OPENAI_MINUTES, 25),
  projectDir: args.projectDir,
  statePath: path.join(journalDir, `${safeSessionId}.state.json`),
  transcriptPath,
}

await mkdir(journalDir, { recursive: true })
process.stdout.on('error', () => process.exit(0))

for (;;) {
  try {
    const line = await inspect(context, args.nowMs ?? Date.now())
    if (line) process.stdout.write(`${line}\n`)
  } catch {
    // A monitor must never take down the session's monitor set.
  }
  if (args.once) break
  await new Promise((resolve) => setTimeout(resolve, args.pollSeconds * 1000))
}
