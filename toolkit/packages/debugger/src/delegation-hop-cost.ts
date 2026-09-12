import { isRecord, numOrNull, strOrNull } from '@workflow-toolbox/std'

export interface DelegationTranscript {
  id: string
  records: unknown[]
}

export interface DelegationHopCostReport {
  totals: { hops: number; maxDepth: number; chatterMessages: number; widestTurn: number }
  hops: DelegationHopCostRow[]
}

export interface TokenMeasure {
  tokens: number | null
  source: string
  reason?: string
}

export interface ChatterCost {
  attribution: 'by-text' | 'by-time' | 'unknown'
  freshTokens: TokenMeasure
  cacheReadTokens: TokenMeasure
}

export interface DelegationHopCostRow {
  depth: number | null
  delegateId: string | null
  delegateName: string | null
  promptTokens: TokenMeasure
  returnedTokens: TokenMeasure
  launchStubTokens?: TokenMeasure
  chatterCount: number
  chatterFreshTokens: TokenMeasure
  chatterCacheReadTokens: TokenMeasure
  chatterCosts: ChatterCost[]
}

interface Spawn {
  parentId: string
  parentRecord: number
  turn: string | null
  toolUseId: string | null
  delegateId: string | null
  delegateName: string | null
  prompt: string | null
  returned: string | null
  outputFile: string | null
  async: boolean
}

interface MessageCall {
  target: string | null
  message: string | null
  record: number
  timestamp: string | null
}

function blocks(record: unknown): Record<string, unknown>[] {
  if (!isRecord(record) || record['type'] !== 'assistant') return []
  const message = record['message']
  if (!isRecord(message) || !Array.isArray(message['content'])) return []
  return message['content'].filter(isRecord)
}

function toolResults(record: unknown): Record<string, unknown>[] {
  if (!isRecord(record) || record['type'] !== 'user') return []
  const message = record['message']
  if (!isRecord(message) || !Array.isArray(message['content'])) return []
  return message['content'].filter((block): block is Record<string, unknown> => isRecord(block) && block['type'] === 'tool_result')
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((part) => (isRecord(part) ? strOrNull(part['text']) : null)).filter((part): part is string => part !== null).join('\n') || null
  return null
}

function estimate(value: string | null, missing: string): TokenMeasure {
  return value === null ? { tokens: null, source: 'unknown', reason: missing } : { tokens: Math.ceil(value.length / 4), source: 'estimated', reason: 'estimated from text (ceil(characters / 4))' }
}

function agentIdFromResult(value: string | null): string | null {
  if (value === null) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (isRecord(parsed)) return strOrNull(parsed['agentId']) ?? strOrNull(parsed['id'])
  } catch {
    // Some transcript versions stringify a human-readable result instead of JSON.
  }
  return /(?:agentId|agent id)\s*[:=]\s*["`]?([A-Za-z0-9_-]+)/i.exec(value)?.[1] ?? null
}

function resultFor(records: unknown[], after: number, toolUseId: string | null): { content: string | null; record: unknown } | null {
  if (toolUseId === null) return null
  for (let i = after + 1; i < records.length; i++) {
    for (const result of toolResults(records[i])) {
      if (strOrNull(result['tool_use_id']) === toolUseId) return { content: text(result['content']), record: records[i] }
    }
    if (blocks(records[i]).length > 0) break
  }
  return null
}

function outputFile(value: string | null, record: unknown): string | null {
  if (isRecord(record) && isRecord(record['toolUseResult'])) {
    const toolResult = record['toolUseResult']
    const direct = strOrNull(toolResult['outputFile'])
    if (direct !== null) return direct
  }
  return value === null ? null : /output[_ ]file:\s*(\S+)/i.exec(value)?.[1] ?? null
}

function isAsyncLaunch(value: string | null, record: unknown): boolean {
  return (value?.startsWith('Async agent launched successfully.') ?? false) || (isRecord(record) && isRecord(record['toolUseResult']) && record['toolUseResult']['isAsync'] === true)
}

function taskNotificationBlocks(value: string, agentId: string | null): string[] {
  if (agentId === null) return []
  const blocks = value.match(/<task-notification>[\s\S]*?<\/task-notification>/g) ?? []
  return blocks.filter((block) => new RegExp(`<task-id>\s*${agentId}\s*<\/task-id>|agentId\s*[:=]\s*${agentId}`, 'i').test(block))
}

