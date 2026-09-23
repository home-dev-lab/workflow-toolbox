import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { priceRunCost } from './model-prices.mjs'

const NOT_MEASURED = 'not measured'
const TOKEN_FIELDS = ['input', 'cache_write', 'cache_read', 'output', 'reasoning', 'first_pass_input', 'fresh_tokens']
const FAMILIES = ['anthropic', 'openai']

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function tokenColumns(family, usage) {
  const input = Number(usage.input ?? usage.tokens_input ?? usage.input_tokens ?? usage.inputTokens) || 0
  const cacheWrite = family === 'anthropic' ? Number(usage.cache_write ?? usage.cache_creation ?? usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens) || 0 : NOT_MEASURED
  const cacheRead = Number(usage.cache_read ?? usage.tokens_cache_read ?? usage.cache_read_input_tokens ?? usage.cacheReadInputTokens) || 0
  const output = Number(usage.output ?? usage.tokens_output ?? usage.output_tokens ?? usage.outputTokens) || 0
  const reasoning = family === 'openai' ? Number(usage.reasoning ?? usage.tokens_reasoning) || 0 : NOT_MEASURED
  const firstPass = input + (typeof cacheWrite === 'number' ? cacheWrite : 0)
  return { family, input, cache_write: cacheWrite, cache_read: cacheRead, output, reasoning, first_pass_input: firstPass, fresh_tokens: firstPass + output + (typeof reasoning === 'number' ? reasoning : 0) }
}

function timestampOf(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function phaseFor(timestamp, phases) {
  return phases.find((phase) => timestamp >= phase.entered_at && timestamp <= (phase.exited_at ?? Infinity))
}

export function attributePilotTurns(messages, phases) {
  return messages.map((message) => {
    const receiptTime = message.arrived_at ?? message.ended_at
    const timestamp = timestampOf(receiptTime)
    const phase = timestamp === null ? null : phaseFor(timestamp, phases)
    return {
      phase: phase?.phase ?? 'unknown',
      round: phase?.round ?? null,
      model: message.model ?? 'unknown',
      arrived_at: receiptTime,
      tokens: tokenColumns('anthropic', message),
      ...(phase ? {} : { status: 'unknown', reason: `no lifecycle phase contains pilot message timestamp ${receiptTime}` }),
    }
  })
}

export function matchLaneSessions(sessions, directory, startedAt, endedAt, options = {}) {
  const matches = sessions.filter((row) => row.directory === directory && Number(row.time_updated) >= startedAt && Number(row.time_created) <= endedAt)
  if (matches.length > 0 || !options.explain) return matches
  return { status: 'unknown', reason: `no OpenCode session row for worktree ${directory} within ${startedAt}..${endedAt}` }
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
  const output = execFile(sqlite, ['-readonly', '-json', '--', dbPath, query], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  return output.trim() ? JSON.parse(output) : []
}

function defaultOpenCodeDb(options) {
  if (options.dbPath) return options.dbPath
  if (process.env.WT_OPENCODE_DB) return process.env.WT_OPENCODE_DB
  if ((options.platform ?? process.platform) !== 'linux') return null
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode', 'opencode.db')
}

function laneFamily(lane) {
  let executorFamily = null
  if (lane.executor === 'claude-sdk') executorFamily = 'anthropic'
  else if (lane.executor === 'gpt-lane' || lane.executor === 'opencode') executorFamily = 'openai'
  const model = String(lane.model ?? '').toLowerCase()
  let modelFamily = null
  if (model.startsWith('openai/') || model.startsWith('gpt-')) modelFamily = 'openai'
  else if (model.startsWith('anthropic/') || model.startsWith('claude-') || /^(?:opus|sonnet|haiku)$/.test(model)) modelFamily = 'anthropic'
  if (executorFamily && modelFamily && executorFamily !== modelFamily) return null
  return executorFamily ?? modelFamily
}

function laneLabel(lane) {
  return `${lane.phase}${lane.round ? ` round ${lane.round}` : ''}`
}

function readClaudeLane(laneDir, lane) {
  try {
    const laneUsage = readJson(path.resolve(laneDir, lane.usage_file))
    return [{ phase: lane.phase, round: lane.round ?? null, model: laneUsage.model ?? lane.model ?? 'unknown', tokens: tokenColumns('anthropic', laneUsage.totals ?? laneUsage), wall_time_ms: lane.ended_at - lane.started_at }]
  } catch (error) {
    return `Anthropic lane usage unavailable for ${laneLabel(lane)}: ${error instanceof Error ? error.message : String(error)}`
  }
}

function readOpenAiLane(lane, sessions, assignedSessions, worktree) {
  if (typeof sessions === 'string') return `OpenAI lane usage unavailable for ${laneLabel(lane)}: ${sessions}`
  const matched = matchLaneSessions(sessions.filter((row) => !assignedSessions.has(row.id)), worktree, lane.started_at, lane.ended_at, { explain: true })
  if (!Array.isArray(matched)) return `OpenAI lane usage unavailable for ${laneLabel(lane)}: ${matched.reason}`
  return matched.map((row) => {
    assignedSessions.add(row.id)
    return { phase: lane.phase, round: lane.round ?? null, model: modelName(row), tokens: tokenColumns('openai', row), wall_time_ms: Math.max(0, Number(row.time_updated) - Number(row.time_created)) }
  })
}

function phaseKey(phase, round) {
  return `${phase}\0${round ?? ''}`
}

function emptyFamily(family) {
  return { input: 0, cache_write: family === 'anthropic' ? 0 : NOT_MEASURED, cache_read: 0, output: 0, reasoning: family === 'openai' ? 0 : NOT_MEASURED, first_pass_input: 0, fresh_tokens: 0 }
}

function addTokens(target, tokens) {
  for (const field of TOKEN_FIELDS) if (typeof tokens[field] === 'number') target[field] = (typeof target[field] === 'number' ? target[field] : 0) + tokens[field]
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
    const family = entry.tokens.family
    const model = bucket.models[entry.model] ?? { family, ...emptyFamily(family) }
    addTokens(model, entry.tokens)
    bucket.models[entry.model] = model
  }
  return [...buckets.values()]
}

function embeddedWindow(file) {
  const content = fs.readFileSync(file, 'utf8')
  const values = [...content.matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g)].map((match) => Date.parse(match[0])).filter(Number.isFinite)
  if (values.length > 0) return { started_at: Math.min(...values), ended_at: Math.max(...values), basis: 'embedded log timestamps' }
  const mtime = fs.statSync(file).mtimeMs
  return { started_at: mtime, ended_at: mtime, basis: 'log mtime' }
}

