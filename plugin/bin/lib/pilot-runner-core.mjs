import { resolveWorkflowToolboxOption } from './plugin-options.mjs'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AWAITING_FIDELITY_RESULT, createLifecycleServer, LIFECYCLE_MCP_KEY, lifecycleToolName } from './sdk-pilot-lifecycle-server.mjs'
import { MAX_CRITIC_ROUNDS, PLAN_SHAPE_DESCRIPTION } from './lifecycle-state-machine.mjs'
import { deriveRoute } from './route-from-card.mjs'
import { cardDefinitionOfDone } from './card-definition-of-done.mjs'
import { resolveExecutorProfile as defaultResolveExecutorProfile } from './pilot-model-config.mjs'
import { knowledgeBasePromptLine, knowledgeBaseReadAllowed, resolveKnowledgeBaseIndex } from './knowledge-base-index.mjs'
import { composeStandingPrompt, loadRules } from './rules-manifest.mjs'
import { appendCostReport, computeRunCost, unknownRunCost } from './run-cost-core.mjs'
import { createBoardClient } from './board-http-client.mjs'
import { assertSdkRoleReceipt, composeSdkRoleQueryOptions, prepareSdkRole } from './sdk-role-profile.mjs'
import { writeWorktreeRetentionMarker } from './lifecycle-report-edge.mjs'

export const DEFAULT_TIMEOUT = 5400
const POLL_MS = 250
const MAX_UNPRODUCTIVE_TURNS = 3
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const NEXT_BY_PHASE = {
  discovery: 'transition discovery using the frozen route',
  plan: `write the plan matching ${PLAN_SHAPE_DESCRIPTION}, then transition plan`,
  critic: `write the critic brief, run the critic lane, then transition critic; if critic round ${MAX_CRITIC_ROUNDS} requests blocking changes, transition with outcome changes-requested; the server routes a spent bound to report`,
  tdd: 'write the tdd brief, run the tdd lane, then transition tdd',
  verify: 'run the three gates, then transition verify',
  review: 'write the review brief, run the review lane, then transition review; if the lane requests changes for the fourth time, transition with outcome changes-requested — the server routes a spent bound to report',
  refutation: 'write the refutation brief, run the refutation lane, then transition refutation; if the lane requests changes for the fourth time, transition with outcome changes-requested — the server routes a spent bound to report',
  harden: 'write the harden brief, run the harden lane, then transition harden',
  report: 'write the pilot report, then transition report',
}
const PLANKA_TOOLS = new Set([
  'mcp__planka__get_card',
  'mcp__planka__get_comments',
  'mcp__planka__add_comment',
  'mcp__planka__update_card',
  'mcp__planka__move_card',
  'mcp__planka__add_label_to_card',
])

export function parsePilotRunnerArgs(argv) {
  const options = { card: null, cardFile: null, dir: null, profileEnv: null, contract: null, boardContract: null, hard: false, mailbox: null, knowledgeBaseIndex: null, archiveRoot: null, pluginDirs: [], timeout: DEFAULT_TIMEOUT }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--card') options.card = argv[++i] ?? null
    else if (arg === '--card-file') options.cardFile = argv[++i] ?? null
    else if (arg === '--dir') options.dir = argv[++i] ?? null
    else if (arg === '--profile-env') options.profileEnv = argv[++i] ?? null
    else if (arg === '--contract') options.contract = argv[++i] ?? null
    else if (arg === '--board-contract') options.boardContract = argv[++i] ?? null
    else if (arg === '--mailbox') options.mailbox = argv[++i] ?? null
    else if (arg === '--knowledge-base-index') options.knowledgeBaseIndex = argv[++i] ?? null
    else if (arg === '--archive-root') options.archiveRoot = argv[++i] ?? null
    else if (arg === '--plugin-dir') {
      const pluginDir = argv[++i] ?? ''
      if (!isAbsolute(pluginDir)) return { error: `--plugin-dir must be an absolute path: ${pluginDir}` }
      options.pluginDirs.push(resolve(pluginDir))
    }
    else if (arg === '--timeout') options.timeout = Number(argv[++i])
    else if (arg === '--hard') options.hard = true
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `unknown argument: ${arg}` }
  }
  if (!options.card || !options.dir) return { error: 'missing required --card or --dir' }
  if (!options.cardFile) return { error: '--card-file is required: the route is derived from the card' }
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) return { error: '--timeout must be a positive number of seconds' }
  options.dir = resolve(options.dir)
  options.contract = resolve(options.contract ?? join(MODULE_DIR, '../../autonomy/PILOT-CONTRACT.md'))
  options.mailbox = resolve(options.mailbox ?? join(options.dir, '.lane', 'pilot-mailbox.txt'))
  if (options.profileEnv) options.profileEnv = resolve(options.profileEnv)
  if (options.cardFile) options.cardFile = resolve(options.cardFile)
  if (options.archiveRoot) options.archiveRoot = resolve(options.archiveRoot)
  if (options.boardContract) options.boardContract = resolve(options.boardContract)
  return options
}

