import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { AWAITING_FIDELITY_RESULT, createLifecycleServer, LIFECYCLE_MCP_KEY, lifecycleToolName } from './sdk-pilot-lifecycle-server.mjs'
import { deriveRoute } from './route-from-card.mjs'

export const DEFAULT_TIMEOUT = 5400
const POLL_MS = 250

export function parsePilotRunnerArgs(argv) {
  const options = { card: null, cardFile: null, dir: null, profileEnv: null, contract: null, hard: false, mailbox: null, room: null, timeout: DEFAULT_TIMEOUT }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--card') options.card = argv[++i] ?? null
    else if (arg === '--card-file') options.cardFile = argv[++i] ?? null
    else if (arg === '--dir') options.dir = argv[++i] ?? null
    else if (arg === '--profile-env') options.profileEnv = argv[++i] ?? null
    else if (arg === '--contract') options.contract = argv[++i] ?? null
    else if (arg === '--mailbox') options.mailbox = argv[++i] ?? null
    else if (arg === '--room') options.room = argv[++i] ?? null
    else if (arg === '--timeout') options.timeout = Number(argv[++i])
    else if (arg === '--hard') options.hard = true
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `unknown argument: ${arg}` }
  }
  if (!options.card || !options.dir) return { error: 'missing required --card or --dir' }
  if (!Number.isFinite(options.timeout) || options.timeout <= 0) return { error: '--timeout must be a positive number of seconds' }
  options.dir = resolve(options.dir)
  options.contract = resolve(options.contract ?? join(dirname(new URL(import.meta.url).pathname), '../../autonomy/PILOT-CONTRACT.md'))
  options.mailbox = resolve(options.mailbox ?? join(options.dir, '.lane', 'pilot-mailbox.txt'))
  if (options.profileEnv) options.profileEnv = resolve(options.profileEnv)
  if (options.cardFile) options.cardFile = resolve(options.cardFile)
  return options
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

function textFrom(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textFrom).join('\n')
  if (value && typeof value === 'object') return Object.values(value).map(textFrom).join('\n')
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

