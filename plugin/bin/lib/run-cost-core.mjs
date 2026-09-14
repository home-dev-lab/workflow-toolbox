import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const NOT_MEASURED = 'not measured'
const TOKEN_FIELDS = ['input', 'cache_write', 'cache_read', 'output', 'reasoning', 'first_pass_input', 'fresh_tokens']

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function tokenColumns(family, usage) {
  const input = Number(usage.input ?? usage.tokens_input) || 0
  const cacheWrite = family === 'anthropic' ? Number(usage.cache_write ?? usage.cache_creation) || 0 : NOT_MEASURED
  const cacheRead = Number(usage.cache_read ?? usage.tokens_cache_read) || 0
  const output = Number(usage.output ?? usage.tokens_output) || 0
  const reasoning = family === 'openai' ? Number(usage.reasoning ?? usage.tokens_reasoning) || 0 : NOT_MEASURED
  const numericCacheWrite = cacheWrite === NOT_MEASURED ? 0 : cacheWrite
  return { input, cache_write: cacheWrite, cache_read: cacheRead, output, reasoning, first_pass_input: input + numericCacheWrite, fresh_tokens: input + numericCacheWrite + output }
}

function phaseFor(timestamp, phases) {
  return phases.find((phase) => timestamp >= phase.entered_at && timestamp <= (phase.exited_at ?? Infinity))
}

export function attributePilotTurns(turns, phases) {
  return turns.map((turn) => {
    const timestamp = typeof turn.ended_at === 'string' ? Date.parse(turn.ended_at) : Number(turn.ended_at)
    const phase = phaseFor(timestamp, phases)
    return {
      phase: phase?.phase ?? 'unknown',
      round: phase?.round ?? null,
      model: turn.model ?? 'unknown',
      ended_at: turn.ended_at,
      tokens: tokenColumns('anthropic', turn),
      ...(phase ? {} : { status: 'unknown', reason: `no lifecycle phase contains pilot turn timestamp ${turn.ended_at}` }),
    }
  })
}

export function matchLaneSessions(sessions, directory, startedAt, endedAt, options = {}) {
  const matches = sessions.filter((row) => row.directory === directory && Number(row.time_updated) >= startedAt && Number(row.time_created) <= endedAt)
  if (matches.length > 0 || !options.explain) return matches
  return { status: 'unknown', reason: `no OpenCode session matched directory ${directory} and lane window ${startedAt}..${endedAt}` }
}

function modelName(row) {
  try {
    const model = typeof row.model === 'string' ? JSON.parse(row.model) : row.model
    return model?.providerID && model?.id ? `${model.providerID}/${model.id}` : model?.id ?? 'unknown'
  } catch { return 'unknown' }
}

function queryOpenCodeSessions({ dbPath, sqlite = 'sqlite3', execFile = execFileSync, directory, startedAt, endedAt }) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
  const query = `SELECT id,directory,model,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write,time_created,time_updated FROM session WHERE directory=${quote(directory)} AND time_updated>=${Math.floor(startedAt)} AND time_created<=${Math.ceil(endedAt)} ORDER BY time_created`
  const output = execFile(sqlite, ['-readonly', '-json', dbPath, query], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return output.trim() ? JSON.parse(output) : []
}

function phaseKey(phase, round) {
  return `${phase}\0${round ?? ''}`
}

function addTokens(target, tokens) {
  for (const field of TOKEN_FIELDS) if (typeof tokens[field] === 'number') target[field] = (target[field] ?? 0) + tokens[field]
}

function summariseEntries(entries, phases) {
  const buckets = new Map()
  for (const phase of phases) {
    const key = phaseKey(phase.phase, phase.round)
    const wallTime = Math.max(0, (phase.exited_at ?? phase.entered_at) - phase.entered_at)
    if (!buckets.has(key)) buckets.set(key, { phase: phase.phase, round: phase.round ?? null, wall_time_ms: wallTime, models: {}, unknown: [] })
    else buckets.get(key).wall_time_ms += wallTime
  }
  for (const entry of entries) {
    const key = phaseKey(entry.phase, entry.round)
    if (!buckets.has(key)) buckets.set(key, { phase: entry.phase, round: entry.round ?? null, wall_time_ms: entry.wall_time_ms ?? 0, models: {}, unknown: [] })
    const bucket = buckets.get(key)
    if (entry.status === 'unknown') {
      bucket.unknown.push(entry.reason)
      if (!entry.tokens) continue
    }
    const model = bucket.models[entry.model] ?? { input: 0, cache_write: NOT_MEASURED, cache_read: 0, output: 0, reasoning: NOT_MEASURED, first_pass_input: 0, fresh_tokens: 0 }
    for (const field of TOKEN_FIELDS) {
      const value = entry.tokens[field]
      if (typeof value === 'number') model[field] = (typeof model[field] === 'number' ? model[field] : 0) + value
    }
    bucket.models[entry.model] = model
  }
  return [...buckets.values()]
}

