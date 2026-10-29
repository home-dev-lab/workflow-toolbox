import fs from 'node:fs'
import path from 'node:path'
import { laneHostDir } from './lane-host-dir.mjs'
import { defaultOpenCodeDb, queryOpenCodeSessions, usageDirectory } from './opencode-session-store.mjs'
import { priceRunCost } from '../model-prices.mjs'
import { ambiguousReceiptRows, bindLaneLaunch } from './run-cost-launch.mjs'

function regularJson(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('host receipt is not a regular file')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('host receipt is not a regular file')
    return JSON.parse(fs.readFileSync(fd, 'utf8'))
  } finally { fs.closeSync(fd) }
}

function readReceipt(hostDir, lane, worktree) {
  try {
    if (!lane.usage_file) return { reason: 'no host usage receipt', absent: true }
    if (lane.usage_file !== path.basename(lane.usage_file)) throw new Error('usage_file must name a host receipt basename')
    const receipt = regularJson(path.join(hostDir, lane.usage_file))
    if (receipt.receipt_for !== lane.usage_file) throw new Error('host receipt receipt_for differs from lane usage_file')
    if (receipt.directory !== worktree) throw new Error('host receipt directory differs from run worktree realpath')
    const timeReason = receiptTimeReason(receipt, lane)
    if (timeReason) throw new Error(timeReason)
    return { receipt }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error), absent: error?.code === 'ENOENT' }
  }
}

function receiptTimeReason(receipt, lane) {
  // Unfinished calls retain their observed rows, but completionReason cannot count them.
  if (!Number.isFinite(lane.started_at) || !Number.isFinite(lane.ended_at)) return null
  if (!Array.isArray(receipt.sessions)) return null
  const outside = receipt.sessions.some((row) => !Number.isFinite(row?.time_created) || row.time_created < lane.started_at || row.time_created > lane.ended_at)
  return outside ? 'session time_created is not finite or lies outside lane started_at..ended_at' : null
}

function rowReason(row) {
  if (typeof row?.id !== 'string' || !row.id) return 'session id unavailable'
  const required = ['tokens_input', 'tokens_output', 'tokens_cache_read']
  for (const key of ['tokens_reasoning', 'tokens_cache_write']) if (Object.hasOwn(row, key)) required.push(key)
  const column = required.find((key) => !Number.isFinite(row[key]) || row[key] < 0)
  return column ? `non-finite, negative or missing token column ${column}` : null
}

function openAiReceiptReason(receipt) {
  if (receipt.status !== 'ok') return receipt.reason ?? 'OpenCode receipt unavailable'
  if (!Array.isArray(receipt.sessions) || !receipt.sessions.length) return 'OpenCode receipt has no session rows'
  return receipt.sessions.map(rowReason).find(Boolean) ?? null
}

function claudeReason(receipt) {
  const totals = receipt.totals ?? receipt
  const values = { input: totals.input ?? totals.input_tokens, output: totals.output ?? totals.output_tokens, cache_read: totals.cache_read ?? totals.cache_read_input_tokens, cache_write: totals.cache_write ?? totals.cache_creation ?? totals.cache_creation_input_tokens }
  const missing = Object.keys(values).find((key) => !Number.isFinite(values[key]) || values[key] < 0)
  return missing ? `non-finite, negative or missing Claude total ${missing}` : null
}

function sharedSessions(options, directories, window, needed) {
  if (!needed) return []
  if (options.sessions) return options.sessions
  const dbPath = defaultOpenCodeDb(options)
  if (!dbPath) return 'OpenCode session store path unavailable'
  try {
    return queryOpenCodeSessions({ dbPath, sqlite: options.sqlite, execFile: options.execFile, directories: [...directories], ...window })
  } catch (error) { return `OpenCode session store query failed: ${error instanceof Error ? error.message : String(error)}` }
}

function validatedSharedSessions(sessions, output) {
  if (!Array.isArray(sessions)) return sessions
  return sessions.filter((row) => {
    const invalid = rowReason(row)
    if (!invalid) return true
    const reason = `OpenCode session ${row?.id ?? 'unknown'}: ${invalid}`
    output.entries.push({ source: 'lane', phase: 'unmatched', round: null, status: 'unknown', reason })
    output.unknown.push(reason)
    return false
  })
}

function duplicateIds(records) {
  const counts = new Map()
  for (const record of records) {
    if (record.family !== 'openai') continue
    for (const row of sessionRows(record)) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id))
}

function duplicateUsageFiles(lanes) {
  const counts = new Map()
  for (const lane of lanes) if (lane.usage_file) counts.set(lane.usage_file, (counts.get(lane.usage_file) ?? 0) + 1)
  return new Set([...counts].filter(([, count]) => count > 1).map(([file]) => file))
}

