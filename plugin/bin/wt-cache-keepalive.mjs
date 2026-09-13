#!/usr/bin/env node
// Opt-in prompt-cache refresh monitor. It reads only bounded transcript chunks and
// emits only after the session has made no real model call for its model's threshold.

import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { handleHelpFlag } from './lib/cli-help.mjs'

const HELP = `wt-cache-keepalive — opt-in prompt-cache refresh monitor

Options:
  --project <dir>   project whose session transcript to inspect (default: cwd)
  --poll <seconds>  polling interval (default: WT_CACHE_KEEPALIVE_POLL_SECONDS or 60)
  --once            inspect once and exit (used by tests and diagnostics)
  --now <epoch-ms>  injected clock; valid only with --once
  --help, -h        print this text and exit 0

Enable with WT_CACHE_KEEPALIVE_ENABLED=true. The default is off.
`

const CHUNK_BYTES = 64 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
const MAX_TIMER_MS = 0x7fffffff
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback
}

function parseArgs(argv) {
  handleHelpFlag(argv, HELP)
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

function recordTimeMs(record) {
  const value = record?.timestamp
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function assistantCall(record, sequence) {
  if (record?.type !== 'assistant' || !record.message || typeof record.message !== 'object') return null
  const usage = record.message.usage
  if (!usage || typeof usage !== 'object') return null
  const model = typeof record.message.model === 'string' ? record.message.model : ''
  const id = typeof record.message.id === 'string' && record.message.id
    ? record.message.id
    : `missing-id:${recordTimeMs(record) ?? sequence}`
  return {
    atMs: recordTimeMs(record),
    id,
    model,
    synthetic: model === '<synthetic>',
    usage: {
      input: Number(usage.input_tokens) || 0,
      output: Number(usage.output_tokens) || 0,
      cacheRead: Number(usage.cache_read_input_tokens) || 0,
      cacheCreation: Number(usage.cache_creation_input_tokens) || 0,
    },
  }
}

// Scan backward in fixed-size chunks. `stopId` bounds normal polls at the last
// call already observed; initial discovery stops at the newest real call.
async function callsSince(transcriptPath, stopId) {
  const file = await open(transcriptPath, 'r')
  try {
    const { size } = await file.stat()
    let position = size
    let carry = Buffer.alloc(0)
    let skipOversizedRecord = false
    let sequence = size
    const newestFirst = []
    const seen = new Set()
    let foundStop = false

    const accept = (line) => {
      if (!line.trim() || Buffer.byteLength(line) > MAX_RECORD_BYTES) return false
      let record
      try { record = JSON.parse(line) } catch { return false }
      const call = assistantCall(record, sequence--)
      if (!call || seen.has(call.id)) return false
      seen.add(call.id)
      if (stopId && call.id === stopId) {
        foundStop = true
        return true
      }
      newestFirst.push(call)
      return !stopId && !call.synthetic
    }

    while (position > 0 && !foundStop) {
      const length = Math.min(CHUNK_BYTES, position)
      position -= length
      const buffer = Buffer.allocUnsafe(length)
      await file.read(buffer, 0, length, position)
      let chunk = buffer
      if (skipOversizedRecord) {
        const boundary = chunk.lastIndexOf(10)
        if (boundary < 0) continue
        chunk = chunk.subarray(0, boundary + 1)
        skipOversizedRecord = false
      }
      const combined = Buffer.concat([chunk, carry])
      const firstBoundary = combined.indexOf(10)
      const lines = []
      if (firstBoundary < 0) {
        carry = combined
      } else {
        carry = Buffer.from(combined.subarray(0, firstBoundary))
        let start = firstBoundary + 1
        for (;;) {
          const boundary = combined.indexOf(10, start)
          if (boundary < 0) {
            lines.push(combined.subarray(start).toString('utf8'))
            break
          }
          lines.push(combined.subarray(start, boundary).toString('utf8'))
          start = boundary + 1
        }
      }
      if (carry.length > MAX_RECORD_BYTES) {
        carry = Buffer.alloc(0)
        skipOversizedRecord = true
      }
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (accept(lines[index])) {
          foundStop = true
          break
        }
      }
    }
    if (position === 0 && !foundStop) accept(carry.toString('utf8'))
    return newestFirst.reverse()
  } finally {
    await file.close()
  }
}

function modelPolicy(model, anthropicMinutes, openaiMinutes) {
  if (model.startsWith('claude-')) return { provider: 'anthropic', thresholdMinutes: anthropicMinutes }
  if (model.startsWith('gpt-')) return { provider: 'openai', thresholdMinutes: openaiMinutes }
  return null
}

function freshState() {
  return { cappedLogged: false, lastReason: '', lastRealAtMs: null, lastRealId: '', lastWakeAtMs: null, pendingWake: null, refreshCount: 0 }
}

async function loadState(statePath) {
  try {
    return { ...freshState(), ...JSON.parse(await readFile(statePath, 'utf8')) }
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

async function inspect(context, nowMs) {
  const state = await loadState(context.statePath)
  let calls
  try {
    calls = await callsSince(context.transcriptPath, state.lastRealId || null)
  } catch (error) {
    const reason = `transcript unavailable: ${error?.code ?? error?.message ?? 'read error'}`
    if (state.lastReason !== reason) await journal(context.journalPath, { kind: 'skip', nowMs, reason })
    state.lastReason = reason
    await saveState(context.statePath, state)
    return null
  }

  if (!state.lastRealId) {
    const baseline = newestReal(calls)
    if (!baseline || baseline.atMs === null) {
      const reason = 'no timestamped real assistant call in transcript'
      if (state.lastReason !== reason) await journal(context.journalPath, { kind: 'skip', nowMs, reason })
      state.lastReason = reason
      await saveState(context.statePath, state)
      return null
    }
    state.lastRealId = baseline.id
    state.lastRealAtMs = baseline.atMs
    state.lastModel = baseline.model
    state.lastReason = ''
    await saveState(context.statePath, state)
    calls = []
  }

  const newCalls = calls.filter((call) => call.id !== state.lastRealId)
  if (state.pendingWake) {
    const outcomeIndex = newCalls.findIndex((call) => call.atMs === null || call.atMs >= state.pendingWake.atMs)
    if (outcomeIndex >= 0) {
      const outcome = newCalls[outcomeIndex]
      await journal(context.journalPath, {
        kind: outcome.synthetic ? 'uncallable' : 'refreshed',
        model: outcome.model,
        nowMs,
        refreshCount: state.refreshCount,
        usage: outcome.usage,
        wakeAt: new Date(state.pendingWake.atMs).toISOString(),
      })
      state.pendingWake = null
      const workAfterWake = newCalls.slice(outcomeIndex + 1).some((call) => !call.synthetic)
      if (workAfterWake) {
        state.refreshCount = 0
        state.cappedLogged = false
      }
    }
  } else if (newCalls.some((call) => !call.synthetic)) {
    state.refreshCount = 0
    state.cappedLogged = false
  }

  const latestReal = newestReal(newCalls)
  if (latestReal) {
    state.lastRealId = latestReal.id
    if (latestReal.atMs !== null) state.lastRealAtMs = latestReal.atMs
  }

  const model = latestReal?.model || state.pendingWake?.model || state.lastModel || ''
  if (model) state.lastModel = model
  const policy = modelPolicy(state.lastModel || '', context.anthropicMinutes, context.openaiMinutes)
  if (!policy) {
    const reason = `unrecognised model: ${state.lastModel || '(unknown)'}`
    if (state.lastReason !== reason) await journal(context.journalPath, { kind: 'skip', model: state.lastModel || null, nowMs, reason })
    state.lastReason = reason
    await saveState(context.statePath, state)
    return null
  }

  state.lastReason = ''
  const anchorMs = Math.max(state.lastRealAtMs ?? 0, state.lastWakeAtMs ?? 0)
  const thresholdMs = policy.thresholdMinutes * 60_000
  if (nowMs - anchorMs < thresholdMs || state.pendingWake) {
    await saveState(context.statePath, state)
    return null
  }
  if (state.refreshCount >= context.maxRefreshes) {
    if (!state.cappedLogged) {
      await journal(context.journalPath, { kind: 'capped', model: state.lastModel, nowMs, refreshCount: state.refreshCount })
      state.cappedLogged = true
      await saveState(context.statePath, state)
    }
    return null
  }

  state.refreshCount += 1
  state.lastWakeAtMs = nowMs
  state.pendingWake = { atMs: nowMs, model: state.lastModel }
  state.cappedLogged = false
  await journal(context.journalPath, {
    kind: 'wake',
    model: state.lastModel,
    nowMs,
    provider: policy.provider,
    refreshCount: state.refreshCount,
    thresholdMinutes: policy.thresholdMinutes,
  })
  await saveState(context.statePath, state)
  return 'CACHE KEEPALIVE: Reply with exactly one word: warm. Do not perform any other work.'
}

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`wt-cache-keepalive: ${error.message}\n`)
  process.exit(2)
}

if (!TRUE_VALUES.has(String(process.env.WT_CACHE_KEEPALIVE_ENABLED ?? '').trim().toLowerCase())) process.exit(0)

const sessionId = String(process.env.CLAUDE_CODE_SESSION_ID ?? '')
const safeSessionId = /^[A-Za-z0-9._-]+$/.test(sessionId) ? sessionId : 'unknown-session'
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
const transcriptPath = path.join(configDir, 'projects', projectSlug(args.projectDir), `${safeSessionId}.jsonl`)
const journalDir = process.env.WT_CACHE_KEEPALIVE_JOURNAL_DIR || path.join(configDir, 'cache-keepalive')
const context = {
  anthropicMinutes: positiveNumber(process.env.WT_CACHE_KEEPALIVE_ANTHROPIC_MINUTES, 50),
  journalPath: path.join(journalDir, `${safeSessionId}.jsonl`),
  maxRefreshes: nonNegativeInteger(process.env.WT_CACHE_KEEPALIVE_MAX_REFRESHES, 10),
  openaiMinutes: positiveNumber(process.env.WT_CACHE_KEEPALIVE_OPENAI_MINUTES, 25),
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