export function lifecycleCanUseTool(worktree, toolName, input) {
  if (['transition', 'write_artifact', 'run'].map(lifecycleToolName).includes(toolName)) return { behavior: 'allow' }
  if (!['Read', 'Glob', 'Grep'].includes(toolName)) return { behavior: 'deny', message: `tool refused: ${toolName}` }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { behavior: 'deny', message: `invalid tool input: ${toolName}` }
  const requested = input.file_path ?? input.path ?? worktree
  if (typeof requested !== 'string') return { behavior: 'deny', message: `invalid path: ${String(requested)}` }
  const pattern = input.pattern
  if (toolName === 'Glob' && typeof pattern === 'string' && (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) && !confinedToWorktree(worktree, pattern)) return { behavior: 'deny', message: `path outside worktree: ${pattern}` }
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

export async function runPilot(options, dependencies) {
  const { query, resolvePilotModels, now = () => Date.now(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), env = process.env, writeFile = writeFileSync, exists = existsSync, readFile = readFileSync, oldLifecycleHook = null, lifecycleOptions = {}, log = (line) => process.stdout.write(`${line}\n`) } = dependencies
  const profileEnv = loadProfileEnv(options.profileEnv)
  const models = resolvePilotModels({ env, settingsEnv: profileEnv })
  const model = options.hard ? models.pilotHard : models.pilot
  const contract = readFile(options.contract, 'utf8')
  const cardText = options.cardFile ? readFile(options.cardFile, 'utf8') : ''
  const routing = deriveRoute(cardText)
  const report = join(options.dir, '.lane', 'pilot-report.md')
  const usagePath = join(options.dir, '.lane', 'usage.json')
  const summaryPath = join(options.dir, '.lane', 'summary.json')
  const transcriptPath = join(options.dir, '.lane', 'sdk-transcript.json')
  const started = now()
  const totals = { input: 0, cache_creation: 0, cache_read: 0, output: 0 }
  const turns = []
  const transcript = []
  const tools = []
  let turnTools = []
  let mailboxLines = 0
  let completed = false
  let injectedTurns = 0
  let silenceInjections = 0
  let longestToolCallMs = 0
  const startedTools = new Map()
  const lifecycleCalls = new Set()
  let awaitingFidelityReceipt = false
  let initReceiptSeen = false
  const pluginRoot = resolve(dirname(new URL(import.meta.url).pathname), '../..')
  const guardPlugin = join(pluginRoot, 'hooks-modules', 'pilot-guard')

  // B5: completion is `awaiting_fidelity receipt && report exists`, so a report left by an earlier
  // run would satisfy it without this session ever writing one. Refuse to start on a dirty lane.
  if (exists(report)) throw new Error(`SDK pilot preflight failed: ${report} already exists; a stale report would satisfy completion`)
  if (exists(oldLifecycleHook ?? join(pluginRoot, 'hooks-modules', 'sdk-pilot-lifecycle'))) throw new Error('SDK pilot preflight failed: old lifecycle hook is still present')
  try { execFileSync('git', ['check-ignore', '.lane'], { cwd: options.dir, stdio: 'ignore' }) } catch { throw new Error('SDK pilot preflight failed: .lane must be git-ignored') }
  for (const file of [join(guardPlugin, 'hooks', 'hooks.json'), join(guardPlugin, 'hooks', 'hooks.js')]) {
    if (!existsSync(file)) throw new Error(`SDK pilot preflight failed: required plugin file is absent: ${file}`)
  }
  const lifecycleServer = createLifecycleServer({ worktree: options.dir, route: routing.route, reasons: routing.reasons, models: { lane: 'openai/gpt-5.6-terra', review: 'openai/gpt-5.6-sol' }, cardId: options.card, sessionTag: `${options.card}-${started}`, ...lifecycleOptions })

  async function* prompt() {
    const standing = `Pilot card ${options.card} in ${options.dir}. Launch executor lanes only through the lifecycle run tool and end your turn immediately after launch.${options.room ? ` Owner room: ${options.room}.` : ''}`
    const card = options.cardFile ? cardText : null
    yield { type: 'user', message: { role: 'user', content: card === null ? standing : `${standing}\n\n## The card, verbatim\n\n${card}\n\ndo not re-read the card from the board; the text above is the card` } }
    while (!completed && now() - started < options.timeout * 1000) {
      if (awaitingFidelityReceipt && exists(report)) { completed = true; return }
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
      const content = 'Runner timeout reached. Write .lane/pilot-report.md with the current state and end your turn.'
      injectedTurns += 1
      log(`injected: timeout ${content}`)
      yield { type: 'user', message: { role: 'user', content } }
    }
  }

  const stream = query({ prompt: prompt(), options: {
    model: model.value,
    systemPrompt: contract,
    settingSources: [],
    maxTurns: 120,
    cwd: options.dir,
    plugins: [{ type: 'local', path: guardPlugin }],
    tools: ['Read', 'Glob', 'Grep'],
    mcpServers: { planka: { type: 'http', url: 'http://localhost:25478/mcp' }, [LIFECYCLE_MCP_KEY]: lifecycleServer },
    canUseTool: async (toolName, input) => lifecycleCanUseTool(options.dir, toolName, input),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    env: { ...env, ...profileEnv, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
  } })
  for await (const message of stream) {
    transcript.push(message)
    if (!initReceiptSeen && !(message.type === 'system' && message.subtype === 'init')) {
      throw new Error('SDK pilot initialization receipt never arrived: the first message was ' + message.type + '/' + (message.subtype ?? 'none'))
    }
    if (message.type === 'system' && message.subtype === 'init') {
      initReceiptSeen = true
      const initTools = Array.isArray(message.tools) ? message.tools : []
      const initPlugins = Array.isArray(message.plugins) ? message.plugins : []
      const missing = ['transition', 'write_artifact', 'run'].map(lifecycleToolName).filter((tool) => !initTools.includes(tool))
      const absent = [guardPlugin].filter((path) => !initPlugins.some((plugin) => plugin.path === path))
      if (missing.length > 0 || absent.length > 0) {
        throw new Error(`SDK pilot initialization receipt is missing plugins or lifecycle tools: ${JSON.stringify({ missingTools: missing, absentPlugins: absent, tools: initTools, plugins: initPlugins })}`)
      }
    }
    const content = message.message?.content
    if (Array.isArray(content)) for (const item of content) {
        if (item.type === 'tool_use') {
        tools.push(item.name)
        turnTools.push(item.name)
          if (item.id) startedTools.set(item.id, now())
          if (item.id && item.name === lifecycleToolName('transition')) lifecycleCalls.add(item.id)
      }
        if (item.type === 'tool_result' && item.tool_use_id && startedTools.has(item.tool_use_id)) {
        longestToolCallMs = Math.max(longestToolCallMs, now() - startedTools.get(item.tool_use_id))
        startedTools.delete(item.tool_use_id)
        }
        if (item.type === 'tool_result' && lifecycleCalls.has(item.tool_use_id)) {
          const lifecycleResult = textFrom(item.content)
          log(`lifecycle: ${lifecycleResult}`)
          if (lifecycleResult.includes(AWAITING_FIDELITY_RESULT)) awaitingFidelityReceipt = true
        }
    }
    if (message.type === 'result') {
      const usage = usageOf(message)
      turns.push({ ...usage, tool_names: [...new Set(turnTools)] })
      turnTools = []
      for (const key of Object.keys(totals)) totals[key] += usage[key]
    }
  }
  // B4: returning normally here made the runner fail-open — a stream that ended before the pilot
  // reached awaiting_fidelity produced a summary that read like an ordinary finished run.
  if (!initReceiptSeen) throw new Error('SDK pilot run ended without an initialization receipt')
  const freshTokens = totals.input + totals.cache_creation + totals.output
  const usage = { turns, totals, fresh_tokens: freshTokens, tool_names: [...new Set(tools)] }
  let lifecycleSummary = {}
  try { lifecycleSummary = JSON.parse(readFile(summaryPath, 'utf8')) } catch { /* no transition reached the summary yet */ }
  const completedNormally = awaitingFidelityReceipt && exists(report)
  const summary = { ...lifecycleSummary, fresh_tokens: freshTokens, turns: turns.length, injected_turns: injectedTurns, silence_injections: silenceInjections, minutes: (now() - started) / 60000, longest_tool_call_ms: longestToolCallMs, model: model.value, effective_model: model.effective, report_exists: exists(report), awaiting_fidelity_receipt: awaitingFidelityReceipt, completed: completedNormally, reason: completedNormally ? undefined : 'stream ended without awaiting_fidelity lifecycle receipt' }
  writeFile(usagePath, `${JSON.stringify(usage, null, 2)}\n`)
  writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`)
  return { usage, summary, exitCode: completedNormally ? 0 : 1 }
}
