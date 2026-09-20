import fs from 'node:fs'
import path from 'node:path'
import { confinedToWorktree } from './pilot-runner-core.mjs'
import { knowledgeBasePromptLine, knowledgeBaseReadAllowed, resolveKnowledgeBaseIndex } from './knowledge-base-index.mjs'
import { assertSdkRoleReceipt, composeSdkRoleQueryOptions, prepareSdkRole } from './sdk-role-profile.mjs'
import { resolveRoleVariant } from './lane-model-allowlist.mjs'

const MAX_UNPRODUCTIVE_TURNS = 3
const WAVE_TOOLS = new Set([
  'wave_state',
  'read_card',
  'read_card_report',
  'read_diff',
  'decide',
  'write_judgment',
].map((name) => `mcp__sdk-wave-lifecycle__${name}`))

export function waveCanUseTool(waveDir, toolName, input, { knowledgeBaseIndex = null, profile = null } = {}) {
  if (WAVE_TOOLS.has(toolName)) return { behavior: 'allow' }
  if (profile?.tools.includes(toolName) && !['Read', 'Glob', 'Grep'].includes(toolName)) return { behavior: 'allow' }
  if (!['Read', 'Glob', 'Grep'].includes(toolName)) return { behavior: 'deny', message: `tool refused by wave judge: ${toolName}` }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { behavior: 'deny', message: `invalid tool input: ${toolName}` }
  const requested = input.file_path ?? input.path ?? waveDir
  if (typeof requested !== 'string') return { behavior: 'deny', message: `invalid path: ${String(requested)}` }
  if (toolName === 'Read' && knowledgeBaseReadAllowed(knowledgeBaseIndex, requested)) return { behavior: 'allow' }
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

export function createSdkJudge({ query, models, waveDir, waveServer, contract, env = process.env, knowledgeBaseIndex = null, projectRoot = waveDir, pluginDirs = [], prepareRole = prepareSdkRole }) {
  const knowledgeBase = resolveKnowledgeBaseIndex({ promptValue: knowledgeBaseIndex, env, projectRoot })
  const sdkRole = prepareRole('judge', { worktree: waveDir, env })
  sdkRole.pluginPaths.push(...pluginDirs)
  let knowledgeBaseSent = false
  const withKnowledgeBase = (content) => {
    if (knowledgeBaseSent) return content
    knowledgeBaseSent = true
    return `${knowledgeBasePromptLine(knowledgeBase)}\n${content}`
  }
  const queue = messageQueue()
  let active = null
  let consumePromise = null
  let exhausted = false
  let consecutiveWithoutProgress = 0
  let completedTurnPending = false
  let initReceiptSeen = false
  let failure = null

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
    const model = models.sdkOrchestrator ?? models.orchestrator
    const variant = model.variant ?? resolveRoleVariant('sdkOrchestrator', model.effective ?? model.value, { env })
    const queryOptions = composeSdkRoleQueryOptions({
      model: model.value,
      effort: variant.value,
      systemPrompt: contract,
      settingSources: [],
      permissionMode: 'default',
      cwd: waveDir,
      mcpServers: { 'sdk-wave-lifecycle': waveServer },
      canUseTool: async (toolName, input) => waveCanUseTool(waveDir, toolName, input, { knowledgeBaseIndex: knowledgeBase.path, profile: sdkRole.profile }),
      env: { ...env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
    }, sdkRole)
    const stream = query({ prompt: prompt(), options: queryOptions })
    consumePromise = (async () => {
      try {
        for await (const message of stream) {
          if (!initReceiptSeen && !(message.type === 'system' && (message.subtype === 'init' || message.subtype?.startsWith('hook_')))) {
            throw new Error(`SDK judge initialization receipt never arrived: the first message was ${message.type}/${message.subtype ?? 'none'}`)
          }
          if (message.type === 'system' && message.subtype === 'init') {
            initReceiptSeen = true
            assertSdkRoleReceipt('judge', message, sdkRole)
          }
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
        if (!initReceiptSeen) throw new Error('SDK judge run ended without an initialization receipt')
      } catch (error) {
        failure = error
        exhausted = true
        remainingUndecided()
        const pending = active
        active = null
        pending?.reject(error)
        queue.close()
      } finally {
        if (failure) return
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
    if (failure) return Promise.reject(failure)
    if (exhausted) return Promise.resolve(false)
    if (active) throw new Error('wave judge request already active')
    const result = new Promise((resolve, reject) => { active = { complete, continuation, resolve, reject } })
    start()
    queue.push(content)
    return result
  }
  const judge = ({ row }) => request(
    withKnowledgeBase(`Judge card ${row.id}: read it with read_card, its report with read_card_report, its diff with read_diff, then decide.`),
    withKnowledgeBase(`Card ${row.id} is still judging. Use decide for card ${row.id}.`),
    () => waveServer.state().cards[row.id] !== 'judging',
  )
  judge.judgment = async () => {
    const completed = await request(
      withKnowledgeBase('Every card is decided: write_judgment.'),
      withKnowledgeBase('The wave judgment is not written. Use write_judgment with ## Independent Review and ## Decisions.'),
      () => waveServer.state().judgmentWritten,
    )
    queue.close()
    if (!completed) throw new Error('orchestrator session ended before judgment')
    await consumePromise
    return fs.readFileSync(path.join(waveDir, 'judgment.md'), 'utf8')
  }
  return judge
}