function returnDelivery(records: unknown[], spawn: Spawn): { returned: TokenMeasure; launchStub?: TokenMeasure } {
  if (!spawn.async) return { returned: estimate(spawn.returned, 'spawn tool_result is absent from the transcript') }
  const notificationText = records.slice(spawn.parentRecord + 1).flatMap((record) => taskNotificationBlocks(userText(record) ?? '', spawn.delegateId))
  const readBackText: string[] = []
  if (spawn.outputFile !== null) {
    for (let i = spawn.parentRecord + 1; i < records.length; i++) {
      for (const call of blocks(records[i])) {
        if (strOrNull(call['name']) !== 'Read') continue
        const input = isRecord(call['input']) ? call['input'] : {}
        if (strOrNull(input['file_path']) !== spawn.outputFile && strOrNull(input['path']) !== spawn.outputFile) continue
        const result = resultFor(records, i, strOrNull(call['id']))
        if (result !== null && result.content !== null) readBackText.push(result.content)
      }
    }
  }
  const pieces = [...notificationText, ...readBackText]
  const labels = [...(notificationText.length === 0 ? [] : ['notification']), ...(readBackText.length === 0 ? [] : ['read-back'])]
  return {
    returned: pieces.length === 0
      ? { tokens: null, source: 'unknown', reason: 'no delivery found' }
      : { tokens: pieces.reduce((total, value) => total + Math.ceil(value.length / 4), 0), source: labels.join(' + '), reason: 'estimated from text (ceil(characters / 4))' },
    launchStub: estimate(spawn.returned, 'async launch stub is absent from the transcript'),
  }
}

function usage(record: unknown): { fresh: number; cacheRead: number } | null {
  if (!isRecord(record) || record['type'] !== 'assistant') return null
  const message = record['message']
  if (!isRecord(message) || !isRecord(message['usage'])) return null
  const u = message['usage']
  const fresh = numOrNull(u['input_tokens'])
  const cacheRead = numOrNull(u['cache_read_input_tokens'])
  return fresh === null && cacheRead === null ? null : { fresh: fresh ?? 0, cacheRead: cacheRead ?? 0 }
}

function timestamp(record: unknown): string | null {
  return isRecord(record) ? strOrNull(record['timestamp']) : null
}

function userText(record: unknown): string | null {
  if (!isRecord(record) || record['type'] !== 'user') return null
  const message = record['message']
  return isRecord(message) ? text(message['content']) : null
}

/** Build a cost report from already-parsed Claude Code transcript records. Text-sized envelope
 * fields are explicitly estimates because transcript usage is per model turn, not per tool block. */
