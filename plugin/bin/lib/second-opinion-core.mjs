import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConsent, resolveConfigDir } from './lane-consent-check-core.mjs'
import { resolveWorkflowToolboxOption } from './plugin-options.mjs'
import { resolveAgentSdkRequire } from './sdk-resolution.mjs'

const TOOL_NOTE = 'Tool note: MCP tools (including context-mode) are NOT available in this read-only run; read files with your native shell (cat, sed -n, rg, ls). This overrides any routing rule that says to use context-mode.'
const QUOTA_PROBE = fileURLToPath(new URL('../wt-quota-probe.mjs', import.meta.url))

function appendLine(out, line) {
  appendFileSync(out, `${String(line).replace(/\r?\n/g, ' ').trim()}\n`)
}

function appendOutput(out, text) {
  if (!text) return
  appendFileSync(out, text.endsWith('\n') ? text : `${text}\n`)
}

function codexCompanion(env) {
  const cache = path.join(resolveConfigDir(env), 'plugins', 'cache', 'openai-codex', 'codex')
  let versions
  try {
    versions = readdirSync(cache, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  } catch {
    return null
  }
  for (const version of versions) {
    const candidate = path.join(cache, version, 'scripts', 'codex-companion.mjs')
    if (existsSync(candidate)) return candidate
  }
  return null
}

function runCodex({ companion, cwd, effort, request, env }) {
  const result = spawnSync(process.execPath, [companion, 'task', '--fresh', '--model', 'gpt-6-astra', '--effort', effort, request], {
    cwd,
    env,
    encoding: 'utf8',
    input: '',
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function parseProcessLines(stdout) {
  const pids = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!/openai-codex[\\/]codex.*scripts[\\/]app-server-broker/i.test(line)) continue
    const match = /^\s*(\d+)\s+/.exec(line)
    if (match) pids.push(Number(match[1]))
  }
  return pids
}

export function listProcessTable(platform = process.platform) {
  try {
    if (['aix', 'darwin', 'freebsd', 'linux', 'sunos'].includes(platform)) {
      const stdout = execFileSync('ps', ['-eo', 'pid=,ppid=,etimes=,args='], { encoding: 'utf8' })
      const processes = stdout.split(/\r?\n/).flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), elapsedMs: Number(match[3]) * 1000, command: match[4] }] : []
      })
      return { supported: true, processes }
    }
    if (platform === 'win32') {
      const command = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId,$_.ParentProcessId,$_.CommandLine }"
      const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })
      const processes = stdout.split(/\r?\n/).flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), elapsedMs: null, command: match[3] }] : []
      })
      return { supported: true, processes }
    }
  } catch {}
  return { supported: false, processes: [], reason: 'process discovery unavailable on this platform' }
}

export function listBrokers(platform = process.platform) {
  const table = listProcessTable(platform)
  if (!table.supported) return { supported: false, pids: [], reason: 'broker cleanup unavailable on this platform' }
  return { supported: true, pids: table.processes.filter((process) => /openai-codex[\\/]codex.*scripts[\\/]app-server-broker/i.test(process.command)).map((process) => process.pid) }
}

function probeQuota(env) {
  const result = spawnSync(process.execPath, [QUOTA_PROBE], { env, encoding: 'utf8', input: '' })
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `probe exited ${result.status}`).trim())
  return JSON.parse(result.stdout)
}

function resolveSdkQuery(repo, env) {
  const require = resolveAgentSdkRequire({ projectDir: repo, env })
  return require('@anthropic-ai/claude-agent-sdk').query
}

function fableThreshold(env) {
  const configured = resolveWorkflowToolboxOption('second_opinion_fable_max_pct', { env }).value
  if (!Number.isFinite(configured) || configured < 0 || configured > 100) {
    throw new Error('WT_SECOND_OPINION_FABLE_MAX_PCT must be a number from 0 to 100')
  }
  return configured
}

function sdkRemedy(error) {
  const message = error instanceof Error ? error.message : String(error)
  const remedy = /run:\s*(.+)$/i.exec(message)?.[1]
  return remedy ? `run: ${remedy}` : `install @anthropic-ai/claude-agent-sdk (${message})`
}

export const defaultSecondOpinionDependencies = {
  resolveCodexCompanion: codexCompanion,
  runCodex,
  probeQuota,
  resolveSdkQuery,
  listBrokers,
  stopBroker: (pid) => process.kill(pid, 'SIGTERM'),
}