function inferredTimeline(laneDir, models = {}) {
  const rounds = new Map()
  const logs = fs.readdirSync(laneDir).filter((name) => /^(?:tdd|critic|review|refutation|harden)-run\.[^.]+(?:-[^.]+)*\.log$/.test(name))
  const lanes = logs.map((name) => {
    const phase = name.split('-run.')[0]
    const round = (rounds.get(phase) ?? 0) + 1; rounds.set(phase, round)
    const window = embeddedWindow(path.join(laneDir, name))
    const modelKey = ['tdd', 'harden'].includes(phase) ? 'code' : phase
    return { phase, round: phase === 'critic' ? round : null, started_at: window.started_at, ended_at: window.ended_at, model: models[modelKey] ?? null, usage_file: null, inferred: true, inference: window.basis }
  })
  return { phases: [], lanes, inferred: true }
}

function archiveWindow(laneDir, timeline, summary, options) {
  if (options.startedAt != null || options.endedAt != null) {
    if (options.startedAt == null || options.endedAt == null) throw new Error('--started-at and --ended-at must be provided together')
    return { startedAt: options.startedAt, endedAt: options.endedAt, inferred: false, basis: 'explicit CLI window' }
  }
  if (timestampOf(timeline.started_at) !== null && timestampOf(timeline.ended_at) !== null) return { startedAt: timestampOf(timeline.started_at), endedAt: timestampOf(timeline.ended_at), inferred: false, basis: 'runner lifecycle records' }
  try {
    const transcript = readJson(path.join(laneDir, 'sdk-transcript.json'))
    const timestamps = (Array.isArray(transcript) ? transcript : []).map((message) => timestampOf(message.timestamp)).filter((value) => value !== null)
    if (timestamps.length >= 2) return { startedAt: Math.min(...timestamps), endedAt: Math.max(...timestamps), inferred: true, basis: 'sdk transcript timestamps' }
  } catch {}
  const candidates = ['summary.json', 'usage.json', 'sdk-pilot.log'].map((name) => path.join(laneDir, name)).filter((file) => fs.existsSync(file)).map((file) => fs.statSync(file).mtimeMs)
  for (const lane of timeline.lanes ?? []) candidates.push(lane.started_at, lane.ended_at)
  if (candidates.length === 0) throw new Error('run window unavailable from lifecycle, transcript, or archive mtimes')
  const endedAt = Math.max(...candidates)
  const earliest = Math.min(...candidates)
  const summaryDuration = Number(summary?.minutes) * 60_000
  const startedAt = earliest < endedAt ? earliest : Number.isFinite(summaryDuration) && summaryDuration > 0 ? endedAt - summaryDuration : endedAt
  return { startedAt, endedAt, inferred: true, basis: Number.isFinite(summaryDuration) && earliest === endedAt ? 'archive mtime and summary minutes' : 'archive record mtimes' }
}