function inferredTimeline(laneDir, startedAt, endedAt) {
  const logs = fs.readdirSync(laneDir).filter((name) => /^(?:tdd|critic|review|refutation|harden)-run\.[^.]+(?:-[^.]+)*\.log$/.test(name))
  const lanes = logs.map((name, index) => {
    const phase = name.split('-run.')[0]
    return { phase, round: phase === 'critic' ? index + 1 : null, started_at: startedAt, ended_at: endedAt, model: null, usage_file: null, inferred: true }
  })
  return { phases: [], lanes, inferred: true }
}

export function computeRunCost(options) {
  const laneDir = path.resolve(options.laneDir)
  const routeReceipt = readJson(path.join(laneDir, 'route.json'))
  let summary = {}
  try { summary = readJson(path.join(laneDir, 'summary.json')) } catch {}
  const usage = readJson(path.join(laneDir, 'usage.json'))
  const endedAt = options.endedAt ?? Date.now()
  const startedAt = options.startedAt ?? endedAt - (Number(summary.minutes) || 0) * 60_000
  let timeline
  try { timeline = readJson(path.join(laneDir, 'lifecycle.json')) } catch { timeline = inferredTimeline(laneDir, startedAt, endedAt) }
  const worktree = options.worktree ?? routeReceipt.worktree ?? path.dirname(laneDir)
  const phases = timeline.phases ?? []
  const pilotTurns = attributePilotTurns((usage.turns ?? []).map((turn) => ({ ...turn, model: turn.model ?? summary.served_model ?? summary.model })), phases)
  const entries = [...pilotTurns]
  const unknown = []
  let inferredLaneSessions = null
  if (timeline.inferred && routeReceipt.executor !== 'claude-sdk') {
    try {
      const rows = options.sessions ?? queryOpenCodeSessions({ dbPath: options.dbPath ?? process.env.WT_OPENCODE_DB ?? path.join(os.homedir(), '.local/share/opencode/opencode.db'), sqlite: options.sqlite, execFile: options.execFile, directory: worktree, startedAt, endedAt })
      inferredLaneSessions = []
      for (const row of rows) {
        const cluster = inferredLaneSessions.at(-1)
        if (!cluster || Number(row.time_created) > Math.max(...cluster.map((item) => Number(item.time_updated)))) inferredLaneSessions.push([row])
        else cluster.push(row)
      }
    } catch {}
  }

  for (const [laneIndex, lane] of (timeline.lanes ?? []).entries()) {
    if (routeReceipt.executor === 'claude-sdk') {
      try {
        const laneUsage = readJson(path.resolve(laneDir, lane.usage_file))
        entries.push({ phase: lane.phase, round: lane.round ?? null, model: laneUsage.model ?? lane.model ?? 'unknown', tokens: tokenColumns('anthropic', laneUsage.totals ?? laneUsage), wall_time_ms: lane.ended_at - lane.started_at })
      } catch (error) {
        const reason = `Claude lane usage unavailable for ${lane.phase}${lane.round ? ` round ${lane.round}` : ''}: ${error instanceof Error ? error.message : String(error)}`
        entries.push({ phase: lane.phase, round: lane.round ?? null, status: 'unknown', reason, wall_time_ms: lane.ended_at - lane.started_at }); unknown.push(reason)
      }
      continue
    }
    try {
      const sessions = inferredLaneSessions?.[laneIndex] ?? options.sessions ?? queryOpenCodeSessions({ dbPath: options.dbPath ?? process.env.WT_OPENCODE_DB ?? path.join(os.homedir(), '.local/share/opencode/opencode.db'), sqlite: options.sqlite, execFile: options.execFile, directory: worktree, startedAt: lane.started_at, endedAt: lane.ended_at })
      if (inferredLaneSessions?.[laneIndex]) { lane.started_at = Math.min(...sessions.map((row) => Number(row.time_created))); lane.ended_at = Math.max(...sessions.map((row) => Number(row.time_updated))) }
      const matched = matchLaneSessions(sessions, worktree, lane.started_at, lane.ended_at, { explain: true })
      if (!Array.isArray(matched)) { entries.push({ phase: lane.phase, round: lane.round ?? null, ...matched }); unknown.push(matched.reason); continue }
      for (const row of matched) entries.push({ phase: lane.phase, round: lane.round ?? null, model: modelName(row), tokens: tokenColumns('openai', row), wall_time_ms: Math.max(0, Number(row.time_updated) - Number(row.time_created)) })
    } catch (error) {
      const reason = `OpenCode cost unavailable for ${lane.phase}${lane.round ? ` round ${lane.round}` : ''}: ${error instanceof Error ? error.message : String(error)}`
      entries.push({ phase: lane.phase, round: lane.round ?? null, status: 'unknown', reason }); unknown.push(reason)
    }
  }
  for (const turn of pilotTurns) if (turn.status === 'unknown') unknown.push(turn.reason)

  const phaseCosts = summariseEntries(entries, phases)
  const totals = { input: 0, cache_write: 0, cache_read: 0, output: 0, reasoning: 0, first_pass_input: 0, fresh_tokens: 0, wall_time_ms: Math.max(0, endedAt - startedAt) }
  for (const phase of phaseCosts) for (const model of Object.values(phase.models)) addTokens(totals, model)
  const partialReason = summary.partial?.reason ?? (!summary.completed ? summary.reason : null)
  return {
    version: 1,
    route: options.route ?? routeReceipt.route,
    outcome: partialReason ? { status: 'partial', reason: partialReason } : { status: 'complete' },
    worktree,
    window: { started_at: new Date(startedAt).toISOString(), ended_at: new Date(endedAt).toISOString() },
    phases: phaseCosts,
    totals,
    unknown,
    sources: { pilot: 'Claude Agent SDK result usage', lanes: routeReceipt.executor === 'claude-sdk' ? 'Claude Agent SDK result usage' : 'OpenCode session rows via sqlite3', timeline: timeline.inferred ? 'inferred (lifecycle timestamps unavailable)' : 'lifecycle transition receipts' },
  }
}