function sessionRows(record) {
  if (record.family !== 'openai' || !Array.isArray(record.receipt?.sessions)) return []
  return record.receipt.sessions.filter((row) => row && typeof row === 'object')
}

function reservedSessionIds(records) {
  const ids = new Set()
  for (const record of records) {
    if (record.blocked || record.duplicateFile || record.receipt?.status !== 'ok') continue
    for (const row of sessionRows(record)) {
      if (!rowReason(row) && !record.ambiguousRows.includes(row)) ids.add(row.id)
    }
  }
  return ids
}

function laneRecord(lane, hostDir, worktree, helpers, duplicateFiles) {
  const family = helpers.laneFamily(lane)
  const record = { lane, family, ...readReceipt(hostDir, lane, worktree) }
  if (record.receipt && family === 'openai') record.reason = openAiReceiptReason(record.receipt)
  if (record.receipt && family === 'anthropic') record.reason = claudeReason(record.receipt)
  bindLaneLaunch(record, hostDir, worktree, regularJson)
  record.ambiguousRows = ambiguousReceiptRows(record, worktree)
  if (!record.blocked && record.ambiguousRows.length) record.reason = 'OpenCode alias session rows have ambiguous directory binding'
  if (duplicateFiles.has(lane.usage_file)) {
    record.duplicateFile = true
    record.reason = `duplicate usage_file named by multiple lane records: ${lane.usage_file}`
  }
  return record
}

function completionReason(record, duplicates) {
  if (record.reason) return record.reason
  if (record.family === null) return 'lane usage family unavailable'
  const bound = ['started_at', 'ended_at'].find((key) => !Number.isFinite(record.lane[key]))
  if (bound) return `lane has no finite ${bound}`
  if (record.family === 'openai') {
    if (record.receipt.sessions.some((row) => duplicates.has(row.id))) return 'session id shared by multiple receipt rows; inferred'
    if (record.receipt.store_kind !== 'private') return 'shared OpenCode store cannot bind rows to an invocation; inferred'
  }
  if (!['completed', 'failed'].includes(record.lane.state)) return 'lane is not completed or failed'
  return null
}

function sessionEntry(row, lane, helpers) {
  return { source: 'lane', phase: lane.phase, round: lane.round ?? null, model: helpers.modelName(row), tokens: helpers.tokenColumns('openai', row), wall_time_ms: Math.max(0, Number(row.time_updated) - Number(row.time_created)) }
}

function claudeEntry(record, helpers) {
  const { receipt, lane } = record
  if (record.reason) return []
  return [{ source: 'lane', phase: lane.phase, round: lane.round ?? null, model: receipt.model ?? lane.model ?? 'unknown', tokens: helpers.tokenColumns('anthropic', receipt.totals ?? receipt), wall_time_ms: lane.ended_at - lane.started_at }]
}

function receiptEntries(record, assigned, helpers) {
  if (record.family === 'anthropic') return claudeEntry(record, helpers)
  if (record.receipt.status !== 'ok') return []
  const result = []
  for (const row of sessionRows(record)) {
    if (rowReason(row) || assigned.has(row.id) || record.ambiguousRows.includes(row)) continue
    assigned.add(row.id)
    result.push(sessionEntry(row, record.lane, helpers))
  }
  return result
}

function unavailableFamily(lane, helpers) {
  const executor = String(lane.executor ?? '').toLowerCase()
  const model = String(lane.model ?? '').toLowerCase()
  const anthropic = model.startsWith('anthropic/') || model.startsWith('claude-') || /^(?:opus|sonnet|haiku)$/.test(model)
  const openai = model.startsWith('openai/') || model.startsWith('gpt-')
  const contradictory = executor === 'claude-sdk' && openai || ['gpt-lane', 'opencode'].includes(executor) && anthropic
  return `lane usage family unavailable for ${helpers.laneLabel(lane)}: ${contradictory ? 'contradictory executor/model family evidence' : 'executor and model do not identify Anthropic or OpenAI'}`
}

function fallbackEntries(record, context) {
  const { lane, family } = record
  const { sessions, assigned, reserved, worktree, helpers } = context
  if (family === null) return unavailableFamily(lane, helpers)
  if (family === 'anthropic') return `Anthropic lane usage unavailable for ${helpers.laneLabel(lane)}: ${record.reason}`
  if (typeof sessions === 'string') return `OpenAI lane usage unavailable for ${helpers.laneLabel(lane)}: ${sessions}`
  const sameDirectory = (directory) => record.directories.has(directory)
  const matched = helpers.matchLaneSessions(sessions.filter((row) => !assigned.has(row.id) && !reserved.has(row.id)), worktree, lane.started_at, lane.ended_at, { explain: true, sameDirectory })
  if (!Array.isArray(matched)) return `OpenAI lane usage unavailable for ${helpers.laneLabel(lane)}: ${matched.reason}`
  return matched.flatMap((row) => {
    if (assigned.has(row.id)) return []
    assigned.add(row.id)
    return [sessionEntry(row, lane, helpers)]
  })
}