function usageDifference(messages, resultTotals, adjustments = []) {
  const messageTotal = emptyFamily('anthropic')
  for (const message of messages) addTokens(messageTotal, tokenColumns('anthropic', message))
  const attributedTotal = { ...messageTotal }
  for (const adjustment of adjustments) addTokens(attributedTotal, tokenColumns('anthropic', adjustment))
  const resultTotal = tokenColumns('anthropic', resultTotals ?? {})
  const difference = {}
  for (const field of TOKEN_FIELDS) if (typeof attributedTotal[field] === 'number' && typeof resultTotal[field] === 'number') difference[field] = attributedTotal[field] - resultTotal[field]
  return { agrees: Object.values(difference).every((value) => value === 0), message_sum: messageTotal, attributed_sum: attributedTotal, result_total: resultTotal, difference }
}

function modelUsageDifference(modelUsage, primaryModel, resultTotals) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) {
    return { status: 'unavailable', reason: 'SDK result modelUsage unavailable' }
  }
  if (!primaryModel || !Object.hasOwn(modelUsage, primaryModel)) {
    return { status: 'unavailable', reason: `SDK modelUsage has no key matching primary model ${primaryModel ?? 'unknown'}` }
  }
  const modelTotal = tokenColumns('anthropic', modelUsage[primaryModel])
  const resultTotal = tokenColumns('anthropic', resultTotals ?? {})
  const difference = {}
  for (const field of TOKEN_FIELDS) if (typeof modelTotal[field] === 'number' && typeof resultTotal[field] === 'number') difference[field] = modelTotal[field] - resultTotal[field]
  return { agrees: Object.values(difference).every((value) => value === 0), primary_model: primaryModel, model_total: modelTotal, result_total: resultTotal, difference }
}

