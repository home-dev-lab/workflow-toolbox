import fs from 'node:fs'
import path from 'node:path'
import { confinedToWorktree } from './pilot-runner-core.mjs'

const MAX_UNPRODUCTIVE_TURNS = 3
const WAVE_TOOLS = new Set([
  'wave_state',
  'read_card',
  'read_card_report',
  'read_diff',
  'decide',
  'write_judgment',
].map((name) => `mcp__sdk-wave-lifecycle__${name}`))

export function waveCanUseTool(waveDir, toolName, input) {
  if (WAVE_TOOLS.has(toolName)) return { behavior: 'allow' }
  if (!['Read', 'Glob', 'Grep'].includes(toolName)) return { behavior: 'deny', message: `tool refused by wave judge: ${toolName}` }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { behavior: 'deny', message: `invalid tool input: ${toolName}` }
  const requested = input.file_path ?? input.path ?? waveDir
  if (typeof requested !== 'string') return { behavior: 'deny', message: `invalid path: ${String(requested)}` }
  const pattern = toolName === 'Glob' ? input.pattern : (input.glob ?? input.pattern)
  if ((toolName === 'Glob' || toolName === 'Grep') && typeof pattern === 'string') {
    if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) return { behavior: 'deny', message: `path outside wave directory: ${pattern}` }
  }
  return confinedToWorktree(waveDir, requested)
    ? { behavior: 'allow' }
    : { behavior: 'deny', message: `path outside wave directory: ${requested}` }
}

function messageQueue() {
  const values = []
  const waiters = []
  let closed = false
  return {
    push(value) { const waiter = waiters.shift(); if (waiter) waiter({ value, done: false }); else values.push(value) },
    close() { closed = true; for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true }) },
    async next() {
      if (values.length) return { value: values.shift(), done: false }
      if (closed) return { value: undefined, done: true }
      return new Promise((resolve) => waiters.push(resolve))
    },
  }
}

export function createSdkJudge({ query, models, waveDir, waveServer, contract, env = process.env }) {
  const queue = messageQueue()
  let active = null
  let consumePromise = null
  let exhausted = false
  let consecutiveWithoutProgress = 0
  let completedTurnPending = false

  const prompt = async function* () {
    for (;;) {
      const next = await queue.next()
      if (next.done) return
      yield { type: 'user', message: { role: 'user', content: next.value } }
    }
  }
  const remainingUndecided = () => {
    for (const [id, state] of Object.entries(waveServer.state().cards)) {
      if (state === 'judging') waveServer.setCardState(id, 'undecided')
    }
  }
  const settleProgress = () => {
    if (!active?.complete()) return false
    consecutiveWithoutProgress = 0
    const { resolve } = active
    active = null
    resolve(true)
    return true
  }
  const stopIncomplete = () => {
    if (exhausted) return
    exhausted = true
    remainingUndecided()
    const pending = active
    active = null
    pending?.resolve(false)
    queue.close()
  }
  const start = () => {
    if (consumePromise) return
    const stream = query({ prompt: prompt(), options: {
      model: (models.sdkOrchestrator ?? models.orchestrator).value,
      systemPrompt: contract,
      settingSources: [],
      permissionMode: 'default',
      cwd: waveDir,
      tools: ['Read', 'Glob', 'Grep'],
      mcpServers: { 'sdk-wave-lifecycle': waveServer },
      canUseTool: async (toolName, input) => waveCanUseTool(waveDir, toolName, input),
      env,
    } })
    consumePromise = (async () => {
      try {
        for await (const message of stream) {
          if (settleProgress()) {
            if (message.type !== 'result') completedTurnPending = true
            continue
          }
          if (message.type === 'result' && completedTurnPending) {
            completedTurnPending = false
            continue
          }
          if (message.type !== 'result' || !active) continue
          consecutiveWithoutProgress += 1
          queue.push(active.continuation)
          if (consecutiveWithoutProgress === MAX_UNPRODUCTIVE_TURNS) stopIncomplete()
        }
      } finally {
        if (active) stopIncomplete()
        else if (!waveServer.state().judgmentWritten) {
          exhausted = true
          remainingUndecided()
          queue.close()
        }
      }
    })()
  }
  const request = (content, continuation, complete) => {
    if (exhausted) return Promise.resolve(false)
    if (active) throw new Error('wave judge request already active')
    const result = new Promise((resolve) => { active = { complete, continuation, resolve } })
    start()
    queue.push(content)
    return result
  }
  const judge = ({ row }) => request(
    `Judge card ${row.id}: read it with read_card, its report with read_card_report, its diff with read_diff, then decide.`,
    `Card ${row.id} is still judging. Use decide for card ${row.id}.`,
    () => waveServer.state().cards[row.id] !== 'judging',
  )
  judge.judgment = async () => {
    const completed = await request(
      'Every card is decided: write_judgment.',
      'The wave judgment is not written. Use write_judgment with ## Independent Review and ## Decisions.',
      () => waveServer.state().judgmentWritten,
    )
    queue.close()
    if (!completed) throw new Error('orchestrator session ended before judgment')
    await consumePromise
    return fs.readFileSync(path.join(waveDir, 'judgment.md'), 'utf8')
  }
  return judge
}