export function loadBoardContract(value, readFile = readFileSync) {
  if (!value) return null
  let contract = value
  if (typeof value === 'string') {
    try { contract = JSON.parse(readFile(value, 'utf8')) } catch (error) { throw new Error(`cannot read --board-contract: ${error.message}`) }
  }
  const fields = [
    ['boardId', contract?.boardId], ['listId', contract?.listId], ['labels.category', contract?.labels?.category],
    ...['P0', 'P1', 'P2'].map((key) => [`labels.priority.${key}`, contract?.labels?.priority?.[key]]),
    ...['bug', 'chore', 'feature', 'research'].map((key) => [`labels.type.${key}`, contract?.labels?.type?.[key]]),
    ...['S', 'M', 'L'].map((key) => [`labels.effort.${key}`, contract?.labels?.effort?.[key]]),
  ]
  const invalid = fields.find(([, field]) => typeof field !== 'string' || !field)
  if (invalid) throw new Error(`--board-contract requires non-empty ${invalid[0]}`)
  return contract
}

// Where a lifecycle archive lands when nothing names it: the project root when the caller resolved one,
// else the main checkout that OWNS the worktree (`--git-common-dir` is `<main>/.git` from any worktree).
// A plain repository resolves to itself and is refused at preflight — there is no outside to archive to.
export function defaultArchiveRoot({ dir, projectRoot = null }) {
  if (projectRoot) return resolve(projectRoot)
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (common) return dirname(common)
  } catch {}
  return resolve(dir)
}

export function loadProfileEnv(file) {
  if (!file) return {}
  let parsed
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { throw new Error(`cannot read --profile-env: ${error.message}`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) {
    throw new Error('--profile-env must be a settings JSON object with an env object')
  }
  for (const [key, value] of Object.entries(parsed.env)) if (typeof value !== 'string') throw new Error(`--profile-env env.${key} must be a string`)
  return parsed.env
}

// The real SDK stream delivers a tool result as content blocks (`[{ type: 'text', text }]`); a text
// block yields its text alone — concatenating every object value put "text" in front of the lifecycle
// result and neither the completion equality nor the progress count matched (real run 2, 2026-09-11).
function textFrom(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textFrom).join('\n')
  if (value && typeof value === 'object') {
    if (value.type === 'text' && typeof value.text === 'string') return value.text
    return Object.values(value).map(textFrom).join('\n')
  }
  return ''
}

// Resolve through existing symlinks before comparing, so lexical `..` and links cannot escape.
export function confinedToWorktree(root, requested) {
  const absolute = resolve(root, typeof requested === 'string' ? requested : '.')
  let probe = absolute
  const suffix = []
  while (!existsSync(probe)) { suffix.unshift(basename(probe)); probe = dirname(probe) }
  const resolved = resolve(realpathSync(probe), ...suffix)
  return relative(realpathSync(root), resolved) === '' || !relative(realpathSync(root), resolved).startsWith('..')
}

