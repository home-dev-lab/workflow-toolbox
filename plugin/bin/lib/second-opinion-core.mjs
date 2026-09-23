import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveConsent, resolveConfigDir } from './lane-consent-check-core.mjs'
import { resolveAgentSdkRequire } from './sdk-resolution.mjs'
import { withRepositoryGuide } from './sdk-role-profile.mjs'

const TOOL_NOTE = 'Tool note: MCP tools (including context-mode) are NOT available in this read-only run; read files with your native shell (cat, sed -n, rg, ls). This overrides any routing rule that says to use context-mode.'
const CODEX_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024
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

function runCodex({ companion, cwd, effort, request, env, signal, adapter, maxOutputBytes = CODEX_OUTPUT_LIMIT_BYTES }) {
  const child = spawn(process.execPath, [companion, 'task', '--fresh', '--model', 'gpt-6-astra', '--effort', effort, request], {
    cwd,
    env,
    detached: adapter.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const chunks = { stdout: [], stderr: [] }
  let outputBytes = 0
  let overflow = false
  const stopOwnedFamily = () => {
    if (child.pid) adapter.endProcessFamily(child.pid)
  }
  const collect = (stream, chunk) => {
    if (overflow) return
    outputBytes += chunk.length
    if (outputBytes > maxOutputBytes) {
      overflow = true
      chunks.stdout.length = 0
      chunks.stderr.length = 0
      stopOwnedFamily()
      return
    }
    chunks[stream].push(chunk)
  }
  child.stdout.on('data', (chunk) => collect('stdout', chunk))
  child.stderr.on('data', (chunk) => collect('stderr', chunk))
  signal?.addEventListener('abort', stopOwnedFamily, { once: true })
  return new Promise((resolve) => {
    child.once('error', (error) => {
      stopOwnedFamily()
      resolve(overflow
        ? { status: 1, stdout: '', stderr: `REFUSED: Codex companion output exceeded ${maxOutputBytes} bytes.\n` }
        : { status: 1, stdout: Buffer.concat(chunks.stdout).toString(), stderr: `${Buffer.concat(chunks.stderr).toString()}${error.message}\n` })
    })
    child.once('close', (code, childSignal) => {
      stopOwnedFamily()
      signal?.removeEventListener('abort', stopOwnedFamily)
      resolve(overflow
        ? { status: 1, stdout: '', stderr: `REFUSED: Codex companion output exceeded ${maxOutputBytes} bytes.\n` }
        : { status: code ?? (childSignal ? 1 : 0), stdout: Buffer.concat(chunks.stdout).toString(), stderr: Buffer.concat(chunks.stderr).toString() })
    })
  })
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

export function listProcessTable(adapter) {
  try {
    return adapter.readProcessSnapshot()
  } catch {}
  return { supported: false, processes: [], reason: 'process discovery unavailable on this platform' }
}

export function listProcessRelationships(adapter) {
  try { return adapter.readProcessRelationships() } catch {
    return { status: 'unavailable', processes: [], reason: 'process relationship discovery unavailable on this platform' }
  }
}

export function listBrokers(adapter) {
  const table = listProcessTable(adapter)
  if (!table.supported) return { supported: false, pids: [], reason: 'broker cleanup unavailable on this platform' }
  return { supported: true, pids: table.processes.filter((process) => /openai-codex[\\/]codex.*scripts[\\/]app-server-broker/i.test(process.command)).map((process) => process.pid) }
}

function resolveSdkQuery(repo, env) {
  const require = resolveAgentSdkRequire({ projectDir: repo, env })
  return require('@anthropic-ai/claude-agent-sdk').query
}

function sdkRemedy(error) {
  const message = error instanceof Error ? error.message : String(error)
  const remedy = /run:\s*(.+)$/i.exec(message)?.[1]
  return remedy ? `run: ${remedy}` : `install @anthropic-ai/claude-agent-sdk (${message})`
}

export const createSecondOpinionDependencies = (adapter, options = {}) => ({
  resolveCodexCompanion: codexCompanion,
  runCodex: (runOptions) => runCodex({ ...runOptions, adapter, maxOutputBytes: options.maxOutputBytes }),
  resolveSdkQuery,
  listBrokers: () => listBrokers(adapter),
  stopBroker: (pid) => process.kill(pid, 'SIGTERM'),
})

export async function runSecondOpinion(options, dependencies, env = process.env) {
  const request = readFileSync(options.request, 'utf8')
  const consent = resolveConsent(options.repo, env)
  const route = options.route ?? 'auto'

  // The CLI validates the value; a direct caller gets the same refusal rather than a silent Opus run.
  if (!['auto', 'astra', 'opus'].includes(route)) {
    writeFileSync(options.out, `REFUSED: unknown route ${JSON.stringify(route)}; use auto, astra, or opus.\n`)
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
      result = await dependencies.runCodex({
        companion,
        cwd: options.repo,
        effort: options.effort,
        request: `${TOOL_NOTE}\n\n${request}`,
        env,
        signal: options.signal,
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

  writeFileSync(options.out, 'ROUTE=claude-opus\n')

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
      prompt: withRepositoryGuide(options.repo, request),
      options: {
        model: 'opus',
        effort: options.effort,
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
    answer = 'Claude Opus returned no answer.'
  }
  appendOutput(options.out, answer)
  const code = failed ? 1 : 0
  appendLine(options.out, `EXIT=${code}`)
  return code
}
