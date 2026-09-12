import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const NAME = 'sdk-wave-lifecycle'
const require = createRequire(new URL('../../../toolkit/package.json', import.meta.url))
const { createSdkMcpServer, tool } = require('@anthropic-ai/claude-agent-sdk')
const { z } = require('zod')
const terminal = (file) => {
  try { return /(?:^|\n)EXIT=(\S+)\s*$/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? null } catch { return null }
}
const sentenceCount = (value) => (value.match(/[^.!?]+[.!?](?:\s|$)/g) ?? []).length
const toolResult = (text) => ({ content: [{ type: 'text', text }] })
const MAX_DIFF_BYTES = 200 * 1024
const TERMINAL_STATES = new Set(['accepted', 'escalated', 'rejected', 'undecided'])

export function createWaveServer({ waveDir, cards, receipts = {}, sha256 = null }) {
  const root = path.resolve(waveDir)
  fs.mkdirSync(root, { recursive: true })
  const byId = new Map(cards.map((card) => [String(card.id), card]))
  const states = Object.fromEntries(cards.map((card) => [String(card.id), 'pending']))
  const handled = new Map()
  let judgmentWritten = false
  let serial = Promise.resolve()
  const receipt = (card, name) => card.receipts?.[name] ?? receipts[String(card.id)]?.[name] ?? path.join(root, 'cards', String(card.id), `${name}.log`)
  const refuse = (message) => `refused: ${message}`
  const cardFor = (id) => byId.get(String(id))
  const safeFile = (file) => {
    const resolved = path.resolve(file)
    const target = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved
    const relative = path.relative(fs.realpathSync(root), target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null
    return resolved
  }
  const readEvidence = (card, kind, fallback) => {
    const file = safeFile(card?.[kind] ?? fallback)
    if (!file) return refuse(`${kind} outside wave directory: ${card?.[kind]}`)
    try { return fs.readFileSync(file, 'utf8') } catch { return refuse(`missing ${kind}: ${file}`) }
  }
  const dos = (card) => {
    try {
       const file = safeFile(card.cardPath ?? path.join(root, 'cards', String(card.id), 'card.md'))
       if (!file) return []
       const text = fs.readFileSync(file, 'utf8')
      const section = /## Definition of done\s*\n([\s\S]*?)(?=\n## |$)/i.exec(text)?.[1] ?? ''
      return section.split(/\r?\n/).filter((line) => /^- /.test(line))
    } catch { return [] }
  }
  const decide = (args) => {
    const card = cardFor(args.cardId)
    if (!card) return refuse(`unknown card: ${args.cardId}`)
    const shape = JSON.stringify(args)
    if (!args.tool_use_id) return refuse('missing tool_use_id')
    const previous = handled.get(args.tool_use_id)
    if (previous) return previous.shape === shape ? previous.result : refuse('unique tool_use_id')
    if (states[card.id] !== 'judging') return refuse(`card ${card.id} is ${states[card.id]}, expected judging`)
    const required = ['pilot', 'typecheck', 'lint', 'test', 'clean-tree', 'report-findings-check', 'fidelity-verify']
    const missing = required.find((name) => terminal(receipt(card, name)) !== '0')
    if (args.decision === 'accept' && missing) return refuse(`missing ${missing} EXIT=0 receipt: ${receipt(card, missing)}`)
    const pilot = terminal(receipt(card, 'pilot'))
    if (args.decision === 'reject' && (pilot === '1' || pilot === '2')) return refuse(`pilot EXIT=${pilot} requires escalate: ${receipt(card, 'pilot')}`)
    if (args.decision === 'accept') {
       const diff = safeFile(card.diffPath ?? path.join(root, 'cards', String(card.id), 'diff.patch'))
       if (!diff) return refuse(`diff outside wave directory: ${card.diffPath}`)
       try { if (!fs.readFileSync(diff, 'utf8').trim()) return refuse(`missing non-empty diff: ${diff}`) } catch { return refuse(`missing non-empty diff: ${diff}`) }
    }
    const needed = dos(card).length
    const covered = sentenceCount(args.assessment ?? '')
    if (covered < needed) return refuse(`assessment covers ${covered} of ${needed} bullets`)
    states[card.id] = args.decision === 'accept' ? 'accepted' : args.decision === 'escalate' ? 'escalated' : 'rejected'
    const decisionPath = path.join(root, 'cards', String(card.id), 'decision.json')
    fs.mkdirSync(path.dirname(decisionPath), { recursive: true })
    fs.writeFileSync(decisionPath, `${JSON.stringify({ decision: args.decision, reason: args.reason, assessment: args.assessment }, null, 2)}\n`)
    const result = `decided ${args.decision} card=${card.id}`
    handled.set(args.tool_use_id, { shape, result })
    return result
  }
  const queued = async (work) => { const prior = serial; let release; serial = new Promise((done) => { release = done }); await prior; try { return await work() } finally { release() } }
  const server = createSdkMcpServer({ name: NAME, version: '1.0.0', tools: [
    tool('wave_state', 'Read wave states.', {}, async () => toolResult(JSON.stringify(server.state()))),
    tool('read_card', 'Read a card snapshot.', { cardId: z.string() }, async ({ cardId }) => queued(() => { const card = cardFor(cardId); return toolResult(card ? readEvidence(card, 'cardPath', path.join(root, 'cards', cardId, 'card.md')) : refuse(`unknown card: ${cardId}`)) })),
    tool('read_card_report', 'Read a pilot report.', { cardId: z.string() }, async ({ cardId }) => queued(() => { const card = cardFor(cardId); return toolResult(card ? readEvidence(card, 'reportPath', path.join(root, 'cards', cardId, 'pilot-report.md')) : refuse(`unknown card: ${cardId}`)) })),
    tool('read_diff', 'Read a bounded card diff.', { cardId: z.string(), maxBytes: z.number().int().positive().optional() }, async ({ cardId, maxBytes }) => queued(() => { const card = cardFor(cardId); const limit = maxBytes ?? MAX_DIFF_BYTES; if (limit > MAX_DIFF_BYTES) return toolResult(refuse(`maxBytes exceeds ${MAX_DIFF_BYTES}`)); if (!card) return toolResult(refuse(`unknown card: ${cardId}`)); const value = readEvidence(card, 'diffPath', path.join(root, 'cards', cardId, 'diff.patch')); return toolResult(Buffer.byteLength(value) <= limit ? value : Buffer.from(value).subarray(0, limit).toString()) })),
    tool('decide', 'Record a review decision.', { cardId: z.string(), decision: z.enum(['accept', 'escalate', 'reject']), reason: z.string(), assessment: z.string(), tool_use_id: z.string() }, async (args) => queued(() => toolResult(decide(args)))),
    tool('write_judgment', 'Write model judgment prose.', { content: z.string(), tool_use_id: z.string().optional() }, async ({ content, tool_use_id }) => queued(() => { const shape = JSON.stringify({ content, tool_use_id }); if (tool_use_id && handled.has(tool_use_id)) { const previous = handled.get(tool_use_id); return toolResult(previous.shape === shape ? previous.result : refuse('unique tool_use_id')) } if (!/^## Independent Review\b/m.test(content) || !/^## Decisions\b/m.test(content)) return toolResult(refuse('judgment requires ## Independent Review and ## Decisions')); fs.writeFileSync(path.join(root, 'judgment.md'), content); judgmentWritten = true; const result = 'judgment written'; if (tool_use_id) handled.set(tool_use_id, { shape, result }); return toolResult(result) })),
  ] })
  Object.defineProperty(server, 'state', { value: () => ({ cards: { ...states }, judgmentWritten, allDecided: Object.values(states).every((state) => ['accepted', 'escalated', 'rejected', 'undecided'].includes(state)) }) })
  Object.defineProperty(server, 'setCardState', { value: (id, state) => {
    id = String(id)
    if (!byId.has(id)) throw new Error(`unknown card: ${id}`)
    const allowed = states[id] === 'pending' ? ['piloting'] : states[id] === 'piloting' ? ['judging'] : states[id] === 'judging' ? [...TERMINAL_STATES] : []
    if (!allowed.includes(state)) throw new Error(`invalid wave state edge ${states[id]}->${state}`)
    states[id] = state
  } })
  return server
}