export function lifecycleCanUseTool(worktree, toolName, input, { boardMoves = true, knowledgeBaseIndex = null, profile = null } = {}) {
  if (['transition', 'write_artifact', 'route_finding', 'run'].map(lifecycleToolName).includes(toolName)) return { behavior: 'allow' }
  if (toolName === 'mcp__planka__move_card' && !boardMoves) return { behavior: 'deny', message: 'board moves are the orchestrator\'s' }
  if (PLANKA_TOOLS.has(toolName)) return { behavior: 'allow' }
  if (profile?.tools.includes(toolName) && !['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'].includes(toolName)) return { behavior: 'allow' }
  if (!['Read', 'Glob', 'Grep'].includes(toolName)) return { behavior: 'deny', message: `tool refused: ${toolName}` }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { behavior: 'deny', message: `invalid tool input: ${toolName}` }
  const requested = input.file_path ?? input.path ?? worktree
  if (typeof requested !== 'string') return { behavior: 'deny', message: `invalid path: ${String(requested)}` }
  if (toolName === 'Read' && knowledgeBaseReadAllowed(knowledgeBaseIndex, requested)) return { behavior: 'allow' }
  const pattern = toolName === 'Glob' ? input.pattern : (input.glob ?? input.pattern)
  if ((toolName === 'Glob' || toolName === 'Grep') && typeof pattern === 'string' && /[\\/]/.test(pattern)) {
    const segments = pattern.split(/[\\/]/)
    const wildcard = segments.findIndex((segment) => /[*?[{]/.test(segment))
    const prefix = segments.slice(0, wildcard < 0 ? segments.length : wildcard).join('/') || '.'
    const base = input.path ?? worktree
    const requestedPrefix = resolve(worktree, base, prefix)
    if (!confinedToWorktree(worktree, requestedPrefix)) return { behavior: 'deny', message: `path outside worktree: ${pattern}` }
  }
  return confinedToWorktree(worktree, requested) ? { behavior: 'allow' } : { behavior: 'deny', message: `path outside worktree: ${requested}` }
}

function usageOf(message) {
  const usage = message.usage ?? {}
  return {
    input: usage.input_tokens ?? 0,
    cache_creation: usage.cache_creation_input_tokens ?? 0,
    cache_read: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  }
}

function addModelUsage(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return
  for (const [model, usage] of Object.entries(source)) {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue
    const total = target[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0 }
    for (const field of Object.keys(total)) total[field] += Number(usage[field]) || 0
    target[model] = total
  }
}

function servedModelAgreement({ requestedModel, servedModel, servedModelFirstTurn, initReceiptSeen, firstAssistantSeen }) {
  if (!initReceiptSeen) return 'unknown (initialization receipt never arrived)'
  if (servedModel === undefined) return 'unknown (init receipt carries no model)'
  if (!firstAssistantSeen) return 'unknown (stream carries no assistant message)'
  if (servedModelFirstTurn === undefined) return 'unknown (first assistant message carries no model)'
  // Agreement is between the two SDK readings of what was SERVED (the init receipt and the first
  // assistant message). The requested value is an ALIAS or a full id the resolver chose; a remapped
  // profile serves a different id on purpose, so string-equality against the request would read
  // `false` on every correct remap. The request is recorded beside, for the reader, never compared.
  if (servedModel === servedModelFirstTurn) return true
  return `false (served_model=${servedModel}, served_model_first_turn=${servedModelFirstTurn}; requested_model=${requestedModel})`
}

const RECEIPT_ERROR = 'SDK pilot initialization receipt is missing plugins or lifecycle tools: '

function assertPilotInitReceipt(message, sdkRole) {
  const initTools = Array.isArray(message.tools) ? message.tools : []
  const missing = ['transition', 'write_artifact', 'route_finding', 'run'].map(lifecycleToolName).filter((tool) => !initTools.includes(tool))
  try { assertSdkRoleReceipt('pilot', message, sdkRole) } catch (error) {
    throw new Error(RECEIPT_ERROR + (error instanceof Error ? error.message : String(error)), { cause: error })
  }
  if (missing.length > 0) throw new Error(RECEIPT_ERROR + JSON.stringify({ missingTools: missing, tools: initTools }))
}

export async function runPilot(options, dependencies) {
  const { query, resolvePilotModels, now = () => Date.now(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), env = process.env, writeFile = writeFileSync, exists = existsSync, readFile = readFileSync, oldLifecycleHook = null, lifecycleOptions = {}, log = (line) => process.stdout.write(`${line}\n`) } = dependencies
  const profileEnv = loadProfileEnv(options.profileEnv)
  if ((options.pluginDirs ?? []).some((pluginDir) => !isAbsolute(pluginDir))) throw new Error('--plugin-dir must be an absolute path')
  const effectiveEnv = { ...env, ...profileEnv }
  const knowledgeBase = resolveKnowledgeBaseIndex({ promptValue: options.knowledgeBaseIndex, env: effectiveEnv, projectRoot: options.knowledgeBaseProjectRoot ?? options.dir, exists })
  const models = resolvePilotModels({ env, settingsEnv: profileEnv })
  const model = options.hard ? (models.sdkPilotHard ?? models.pilotHard) : (models.sdkPilot ?? models.pilot)
  // Defaults for programmatic callers (the orchestrator driver): the CLI's parser sets these, runPilot
  // called directly did not — the first real wave died on a `path` of undefined.
  const contractPath = options.contract ?? resolve(MODULE_DIR, '../../autonomy/PILOT-CONTRACT.md')
  const mailboxPath = options.mailbox ?? join(options.dir, '.lane', 'pilot-mailbox.txt')
  options = { ...options, contract: contractPath, mailbox: mailboxPath }
  const contract = readFile(options.contract, 'utf8')
  // The project manifest lives with the project, not in each generated card worktree: resolve it
  // from the same project root the knowledge-base index uses.
  const rules = dependencies.rules ?? loadRules({ projectRoot: options.knowledgeBaseProjectRoot ?? options.dir })
  const systemPrompt = composeStandingPrompt(contract, rules)
  if (!options.cardFile) throw new Error('--card-file is required: the route is derived from the card')
  const cardText = readFile(options.cardFile, 'utf8')
  const boardContract = loadBoardContract(options.boardContract, readFile)
  if (cardDefinitionOfDone(cardText).length === 0) throw new Error('SDK pilot preflight failed: ask the owner to add a Definition of done to the card')
  const routing = deriveRoute(cardText)
  const executorProfile = (dependencies.resolveExecutorProfile ?? defaultResolveExecutorProfile)({ worktree: options.dir, route: routing.route, hard: options.hard, env, settingsEnv: profileEnv })
  log(`route=${routing.route} reasons=${routing.reasons.join(',')} model=${model.value} effective=${model.effective} executor=${executorProfile.executor}`)
  const report = join(options.dir, '.lane', 'pilot-report.md')
  const usagePath = join(options.dir, '.lane', 'usage.json')
  const summaryPath = join(options.dir, '.lane', 'summary.json')
  const transcriptPath = join(options.dir, '.lane', 'sdk-transcript.json')
  const started = now()
  const totals = { input: 0, cache_creation: 0, cache_read: 0, output: 0 }
  const turns = []
  const messages = []
  const modelUsage = {}
  const transcript = []
  const tools = []
  let turnTools = []
  let mailboxLines = 0
  let completed = false
  let injectedTurns = 0
  let silenceInjections = 0
  let pendingTurnEnds = 0
  let consecutiveContinuations = 0
  let acceptedLifecycleResults = 0
  let acceptedAtLastContinuation = 0
  let incompleteReason = null
  let longestToolCallMs = 0
  const startedTools = new Map()
  const lifecycleCalls = new Map()
  let awaitingFidelityReceipt = false
  let initReceiptSeen = false
  let servedModel
  let servedModelFirstTurn
  let firstAssistantSeen = false
  let streamError = null
  const pluginRoot = resolve(MODULE_DIR, '../..')
  const configuredPlugins = options.pluginDirs ?? []
  const sdkRole = (dependencies.prepareSdkRole ?? prepareSdkRole)('pilot', { worktree: options.dir, env: effectiveEnv, pluginRoot, adapterOptions: { log } })
  sdkRole.pluginPaths.push(...configuredPlugins)

  // B5: completion is `awaiting_fidelity receipt && report exists`, so a report left by an earlier
  // run would satisfy it without this session ever writing one. Refuse to start on a dirty lane.
  if (exists(report)) throw new Error(`SDK pilot preflight failed: ${report} already exists; a stale report would satisfy completion`)
  if (exists(oldLifecycleHook ?? join(pluginRoot, 'hooks-modules', 'sdk-pilot-lifecycle'))) throw new Error('SDK pilot preflight failed: old lifecycle hook is still present')
  // `.lane/` (a directory pattern) only matches an EXISTING directory: create it before asking git,
  // or a fresh worktree fails the preflight (real wave a2adf9e2).
  mkdirSync(join(options.dir, '.lane'), { recursive: true })
  try { execFileSync('git', ['check-ignore', '.lane'], { cwd: options.dir, stdio: 'ignore' }) } catch { throw new Error('SDK pilot preflight failed: .lane must be git-ignored') }
  const boardUrl = resolveWorkflowToolboxOption('planka_mcp_url', { env: effectiveEnv }).value
  const board = dependencies.board ?? (boardContract && boardUrl ? createBoardClient({ url: boardUrl, boardId: boardContract.boardId }) : null)
  const routeFinding = boardContract
    ? board && typeof board.createRoutedCard === 'function'
      ? (args) => board.createRoutedCard(args)
      : async () => { throw new Error('board unavailable: planka_mcp_url is not configured') }
    : null
  const resolveRoutedFinding = boardContract && board && typeof board.resolveRoutedCard === 'function' ? (card) => board.resolveRoutedCard(card) : null
  const lifecycleServer = createLifecycleServer({ worktree: options.dir, archiveRoot: options.archiveRoot ?? defaultArchiveRoot({ dir: options.dir, projectRoot: options.knowledgeBaseProjectRoot }), route: routing.route, reasons: routing.reasons, executor: executorProfile.executor, executorEnv: { ...env, ...profileEnv }, knowledgeBase, models: executorProfile.models, cardId: options.card, cardText, sessionTag: `${options.card}-${started}`, rules, boardContract, routeFinding, resolveRoutedFinding, lsp: sdkRole.lsp, ...lifecycleOptions })

  async function* prompt() {
    const lspLine = sdkRole.lsp.available ? 'LSP navigation: available' : `LSP navigation: absent (${sdkRole.lsp.reason})`
    const standing = `Pilot card ${options.card} in ${options.dir}. ${knowledgeBasePromptLine(knowledgeBase)} Read that index if present, then open the fiches it lists that bear on this card; they are read-only. ${lspLine}. Include that exact LSP navigation state in the closing report. Lanes run synchronously through the lifecycle run tool. Keep working through every phase until transition report returns the awaiting_fidelity receipt, then write nothing more and end the turn.`
    yield { type: 'user', message: { role: 'user', content: `${standing}\n\n## The card, verbatim\n\n${cardText}\n\ndo not re-read the card from the board; the text above is the card` } }
    while (!completed && now() - started < options.timeout * 1000) {
      if (awaitingFidelityReceipt && exists(report)) { completed = true; return }
      if (pendingTurnEnds > 0) {
        pendingTurnEnds -= 1
        if (acceptedLifecycleResults > acceptedAtLastContinuation) consecutiveContinuations = 0
        consecutiveContinuations += 1
        acceptedAtLastContinuation = acceptedLifecycleResults
        const lifecycleState = lifecycleServer.state()
        const phase = lifecycleState.phase
        const content = lifecycleState.partial && phase === 'report'
          ? `The run is partial (${lifecycleState.partial.reason}): write the pilot report with the line "Partial: ${lifecycleState.partial.reason}", then transition report.`
          : `The run is not complete: current phase ${phase}; next: ${NEXT_BY_PHASE[phase] ?? 'continue the lifecycle'}. Continue.`
        injectedTurns += 1
        log(`injected: continuation ${content}`)
        if (consecutiveContinuations === MAX_UNPRODUCTIVE_TURNS) {
          incompleteReason = `pilot ended its turn ${MAX_UNPRODUCTIVE_TURNS} times without progress`
        }
        yield { type: 'user', message: { role: 'user', content } }
        if (incompleteReason) return
        continue
      }
      const lines = exists(options.mailbox) ? readFile(options.mailbox, 'utf8').split(/\r?\n/).filter(Boolean) : []
      if (lines.length > mailboxLines) {
        const content = `Message from the owner: ${lines[mailboxLines++]}`
        injectedTurns += 1
        log(`injected: owner message ${content}`)
        yield { type: 'user', message: { role: 'user', content } }
      }
      else await sleep(POLL_MS)
    }
    if (!completed) {
      incompleteReason = 'runner timeout'
      const content = 'Runner timeout reached. Write .lane/pilot-report.md with the current state and end your turn.'
      injectedTurns += 1
      log(`injected: timeout ${content}`)
      yield { type: 'user', message: { role: 'user', content } }
    }
  }

  try {
    const queryOptions = composeSdkRoleQueryOptions({
      model: model.value,
      systemPrompt,
      settingSources: [],
      maxTurns: 120,
      cwd: options.dir,
      // No Planka endpoint configured means no board tools, never a guessed local port.
      mcpServers: { ...(boardUrl ? { planka: { type: 'http', url: boardUrl } } : {}), [LIFECYCLE_MCP_KEY]: lifecycleServer },
      canUseTool: async (toolName, input) => lifecycleCanUseTool(options.dir, toolName, input, { boardMoves: options.boardMoves ?? true, knowledgeBaseIndex: knowledgeBase.path, profile: sdkRole.profile }),
      permissionMode: 'default',
      env: { ...effectiveEnv, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
    }, sdkRole)
    const stream = query({ prompt: prompt(), options: queryOptions })
    for await (const message of stream) {
      transcript.push(message)
      if (!initReceiptSeen && !(message.type === 'system' && (message.subtype === 'init' || message.subtype?.startsWith('hook_')))) {
        throw new Error('SDK pilot initialization receipt never arrived: the first message was ' + message.type + '/' + (message.subtype ?? 'none'))
      }
      if (message.type === 'system' && message.subtype === 'init') {
      initReceiptSeen = true
      servedModel = message.model
      assertPilotInitReceipt(message, sdkRole)
      }
    if (!firstAssistantSeen && message.type === 'assistant') {
      firstAssistantSeen = true
      servedModelFirstTurn = message.message?.model
    }
    if (message.type === 'assistant' && message.message?.usage) {
      // One assistant message is streamed once per content block with the same id and usage: a repeat replaces the
      // recorded usage (keeping the first arrival time), it never adds to it.
      const record = { ...usageOf(message.message), model: message.message.model ?? servedModelFirstTurn ?? servedModel ?? model.value, arrived_at: new Date(now()).toISOString() }
      const messageId = message.message.id
      const previous = messageId ? messages.findIndex((entry) => entry.message_id === messageId) : -1
      if (previous >= 0) messages[previous] = { ...record, message_id: messageId, arrived_at: messages[previous].arrived_at }
      else messages.push(messageId ? { ...record, message_id: messageId } : record)
    }
    const content = message.message?.content
    if (Array.isArray(content)) for (const item of content) {
        if (item.type === 'tool_use') {
        tools.push(item.name)
        turnTools.push(item.name)
          if (item.id) startedTools.set(item.id, now())
          if (item.id && ['transition', 'write_artifact', 'route_finding', 'run'].map(lifecycleToolName).includes(item.name)) lifecycleCalls.set(item.id, item.name)
      }
        if (item.type === 'tool_result' && item.tool_use_id && startedTools.has(item.tool_use_id)) {
        longestToolCallMs = Math.max(longestToolCallMs, now() - startedTools.get(item.tool_use_id))
        startedTools.delete(item.tool_use_id)
        }
        if (item.type === 'tool_result' && lifecycleCalls.has(item.tool_use_id)) {
          const lifecycleResult = textFrom(item.content)
          log(`lifecycle: ${lifecycleResult}`)
          const lifecycleName = lifecycleCalls.get(item.tool_use_id)
          if (/^(?:accepted phase=|wrote |lane \S+ EXIT=0$|gate \S+ EXIT=0$)/.test(lifecycleResult.trim())) acceptedLifecycleResults += 1
          if (lifecycleName === lifecycleToolName('transition') && lifecycleResult.trim() === AWAITING_FIDELITY_RESULT) awaitingFidelityReceipt = true
          lifecycleCalls.delete(item.tool_use_id)
        }
    }
    if (message.type === 'result') {
      const usage = usageOf(message)
      addModelUsage(modelUsage, message.modelUsage)
      turns.push({ ...usage, model: servedModelFirstTurn ?? servedModel ?? model.value, ended_at: new Date(now()).toISOString(), tool_names: [...new Set(turnTools)] })
      turnTools = []
      for (const key of Object.keys(totals)) totals[key] += usage[key]
      if (!completed) pendingTurnEnds += 1
    }
    }
    if (!initReceiptSeen) throw new Error('SDK pilot run ended without an initialization receipt')
  } catch (error) {
    streamError = error
    if (initReceiptSeen) incompleteReason = `sdk stream error: ${error instanceof Error ? error.message : String(error)}`
  }
  // B4: returning normally here made the runner fail-open — a stream that ended before the pilot
  // reached awaiting_fidelity produced a summary that read like an ordinary finished run.
  if (!initReceiptSeen) throw streamError
  const freshTokens = totals.input + totals.cache_creation + totals.output
  const usage = { messages, result_totals: totals, model_usage: Object.keys(modelUsage).length > 0 ? modelUsage : undefined, turns, totals, fresh_tokens: freshTokens, tool_names: [...new Set(tools)] }
  const completedNormally = awaitingFidelityReceipt && exists(report)
  let finalizationError = null
  if (!completedNormally) {
    try { lifecycleServer.finalizePartial(incompleteReason ?? 'stream ended without awaiting_fidelity lifecycle receipt') } catch (error) { finalizationError = error }
  }
  let lifecycleSummary = {}
  try { lifecycleSummary = JSON.parse(readFile(summaryPath, 'utf8')) } catch { /* no transition reached the summary yet */ }
  const partial = lifecycleSummary.partial ?? lifecycleServer.state().partial ?? null
  const servedModelAgreementValue = servedModelAgreement({ requestedModel: model.value, servedModel, servedModelFirstTurn, initReceiptSeen, firstAssistantSeen })
  const ended = now()
  const summary = { ...lifecycleSummary, runner_started_at: new Date(started).toISOString(), runner_ended_at: new Date(ended).toISOString(), partial, fresh_tokens: freshTokens, turns: turns.length, injected_turns: injectedTurns, silence_injections: silenceInjections, minutes: (ended - started) / 60000, longest_tool_call_ms: longestToolCallMs, model: model.value, effective_model: model.effective, requested_model: model.value, requested_model_source: model.source, requested_model_effective: model.effective, requested_model_remapped_by: model.remappedBy, served_model: servedModel, served_model_first_turn: servedModelFirstTurn, served_model_agreement: servedModelAgreementValue, report_exists: exists(report), awaiting_fidelity_receipt: awaitingFidelityReceipt, completed: completedNormally, reason: completedNormally ? undefined : incompleteReason ?? 'stream ended without awaiting_fidelity lifecycle receipt' }
  writeFile(usagePath, `${JSON.stringify(usage, null, 2)}\n`)
  writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`)
  writeWorktreeRetentionMarker({ root: options.dir, cardId: options.card, partial, boardId: boardContract?.boardId ?? null, retainedAt: new Date(ended).toISOString() })
  let cost
  try {
    cost = computeRunCost({ laneDir: join(options.dir, '.lane'), worktree: options.dir, startedAt: started, endedAt: ended, route: options.hard ? 'HARD' : routing.route, ...(dependencies.costSessions === undefined ? {} : { sessions: dependencies.costSessions }) })
  } catch (error) {
    cost = unknownRunCost({ route: options.hard ? 'HARD' : routing.route, worktree: options.dir, reason: `cost computation failed: ${error instanceof Error ? error.message : String(error)}` })
  }
  try {
    const costContent = `${JSON.stringify(cost, null, 2)}\n`
    writeFile(join(options.dir, '.lane', 'cost.json'), costContent)
    let costReport = null
    if (exists(report)) {
      costReport = appendCostReport(readFile(report, 'utf8'), cost)
      writeFile(report, costReport)
    }
    const archive = lifecycleSummary.archive?.path
    if (archive) {
      writeFile(join(archive, 'usage.json'), `${JSON.stringify(usage, null, 2)}\n`)
      writeFile(join(archive, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
      writeFile(join(archive, 'sdk-transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`)
      writeFile(join(archive, 'cost.json'), costContent)
      if (costReport !== null) writeFile(join(archive, 'pilot-report.md'), costReport)
    }
  } catch (error) {
    log(`cost receipt unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  log(`served model: ${servedModel ?? 'unknown'} (requested ${model.value})`)
  if (finalizationError) throw finalizationError
  if (streamError) throw streamError
  return { usage, summary, exitCode: completedNormally ? (partial ? 2 : 0) : 1 }
}
