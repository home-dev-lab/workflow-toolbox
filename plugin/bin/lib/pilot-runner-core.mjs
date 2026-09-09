import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const DEFAULT_TIMEOUT = 5400
const POLL_MS = 250

export function parsePilotRunnerArgs(argv) {
  const options = { card: null, dir: null, profileEnv: null, contract: null, hard: false, mailbox: null, room: null, timeout: DEFAULT_TIMEOUT }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--card') options.card = argv[++i] ?? null
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

export function laneLogFrom(text) {
  const pid = /\bpid=\d+\b/.test(text)
  const log = /\blog=([^\s]+)/.exec(text)?.[1]
  return pid && log ? log : null
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
  const { query, resolvePilotModels, now = () => Date.now(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), env = process.env, writeFile = writeFileSync, exists = existsSync, readFile = readFileSync, stat = statSync } = dependencies
  const profileEnv = loadProfileEnv(options.profileEnv)
  const models = resolvePilotModels({ env, settingsEnv: profileEnv })
  const model = options.hard ? models.pilotHard : models.pilot
  const contract = readFile(options.contract, 'utf8')
  const report = join(options.dir, '.lane', 'report.md')
  const usagePath = join(options.dir, '.lane', 'usage.json')
  const summaryPath = join(options.dir, '.lane', 'summary.json')
  const started = now()
  const totals = { input: 0, cache_creation: 0, cache_read: 0, output: 0 }
  const turns = []
  const tools = []
  const pendingLanes = new Map()
  let laneLaunchSeen = false
  let mailboxLines = 0
  let completed = false
  let longestToolCallMs = 0
  const startedTools = new Map()

  async function* prompt() {
    yield { type: 'user', message: { role: 'user', content: `Pilot card ${options.card} in ${options.dir}. Launch executor lanes only with node ${join(dirname(options.contract), '../bin/wt-lane.mjs')} and end your turn immediately after launch.${options.room ? ` Owner room: ${options.room}.` : ''}` } }
    while (!completed && now() - started < options.timeout * 1000) {
      if (exists(report)) { completed = true; return }
      for (const [log, lane] of pendingLanes) {
        if (!exists(log)) continue
        const content = readFile(log, 'utf8')
        const exit = /(?:^|\n)EXIT=([^\s\n]+)/.exec(content)?.[1]
        if (exit) {
          pendingLanes.delete(log)
          const bytes = exists(report) ? stat(report).size : 0
          yield { type: 'user', message: { role: 'user', content: `lane done: EXIT=${exit}, report ${bytes} B at ${report}` } }
          lane.done = true
        }
      }
      const lines = exists(options.mailbox) ? readFile(options.mailbox, 'utf8').split(/\r?\n/).filter(Boolean) : []
      if (lines.length > mailboxLines) yield { type: 'user', message: { role: 'user', content: `Message from the owner: ${lines[mailboxLines++]}` } }
      else await sleep(POLL_MS)
    }
    if (!completed) yield { type: 'user', message: { role: 'user', content: 'Runner timeout reached. Write .lane/report.md with the current state and end your turn.' } }
  }

  const stream = query({ prompt: prompt(), options: {
    model: model.value,
    systemPrompt: contract,
    settingSources: [],
    maxTurns: 120,
    cwd: options.dir,
    plugins: [{ type: 'local', path: join(dirname(options.contract), '../hooks-modules/pilot-guard') }],
    mcpServers: { planka: { type: 'http', url: 'http://localhost:25478/mcp' } },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    env: { ...env, ...profileEnv, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
  } })
  for await (const message of stream) {
    const content = message.message?.content
    if (Array.isArray(content)) for (const item of content) {
      if (item.type === 'tool_use') {
        tools.push(item.name)
        if (item.id) startedTools.set(item.id, now())
        if (item.name === 'Bash' && /(?:node\s+)?[^\s]*wt-lane\.mjs\b/.test(String(item.input?.command ?? ''))) laneLaunchSeen = true
      }
      if (item.type === 'tool_result' && item.tool_use_id && startedTools.has(item.tool_use_id)) {
        longestToolCallMs = Math.max(longestToolCallMs, now() - startedTools.get(item.tool_use_id))
        startedTools.delete(item.tool_use_id)
      }
    }
    const messageText = textFrom(message)
    if (/(?:node\s+)?[^\s]*wt-lane\.mjs\b/.test(messageText)) laneLaunchSeen = true
    // A lane launch answers `pid=<n>` and `log=<path>` together; a gate record prints `log=` alone
    // (wt-run-gate), so `log=` without `pid=` is never a lane to wait on.
    const laneLog = laneLogFrom(messageText)
    if (laneLaunchSeen && laneLog) pendingLanes.set(resolve(options.dir, laneLog), {})
    if (message.type === 'result') {
      const usage = usageOf(message)
      turns.push({ ...usage, tool_names: [...new Set(tools)] })
      for (const key of Object.keys(totals)) totals[key] += usage[key]
    }
  }
  const freshTokens = totals.input + totals.cache_creation + totals.output
  const usage = { turns, totals, fresh_tokens: freshTokens, tool_names: [...new Set(tools)] }
  const summary = { fresh_tokens: freshTokens, turns: turns.length, minutes: (now() - started) / 60000, longest_tool_call_ms: longestToolCallMs, model: model.value, effective_model: model.effective, report_exists: exists(report) }
  writeFile(usagePath, `${JSON.stringify(usage, null, 2)}\n`)
  writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  return { usage, summary }
}