export function unknownRunCost({ route = 'unknown', reason, worktree = null }) {
  return { version: 1, route, outcome: { status: 'partial', reason }, worktree, phases: [], totals: 'unknown', unknown: [reason] }
}

export function costReportSection(cost) {
  const lines = ['## Run Cost', '', `Route: ${cost.route} | Outcome: ${cost.outcome.status}${cost.outcome.reason ? ` (${cost.outcome.reason})` : ''}`]
  if (cost.totals === 'unknown') return `${lines.join('\n')}\n\nCost: unknown (${cost.unknown.join('; ')})\n`
  lines.push('', '| Phase | Model | Input | Cache write | Cache read | Output | Reasoning | First-pass input | Fresh | Wall ms |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const phase of cost.phases) {
    const label = `${phase.phase}${phase.round ? ` ${phase.round}` : ''}`
    for (const [model, value] of Object.entries(phase.models)) lines.push(`| ${label} | ${model} | ${value.input} | ${value.cache_write} | ${value.cache_read} | ${value.output} | ${value.reasoning} | ${value.first_pass_input} | ${value.fresh_tokens} | ${phase.wall_time_ms} |`)
    for (const reason of phase.unknown) lines.push(`| ${label} | unknown (${reason}) | unknown | unknown | unknown | unknown | unknown | unknown | unknown | ${phase.wall_time_ms} |`)
  }
  return `${lines.join('\n')}\n`
}

export function appendCostReport(report, cost) {
  const withoutPrevious = report.replace(/\n## Run Cost\n[\s\S]*$/, '').replace(/\s*$/, '')
  return `${withoutPrevious}\n\n${costReportSection(cost)}`
}

function costFiles(root) {
  const files = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile() && entry.name === 'cost.json') files.push(file)
    }
  }
  walk(root)
  return files
}

export function aggregateRunCosts(root, { includePartial = false } = {}) {
  const routes = Object.fromEntries(['LITE', 'FULL', 'HARD'].map((route) => [route, { runs: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, reasoning: 0, first_pass_input: 0, fresh_tokens: 0, wall_time_ms: 0 }]))
  const partial = []
  const seen = new Set()
  for (const file of costFiles(path.resolve(root))) {
    const marker = file.lastIndexOf(`${path.sep}.lane${path.sep}`)
    const archiveRoot = marker >= 0 ? file.slice(0, marker) : path.dirname(file)
    let cost
    try { cost = readJson(file) } catch (error) {
      partial.push({ archive: path.basename(archiveRoot), route: 'unknown', reason: `invalid cost.json: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    const identity = cost.worktree && cost.window?.started_at ? `${cost.worktree}\0${cost.window.started_at}` : file
    if (seen.has(identity)) continue
    seen.add(identity)
    if (cost.outcome?.status === 'partial') partial.push({ archive: path.basename(archiveRoot), route: cost.route, reason: cost.outcome.reason ?? 'unknown' })
    if (cost.outcome?.status === 'partial' && !includePartial) continue
    if (!routes[cost.route] || !cost.totals || cost.totals === 'unknown') continue
    routes[cost.route].runs += 1
    for (const field of [...TOKEN_FIELDS, 'wall_time_ms']) if (typeof cost.totals[field] === 'number') routes[cost.route][field] += cost.totals[field]
  }
  return { routes, partial }
}

export function formatAggregate(result) {
  const lines = ['Route | Runs | Input | Cache write | Cache read | Output | Reasoning | First-pass input | Fresh | Wall ms', '--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:']
  for (const route of ['LITE', 'FULL', 'HARD']) { const row = result.routes[route]; lines.push(`${route} | ${row.runs} | ${row.input} | ${row.cache_write} | ${row.cache_read} | ${row.output} | ${row.reasoning} | ${row.first_pass_input} | ${row.fresh_tokens} | ${row.wall_time_ms}`) }
  lines.push('', 'Partial runs:')
  if (result.partial.length === 0) lines.push('none')
  else for (const run of result.partial) lines.push(`${run.archive} | ${run.route} | ${run.reason}`)
  return `${lines.join('\n')}\n`
}