function orphanLogs(hostDir, lanes, window) {
  const named = new Set(lanes.map((lane) => lane.usage_file))
  let files
  try { files = fs.readdirSync(hostDir) } catch (error) {
    if (error?.code === 'ENOENT') return []
    return [{ phase: 'unknown', round: null, reason: 'host lane logs unreadable' }]
  }
  return files.flatMap((name) => {
    const match = /^(.*?)-run(?:\.[^.]+)*\.[^.]+\.log$/.exec(name)
    if (!match || named.has(`${name}.usage.json`)) return []
    const stat = fs.lstatSync(path.join(hostDir, name))
    const start = stat.birthtimeMs || stat.mtimeMs
    if (!stat.isFile() || start > window.endedAt || stat.mtimeMs < window.startedAt) return []
    return [{ phase: match[1], round: null, reason: 'host lane log with no lifecycle lane record' }]
  })
}

function pushLaneResult(result, record, output) {
  if (typeof result === 'string') {
    output.entries.push({ source: 'lane', phase: record.lane.phase, round: record.lane.round ?? null, status: 'unknown', reason: result, wall_time_ms: record.lane.ended_at - record.lane.started_at })
    output.unknown.push(result)
  } else output.entries.push(...result)
}

function laneSource(record) {
  if (record.family === null) return null
  if (record.family === 'anthropic') return record.receipt ? 'Claude Agent SDK result usage (host receipt)' : 'Claude Agent SDK result usage'
  return record.receipt ? record.receipt.source ?? 'opencode session store' : 'OpenCode session rows via sqlite3'
}

function recordEntries(record, context, sources) {
  const { assigned, helpers } = context
  const source = laneSource(record)
  if (source) sources.add(source)
  if (record.duplicateFile || record.blocked) return record.reason
  if (record.receipt && record.family !== null) {
    const result = receiptEntries(record, assigned, helpers)
    return !result.length && record.reason ? record.reason : result
  }
  if (record.absent || record.family === null) {
    return fallbackEntries(record, context)
  }
  return record.reason
}

function collectRecord(record, context, output) {
  for (const row of record.ambiguousRows) pushAmbiguousRow(row, record.lane, output, 'alias binding is not stable or evidenced')
  const result = recordEntries(record, context, output.sources)
  pushLaneResult(result, record, output)
  const reason = completionReason(record, context.duplicates)
  if (reason) output.missing.push({ phase: record.lane.phase, round: record.lane.round ?? null, reason })
  else output.counted++
  output.calls.push({ phase: record.lane.phase, round: record.lane.round ?? null, status: callStatus(record, result, reason), ...(reason ? { reason } : {}) })
}

function callStatus(record, result, reason) {
  if (!reason) return 'counted'
  if (record.absent && Array.isArray(result) && result.length) return 'inferred'
  return record.reason ? 'missing' : 'inferred'
}

function overlappingLane(row, context) {
  const { lanes, window, canonical, helpers } = context
  return lanes.find((lane) => helpers.matchLaneSessions([row], canonical, lane.started_at, lane.ended_at ?? window.endedAt).length > 0)
}

function collectUnmatched(context, output) {
  const { sessions, assigned, reserved, helpers, directories, canonical } = context
  for (const row of Array.isArray(sessions) ? sessions : []) {
    if (!directories.has(row.directory) || assigned.has(row.id) || reserved.has(row.id)) continue
    assigned.add(row.id)
    if (row.directory !== canonical) { pushAmbiguousRow(row, { phase: 'unmatched' }, output, 'matched only an unevidenced or unbound worktree spelling'); continue }
    const lane = overlappingLane(row, context)
    if (lane) { pushAmbiguousRow(row, lane, output, `overlaps lane window for ${helpers.laneLabel(lane)} without lane attribution`); continue }
    const reason = `OpenCode session ${row.id} matched the run but no lane window`
    output.entries.push({ ...sessionEntry(row, { phase: 'unmatched' }, helpers), status: 'unknown', reason })
    output.unknown.push(reason)
  }
}

function pushAmbiguousRow(row, lane, output, detail) {
  const reason = `OpenCode session ${row.id} is ambiguous: ${detail}`
  output.entries.push({ source: 'lane', phase: lane.phase, round: lane.round ?? null, status: 'unknown', reason })
  output.unknown.push(reason)
}