export function buildDelegationHopCostReport(transcripts: DelegationTranscript[]): DelegationHopCostReport {
  const byId = new Map(transcripts.map((transcript) => [transcript.id, transcript]))
  const spawns: Spawn[] = []
  const messages = new Map<string, MessageCall[]>()
  let widestTurn = 0

  for (const transcript of transcripts) {
    for (let i = 0; i < transcript.records.length; i++) {
      const calls = blocks(transcript.records[i])
      const spawnCalls = calls.filter((call) => ['Agent', 'Task'].includes(strOrNull(call['name']) ?? ''))
      widestTurn = Math.max(widestTurn, spawnCalls.length)
      for (const call of spawnCalls) {
        const input = isRecord(call['input']) ? call['input'] : {}
        const toolUseId = strOrNull(call['id'])
        const result = resultFor(transcript.records, i, toolUseId)
        const returned = result?.content ?? null
        spawns.push({
          parentId: transcript.id,
          parentRecord: i,
          turn: timestamp(transcript.records[i]),
          toolUseId,
          delegateId: agentIdFromResult(returned) ?? (result !== null && isRecord(result.record) && isRecord(result.record['toolUseResult']) ? strOrNull(result.record['toolUseResult']['agentId']) : null),
          delegateName: strOrNull(input['name']) ?? strOrNull(input['description']),
          prompt: strOrNull(input['prompt']),
          returned,
          outputFile: result === null ? null : outputFile(returned, result.record),
          async: result !== null && isAsyncLaunch(returned, result.record),
        })
      }
      for (const call of calls) {
        if (strOrNull(call['name']) !== 'SendMessage') continue
        const input = isRecord(call['input']) ? call['input'] : {}
        const target = strOrNull(input['to']) ?? strOrNull(input['recipient'])
        if (target !== null) messages.set(transcript.id, [...(messages.get(transcript.id) ?? []), { target, message: strOrNull(input['message']) ?? strOrNull(input['content']), record: i, timestamp: timestamp(transcript.records[i]) }])
      }
    }
  }

  const parentByChild = new Map<string, Spawn>()
  for (const spawn of spawns) if (spawn.delegateId !== null && byId.has(spawn.delegateId)) parentByChild.set(spawn.delegateId, spawn)
  const depthFor = (transcriptId: string): number | null => {
    if (transcriptId === 'main') return 0
    let depth = 0
    let current = transcriptId
    const seen = new Set<string>()
    while (current !== 'main') {
      if (seen.has(current)) return null
      seen.add(current)
      const parent = parentByChild.get(current)
      if (parent === undefined) return null
      depth++
      current = parent.parentId
    }
    return depth
  }

  const rows: DelegationHopCostRow[] = spawns.map((spawn) => {
    const child = spawn.delegateId === null ? undefined : byId.get(spawn.delegateId)
    const calls = messages.get(spawn.parentId) ?? []
    const chatter = calls.filter((call) => call.record > spawn.parentRecord && (call.target === spawn.delegateId || call.target === spawn.delegateName))
    const chatterCosts: ChatterCost[] = chatter.map((call) => {
      if (child === undefined) {
        const measure = { tokens: null, source: 'unknown', reason: 'delegate transcript is unavailable or the spawn result did not identify its agent id' }
        return { attribution: 'unknown', freshTokens: measure, cacheReadTokens: measure }
      }
      const delivered = child.records.findIndex((record) => (timestamp(record) ?? '') > (call.timestamp ?? '') && call.message !== null && userText(record) === call.message)
      const afterDelivery = delivered === -1 ? -1 : child.records.findIndex((record, index) => index > delivered && usage(record) !== null)
      const afterTime = child.records.findIndex((record) => (timestamp(record) ?? '') > (call.timestamp ?? '') && usage(record) !== null)
      const next = usage(child.records[afterDelivery === -1 ? afterTime : afterDelivery])
      if (next === null) {
        const measure = { tokens: null, source: 'unknown', reason: 'no billed delegate turn follows the message in its transcript' }
        return { attribution: 'unknown', freshTokens: measure, cacheReadTokens: measure }
      }
      const attribution = afterDelivery === -1 ? 'by-time' : 'by-text'
      return {
        attribution,
        freshTokens: { tokens: next.fresh, source: attribution },
        cacheReadTokens: { tokens: next.cacheRead, source: attribution },
      }
    })
    const knownCosts = chatterCosts.filter((cost) => cost.attribution !== 'unknown')
    const knownFresh = knownCosts.reduce((total, cost) => total + (cost.freshTokens.tokens ?? 0), 0)
    const knownCacheRead = knownCosts.reduce((total, cost) => total + (cost.cacheReadTokens.tokens ?? 0), 0)
    const labels = [...new Set(knownCosts.map((cost) => cost.attribution))].join(' + ')
    const unknown = chatterCosts.find((cost) => cost.attribution === 'unknown')
    const delivery = returnDelivery(byId.get(spawn.parentId)?.records ?? [], spawn)
    return {
      depth: depthFor(spawn.parentId) === null ? null : depthFor(spawn.parentId)! + 1,
      delegateId: spawn.delegateId,
      delegateName: spawn.delegateName,
      promptTokens: estimate(spawn.prompt, 'spawn prompt is absent from the tool input'),
      returnedTokens: spawn.async && delivery.returned.tokens !== null ? { ...delivery.returned, source: delivery.returned.source } : spawn.async ? delivery.returned : { ...delivery.returned, source: delivery.returned.tokens === null ? delivery.returned.source : 'inline' },
      ...(delivery.launchStub === undefined ? {} : { launchStubTokens: { ...delivery.launchStub, source: 'launch stub' } }),
      chatterCount: chatter.length,
      chatterFreshTokens: chatter.length === 0 ? { tokens: 0, source: 'transcript' } : unknown === undefined ? { tokens: knownFresh, source: labels } : unknown.freshTokens,
      chatterCacheReadTokens: chatter.length === 0 ? { tokens: 0, source: 'transcript' } : unknown === undefined ? { tokens: knownCacheRead, source: labels } : unknown.cacheReadTokens,
      chatterCosts,
    }
  })
  const depths = rows.map((row) => row.depth).filter((depth): depth is number => depth !== null)
  return { totals: { hops: rows.length, maxDepth: depths.length === 0 ? 0 : Math.max(...depths), chatterMessages: rows.reduce((total, row) => total + row.chatterCount, 0), widestTurn }, hops: rows }
}

function display(measure: TokenMeasure): string {
  return measure.tokens === null ? `unknown (${measure.reason ?? 'no reason recorded'})` : `${measure.tokens}${measure.source === 'transcript' ? '' : ` (${measure.source})`}`
}

export function formatDelegationHopCostMarkdown(report: DelegationHopCostReport): string {
  const lines = [
    '# Delegation Hop Cost',
    '',
    `Hops: ${report.totals.hops} | Max depth: ${report.totals.maxDepth} | Chatter messages: ${report.totals.chatterMessages} | Widest turn: ${report.totals.widestTurn}`,
    '',
    '| Depth | Delegate | Prompt tokens | Returned tokens | Launch stub | Chatter | Chatter re-ingest fresh/cache |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const row of report.hops) lines.push(`| ${row.depth ?? 'unknown (unresolved parent)'} | ${row.delegateName ?? 'unknown'} (${row.delegateId ?? 'unknown (spawn result has no agent id)'}) | ${display(row.promptTokens)} | ${display(row.returnedTokens)} | ${row.launchStubTokens === undefined ? '-' : display(row.launchStubTokens)} | ${row.chatterCount} | ${display(row.chatterFreshTokens)} / ${display(row.chatterCacheReadTokens)} |`)
  return lines.join('\n') + '\n'
}