export async function runSecondOpinion(options, dependencies = defaultSecondOpinionDependencies, env = process.env) {
  const request = readFileSync(options.request, 'utf8')
  const consent = resolveConsent(options.repo, env)
  const route = options.route ?? 'auto'

  // The CLI validates the value; a direct caller gets the same refusal rather than a silent Fable run.
  if (!['auto', 'astra', 'fable'].includes(route)) {
    writeFileSync(options.out, `REFUSED: unknown route ${JSON.stringify(route)}; use auto, astra, or fable.\n`)
    appendLine(options.out, 'EXIT=2')
    return 2
  }

  if (route === 'astra' && consent.outcome !== 'true') {
    writeFileSync(options.out, consent.outcome === 'unknown'
      ? 'REFUSED: Astra requires active GPT lane consent, and the consent setting could not be read; check executor_lane_consent in the plugin settings of this profile and project.\n'
      : 'REFUSED: Astra requires active GPT lane consent.\n')
    appendLine(options.out, 'EXIT=1')
    return 1
  }

  if (route === 'astra' || (route === 'auto' && consent.outcome === 'true')) {
    const companion = dependencies.resolveCodexCompanion(env)
    if (!companion) {
      writeFileSync(options.out, 'REFUSED: GPT lane consent is active, but the Codex companion runtime is not installed; install the openai-codex plugin.\n')
      appendLine(options.out, 'EXIT=1')
      return 1
    }

    writeFileSync(options.out, 'ROUTE=gpt-astra\n')
    const before = dependencies.listBrokers()
    let result
    try {
      result = dependencies.runCodex({
        companion,
        cwd: options.repo,
        effort: options.effort,
        request: `${TOOL_NOTE}\n\n${request}`,
        env,
      })
      appendOutput(options.out, result.stdout)
      appendOutput(options.out, result.stderr)
    } catch (error) {
      result = { status: 1 }
      appendLine(options.out, error instanceof Error ? error.message : String(error))
    }

    if (!before.supported) {
      appendLine(options.out, before.reason)
    } else {
      const after = dependencies.listBrokers()
      if (!after.supported) appendLine(options.out, after.reason)
      else for (const pid of after.pids.filter((pid) => !before.pids.includes(pid))) {
        try {
          dependencies.stopBroker(pid)
          appendLine(options.out, `stopped broker pid ${pid} started by this call`)
        } catch (error) {
          appendLine(options.out, `could not stop broker pid ${pid}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    appendLine(options.out, `EXIT=${result.status}`)
    return result.status
  }

  writeFileSync(options.out, 'ROUTE=claude-fable\n')
  let threshold
  let quota
  try {
    threshold = fableThreshold(env)
    quota = dependencies.probeQuota(env)
  } catch (error) {
    appendLine(options.out, `REFUSED: could not read the active account Fable quota: ${error instanceof Error ? error.message : String(error)}.`)
    appendLine(options.out, 'EXIT=1')
    return 1
  }
  const fableScopes = Array.isArray(quota.weekly_scoped)
    ? quota.weekly_scoped.filter((item) => /fable/i.test(String(item?.scope)) && Number.isFinite(item?.percent))
    : []
  const percent = fableScopes.reduce((maximum, item) => Math.max(maximum, item.percent), -Infinity)
  if (percent >= threshold) {
    appendLine(options.out, `REFUSED: Claude Fable weekly scoped quota is ${percent}%, at or above the ${threshold}% limit.`)
    appendLine(options.out, 'EXIT=1')
    return 1
  }

  let query
  try {
    query = dependencies.resolveSdkQuery(options.repo, env)
  } catch (error) {
    appendLine(options.out, `REFUSED: Claude Agent SDK unavailable; ${sdkRemedy(error)}`)
    appendLine(options.out, 'EXIT=1')
    return 1
  }

  let answer = ''
  let failed = false
  try {
    const stream = query({
      prompt: request,
      options: {
        model: 'fable',
        cwd: options.repo,
        tools: ['Read', 'Glob', 'Grep'],
        settingSources: [],
        permissionMode: 'default',
        canUseTool: async (toolName) => ['Read', 'Glob', 'Grep'].includes(toolName)
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: 'second-opinion is read-only' },
        env,
      },
    })
    for await (const message of stream) {
      if (message.type === 'result') {
        if (message.is_error) failed = true
        if (typeof message.result === 'string') answer = message.result
      }
    }
  } catch (error) {
    failed = true
    answer = error instanceof Error ? error.message : String(error)
  }
  if (!answer.trim()) {
    failed = true
    answer = 'Claude Fable returned no answer.'
  }
  appendOutput(options.out, answer)
  const code = failed ? 1 : 0
  appendLine(options.out, `EXIT=${code}`)
  return code
}