function identityFailure(timeline, canonical, helpers) {
  let reason = canonical === null ? 'worktree identity unavailable' : null
  if (typeof timeline.worktree_realpath === 'string' && timeline.worktree_realpath !== canonical) reason = "report worktree differs from the run's recorded worktree realpath"
  if (!reason) return null
  const output = { entries: [], unknown: [], sources: new Set(), missing: [], counted: 0, calls: [] }
  for (const lane of timeline.lanes ?? []) {
    const record = { lane, family: helpers.laneFamily(lane), reason }
    pushLaneResult(reason, record, output)
    output.missing.push({ phase: lane.phase, round: lane.round ?? null, reason })
    output.calls.push({ phase: lane.phase, round: lane.round ?? null, status: 'missing', reason })
  }
  output.coverage = { expected: output.calls.length, counted: 0, missing: output.missing, status: 'incomplete' }
  return output
}

function laneDirectories(records, worktree, canonical) {
  const directories = new Set([worktree, canonical])
  for (const record of records.filter((record) => !record.blocked)) {
    for (const value of record.queryDirectories) directories.add(value)
  }
  return directories
}

export function collectLaneCosts(options, timeline, worktree, window, helpers) {
  const canonical = usageDirectory(worktree)
  const failure = identityFailure(timeline, canonical, helpers)
  if (failure) return failure
  const hostDir = options.laneHostDir ?? laneHostDir(timeline.worktree_realpath ?? canonical)
  const lanes = timeline.lanes ?? []
  const duplicateFiles = duplicateUsageFiles(lanes)
  const records = lanes.map((lane) => laneRecord(lane, hostDir, canonical, helpers, duplicateFiles))
  const directories = laneDirectories(records, worktree, canonical)
  const duplicates = duplicateIds(records)
  const reserved = reservedSessionIds(records)
  const shared = sharedSessions(options, directories, window, records.some((record) => record.family === 'openai' && record.absent && !record.blocked))
  const assigned = new Set()
  const output = { entries: [], unknown: [], sources: new Set(), missing: [], counted: 0, calls: [] }
  const context = { assigned, reserved, sessions: validatedSharedSessions(shared, output), worktree, helpers, duplicates, directories, canonical, lanes, window }
  for (const record of records) collectRecord(record, context, output)
  collectUnmatched(context, output)
  const orphans = orphanLogs(hostDir, lanes, window)
  output.missing.push(...orphans)
  output.coverage = { expected: lanes.length + orphans.length, counted: output.counted, missing: output.missing, status: timeline.inferred || window.inferred || output.missing.length ? 'incomplete' : 'complete' }
  return output
}

function billedTokens(models) {
  return Object.values(models).reduce((sum, row) => sum + row.input + row.cache_read + row.output + (typeof row.cache_write === 'number' ? row.cache_write : 0), 0)
}

function dollarShare(laneUsd, phaseUsd) {
  if (laneUsd === 'price unknown' || phaseUsd === 'price unknown') return 'price unknown'
  if (laneUsd === 'subscription' || phaseUsd === 'subscription') return 'subscription'
  if (!Number.isFinite(laneUsd) || !Number.isFinite(phaseUsd)) return 'price unknown'
  if (laneUsd > phaseUsd) return 'lane priced above phase'
  return phaseUsd > 0 ? laneUsd / phaseUsd : 'zero phase cost'
}

function laneShare(lane, phase, calls) {
  if (!lane) return null
  if (calls.some((call) => call.status !== 'counted')) return { tokens: null, usd: 'lane usage incomplete' }
  const tokens = billedTokens(phase.models)
  return { tokens: tokens > 0 ? billedTokens(lane.models) / tokens : null, usd: dollarShare(lane.usd, phase.usd) }
}

export function attachLaneCosts(priced, entries, calls, summariseEntries, priceTable) {
  const laneEntries = entries.filter((entry) => entry.source === 'lane')
  const callPhases = calls.map((call) => ({ phase: call.phase, round: call.round, entered_at: 0, exited_at: 0 }))
  const lanePhases = priceRunCost({ phases: summariseEntries(laneEntries, callPhases), totals: {} }, priceTable).phases
  for (const phase of priced.phases) {
    const phaseCalls = calls.filter((call) => call.phase === phase.phase && call.round === phase.round)
    const lane = phaseCalls.length ? lanePhases.find((row) => row.phase === phase.phase && row.round === phase.round) : null
    if (lane && !Object.keys(lane.models).length) lane.usd = 'price unknown'
    phase.lane = lane ? { models: lane.models, usd: lane.usd, calls: phaseCalls } : null
    phase.lane_share = laneShare(lane, phase, phaseCalls)
  }
}