export function computeRunCost(options) {
  const laneDir = path.resolve(options.laneDir)
  const routeReceipt = readJson(path.join(laneDir, 'route.json'))
  let summary = null
  try { summary = readJson(path.join(laneDir, 'summary.json')) } catch {}
  const usage = readJson(path.join(laneDir, 'usage.json'))
  let timeline
  try { timeline = readJson(path.join(laneDir, 'lifecycle.json')) } catch { timeline = inferredTimeline(laneDir, routeReceipt.models) }
  const window = archiveWindow(laneDir, timeline, summary, options)
  const { startedAt, endedAt } = window
  const worktree = options.worktree ?? routeReceipt.worktree ?? path.dirname(laneDir)
  const phases = timeline.phases ?? []
  const pilotMessages = usage.messages ?? usage.turns ?? []
  const pilotTurns = attributePilotTurns(pilotMessages.map((message) => ({ ...message, model: message.model ?? summary?.served_model ?? summary?.model })), phases)
  const entries = [...pilotTurns]
  const unknown = []
  const reconciled = []
  const resultTotals = usage.result_totals ?? usage.totals ?? {}
  const rawPilotCheck = usageDifference(pilotMessages, resultTotals)
  const missingOutput = rawPilotCheck.result_total.output - rawPilotCheck.message_sum.output
  const outputAdjustments = []
  if (missingOutput > 0) {
    const reason = 'The terminal SDK result is the only source for whole-run output; no independent instrument exists today, so undercount cannot be discriminated and only overcount can.'
    const adjustment = { output: missingOutput }
    outputAdjustments.push(adjustment)
    reconciled.push({ kind: 'terminal_result_output', tokens: missingOutput, reason })
    entries.push({
      phase: 'reconciled',
      round: null,
      model: summary?.served_model ?? summary?.model ?? usage.turns?.at(-1)?.model ?? 'unknown',
      tokens: tokenColumns('anthropic', adjustment),
    })
  }
  const primaryModel = summary?.served_model ?? summary?.model ?? usage.turns?.at(-1)?.model ?? pilotMessages.at(-1)?.model
  if (usage.model_usage && typeof usage.model_usage === 'object' && !Array.isArray(usage.model_usage)) {
    if (!primaryModel || !Object.hasOwn(usage.model_usage, primaryModel)) {
      unknown.push(`SDK modelUsage has no key matching primary model ${primaryModel ?? 'unknown'}; model rows were not added because the primary cannot be identified safely`)
    } else {
      for (const [model, modelTokens] of Object.entries(usage.model_usage)) {
        if (model === primaryModel) continue
        entries.push({
          phase: 'unattributed',
          round: null,
          model,
          tokens: tokenColumns('anthropic', modelTokens),
        })
      }
    }
  }
  const lanes = timeline.lanes ?? []
  let allSessions = []
  if (lanes.some((lane) => laneFamily(lane) === 'openai')) {
    if (options.sessions) allSessions = options.sessions
    else {
      const dbPath = defaultOpenCodeDb(options)
      if (dbPath === null) allSessions = `OpenCode session store location is unverified on ${options.platform ?? process.platform}; pass --db or set WT_OPENCODE_DB`
      else try {
        allSessions = queryOpenCodeSessions({ dbPath, sqlite: options.sqlite, execFile: options.execFile, directory: worktree, startedAt, endedAt })
      } catch (error) {
        allSessions = `OpenCode session store query failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  const assignedSessions = new Set()
  const laneSources = new Set()

  for (const lane of lanes) {
    const family = laneFamily(lane)
    if (family === null) {
      const executor = String(lane.executor ?? '').toLowerCase()
      const model = String(lane.model ?? '').toLowerCase()
      const contradictory = ((executor === 'claude-sdk') && (model.startsWith('openai/') || model.startsWith('gpt-')))
        || ((executor === 'gpt-lane' || executor === 'opencode') && (model.startsWith('anthropic/') || model.startsWith('claude-') || /^(?:opus|sonnet|haiku)$/.test(model)))
      const reason = contradictory
        ? `lane usage family unavailable for ${laneLabel(lane)}: contradictory executor/model family evidence`
        : `lane usage family unavailable for ${laneLabel(lane)}: executor and model do not identify Anthropic or OpenAI`
      entries.push({ phase: lane.phase, round: lane.round ?? null, status: 'unknown', reason, wall_time_ms: lane.ended_at - lane.started_at })
      unknown.push(reason)
      continue
    }
    laneSources.add(family)
    const result = family === 'anthropic'
      ? readClaudeLane(laneDir, lane)
      : readOpenAiLane(lane, allSessions, assignedSessions, worktree)
    if (typeof result === 'string') {
      entries.push({ phase: lane.phase, round: lane.round ?? null, status: 'unknown', reason: result, wall_time_ms: lane.ended_at - lane.started_at })
      unknown.push(result)
    } else {
      entries.push(...result)
    }
  }
  for (const row of Array.isArray(allSessions) ? allSessions.filter((item) => item.directory === worktree && !assignedSessions.has(item.id)) : []) {
    const reason = `OpenCode session ${row.id} matched the run but no lane window`
    entries.push({ phase: 'unmatched', round: null, model: modelName(row), status: 'unknown', reason, tokens: tokenColumns('openai', row), wall_time_ms: Math.max(0, Number(row.time_updated) - Number(row.time_created)) })
    unknown.push(reason)
  }
  for (const turn of pilotTurns) if (turn.status === 'unknown') unknown.push(turn.reason)

  const phaseCosts = summariseEntries(entries, phases)
  const families = { anthropic: null, openai: null }
  for (const phase of phaseCosts) for (const model of Object.values(phase.models)) {
    families[model.family] ??= emptyFamily(model.family)
    addTokens(families[model.family], model)
  }
  const outcome = summary === null
    ? { status: 'unknown', reason: 'summary.json unavailable' }
    : summary.deferred?.reason
      ? { status: 'deferred', reason: summary.deferred.reason }
      : summary.partial?.reason || !summary.completed
      ? { status: 'partial', reason: summary.partial?.reason ?? summary.reason ?? 'run incomplete' }
      : { status: 'complete' }
  return priceRunCost({
    version: 2,
    card_id: routeReceipt.cardId ?? routeReceipt.card_id ?? null,
    route: options.route ?? routeReceipt.route,
    outcome,
    worktree,
    window: { started_at: new Date(startedAt).toISOString(), ended_at: new Date(endedAt).toISOString(), inferred: window.inferred, basis: window.basis },
    phases: phaseCosts,
    families,
    totals: { wall_time_ms: Math.max(0, endedAt - startedAt) },
    unknown,
    reconciled,
    cross_checks: {
      pilot_result: usageDifference(pilotMessages, resultTotals, outputAdjustments),
      model_usage: modelUsageDifference(usage.model_usage, primaryModel, resultTotals),
    },
    sources: { pilot: usage.messages ? 'Claude Agent SDK assistant message usage' : 'legacy Claude Agent SDK result usage', lanes: [...laneSources].map((family) => family === 'anthropic' ? 'Claude Agent SDK result usage' : 'OpenCode session rows via sqlite3').join(' and ') || 'unavailable', timeline: timeline.inferred ? 'inferred from each lane log' : 'lifecycle transition receipts' },
  }, options.priceTable)
}

export function unknownRunCost({ route = 'unknown', reason, worktree = null, cardId = null, startedAt = null }) {
  return { version: 2, card_id: cardId, route, outcome: { status: 'partial', reason }, worktree, window: startedAt == null ? null : { started_at: new Date(startedAt).toISOString() }, phases: [], families: { anthropic: null, openai: null }, totals: 'unknown', unknown: [reason] }
}

export function costReportSection(cost) {
  const usd = (value, label) => {
    if (typeof value !== 'number') return value ?? 'price unknown'
    return `$${value.toFixed(6)}` + (label ? ` (${label})` : '')
  }
  const lines = ['<!-- run-cost -->', '## Measured Run Cost', '', `Route: ${cost.route} | Outcome: ${cost.outcome.status}${cost.outcome.reason ? ` (${cost.outcome.reason})` : ''} | Unknown: ${cost.unknown.length}`]
  if (cost.totals === 'unknown') return `${lines.join('\n')}\n\nCost: unknown (${cost.unknown.join('; ')})\n<!-- /run-cost -->\n`
  const missingPrices = cost.price_unknown_models?.length ? ` · missing price for: ${cost.price_unknown_models.join(', ')}` : ''
  lines.push('', `Run total: ${usd(cost.totals.usd, cost.price_labels?.join('; '))}${missingPrices}`, '', '| Phase | Family | Model | Input | Cache write | Cache read | Output | Reasoning | USD | First-pass input | Fresh | Wall ms |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const phase of cost.phases) {
    const label = `${phase.phase}${phase.round ? ` ${phase.round}` : ''}`
    for (const [model, value] of Object.entries(phase.models)) lines.push(`| ${label} | ${value.family} | ${model} | ${value.input} | ${value.cache_write} | ${value.cache_read} | ${value.output} | ${value.reasoning} | ${usd(value.usd, value.price_label)} | ${value.first_pass_input} | ${value.fresh_tokens} | ${phase.wall_time_ms} |`)
    for (const reason of phase.unknown) lines.push(`| ${label} | unknown | unknown (${reason}) | unknown | unknown | unknown | unknown | unknown | price unknown | unknown | unknown | ${phase.wall_time_ms} |`)
  }
  lines.push('', 'The terminal SDK result is the only source for whole-run output; no independent instrument exists today, so undercount cannot be discriminated and only overcount can.')
  const reconciledOutput = (cost.reconciled ?? []).filter((item) => item.kind === 'terminal_result_output').reduce((sum, item) => sum + (Number(item.tokens) || 0), 0)
  const resultOutput = cost.cross_checks?.pilot_result?.result_total?.output
  if (reconciledOutput > 0 && typeof resultOutput === 'number') lines.push(`Per-phase output attribution is vacuous for this claude-sdk run: ${reconciledOutput} of ${resultOutput} output tokens sit in reconciled.`)
  const check = cost.cross_checks?.pilot_result
  if (check && !check.agrees) lines.push('', `Pilot assistant/result usage difference: ${JSON.stringify(check.difference)}`)
  const modelCheck = cost.cross_checks?.model_usage
  if (modelCheck?.status === 'unavailable') lines.push('', `SDK primary model/result consistency check unavailable: ${modelCheck.reason}`)
  else if (modelCheck && !modelCheck.agrees) lines.push('', `SDK primary model/result usage disagreement: primary model=${modelCheck.primary_model} model total=${JSON.stringify(modelCheck.model_total)} result total=${JSON.stringify(modelCheck.result_total)} difference=${JSON.stringify(modelCheck.difference)}`)
  lines.push('<!-- /run-cost -->')
  return `${lines.join('\n')}\n`
}

export function appendCostReport(report, cost) {
  const block = costReportSection(cost).trimEnd()
  const pattern = /<!-- run-cost -->[\s\S]*?<!-- \/run-cost -->/
  if (pattern.test(report)) return `${report.replace(pattern, () => block).replace(/\s*$/, '')}\n`
  return `${report.replace(/\s*$/, '')}\n\n${block}\n`
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

function aggregateFamily(target, source) {
  if (!source) return
  target ??= {}
  for (const field of TOKEN_FIELDS) if (typeof source[field] === 'number') target[field] = (typeof target[field] === 'number' ? target[field] : 0) + source[field]
  return target
}

export function aggregateRunCosts(root, { includePartial = false } = {}) {
  const routes = Object.fromEntries(['LITE', 'FULL', 'HARD'].map((route) => [route, { runs: 0, unknown: 0, wall_time_ms: 0, families: { anthropic: null, openai: null } }]))
  const partial = []
  const runs = []
  const seen = new Set()
  for (const file of costFiles(path.resolve(root))) {
    const parent = path.dirname(file)
    const archiveRoot = path.basename(parent) === '.lane' ? path.dirname(parent) : parent
    let cost
    try { cost = readJson(file) } catch (error) {
      partial.push({ archive: path.basename(archiveRoot), route: 'unknown', reason: `invalid cost.json: ${error instanceof Error ? error.message : String(error)}` })
      continue
    }
    const identity = cost.card_id != null && cost.window?.started_at ? `${cost.card_id}\0${cost.window.started_at}` : null
    if (identity && seen.has(identity)) continue
    if (identity) seen.add(identity)
    const unknownCount = Array.isArray(cost.unknown) ? cost.unknown.length : 0
    runs.push({ archive: path.basename(archiveRoot), card_id: cost.card_id ?? 'unknown', route: cost.route, outcome: cost.outcome?.status ?? 'unknown', unknown: unknownCount })
    if (cost.outcome?.status !== 'complete') partial.push({ archive: path.basename(archiveRoot), route: cost.route, reason: cost.outcome?.reason ?? 'unknown' })
    if (cost.outcome?.status !== 'complete' && !includePartial) continue
    if (!routes[cost.route] || !cost.families || !cost.totals || cost.totals === 'unknown') continue
    const route = routes[cost.route]
    route.runs += 1; route.unknown += unknownCount; route.wall_time_ms += Number(cost.totals.wall_time_ms) || 0
    for (const family of FAMILIES) route.families[family] = aggregateFamily(route.families[family] ?? emptyFamily(family), cost.families[family]) ?? route.families[family]
  }
  return { routes, runs, partial }
}

export function formatAggregate(result) {
  const lines = ['Route | Family | Runs | Completeness | Input | Cache write | Cache read | Output | Reasoning | First-pass input | Fresh | Wall ms', '--- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:']
  for (const routeName of ['LITE', 'FULL', 'HARD']) {
    const route = result.routes[routeName]
    for (const family of FAMILIES) {
      const row = route.families[family] ?? emptyFamily(family)
      lines.push(`${routeName} | ${family} | ${route.runs} | ${route.unknown ? `incomplete (${route.unknown} unknown)` : 'complete'} | ${row.input} | ${row.cache_write} | ${row.cache_read} | ${row.output} | ${row.reasoning} | ${row.first_pass_input} | ${row.fresh_tokens} | ${route.wall_time_ms}`)
    }
  }
  lines.push('', 'Runs:', 'Archive | Card | Route | Outcome | Unknown', '--- | --- | --- | --- | ---:')
  if (result.runs.length === 0) lines.push('none')
  else for (const run of result.runs) lines.push(`${run.archive} | ${run.card_id} | ${run.route} | ${run.outcome} | ${run.unknown}`)
  lines.push('', 'Partial or unknown runs:')
  if (result.partial.length === 0) lines.push('none')
  else for (const run of result.partial) lines.push(`${run.archive} | ${run.route} | ${run.reason}`)
  return `${lines.join('\n')}\n`
}
