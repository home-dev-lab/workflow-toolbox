import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveConsent, resolveConfigDir } from './lane-consent-check-core.mjs'
import { resolveAgentSdkRequire } from './sdk-resolution.mjs'
import { withRepositoryGuide } from './sdk-role-profile.mjs'
import { announceUnsandboxedLane, resolveLaneSandbox } from './host/lane-sandbox.mjs'

const TOOL_NOTE = 'Tool note: MCP tools (including context-mode) are NOT available in this read-only run; read files with your native shell (cat, sed -n, rg, ls). This overrides any routing rule that says to use context-mode.'
const CODEX_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024
// The Claude fallback always runs Opus at xhigh; the caller's --effort drives only the Astra route.
const OPUS_EFFORT = 'xhigh'
function signalExitCode(reason) {
  if (reason === 'SIGHUP') return 129
  if (reason === 'SIGINT') return 130
  if (reason === 'SIGTERM') return 143
  return null
}
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

// The companion's plugin version root (`<version>/scripts/codex-companion.mjs`), read-only in the sandbox.
function companionRoot(companion) {
  const scripts = path.dirname(companion)
  return path.basename(scripts) === 'scripts' ? path.dirname(scripts) : scripts
}

function runCodex({ companion, cwd, effort, request, env, signal, adapter, maxOutputBytes = CODEX_OUTPUT_LIMIT_BYTES, resolveSandbox = resolveLaneSandbox }) {
  if (signal?.aborted) return Promise.resolve({ status: 1, stdout: '', stderr: 'Codex companion launch aborted before spawn.\n', cleanup: [], interrupted: signal.reason })
  const ownership = adapter.createCodexBrokerOwnership(env)
  const companionArgs = [companion, 'task', '--fresh', '--model', 'gpt-6-astra', '--effort', effort, request]
  const sandbox = resolveSandbox({ profile: 'codex', bin: process.execPath, args: companionArgs, cwd, env: ownership.env, paths: { readable: [companionRoot(companion)] }, platform: adapter.platform })
  announceUnsandboxedLane(sandbox)
  // Inside the sandbox's PID namespace the broker records a namespace pid; ownership must find it as
  // a host descendant of the sandbox instead of trusting that number.
  if (sandbox.kind === 'bwrap') ownership.brokerInChildPidNamespace?.()
  const [command, commandArgs] = sandbox.wrap(process.execPath, companionArgs)
  const child = spawn(command, commandArgs, {
    cwd,
    env: ownership.env,
    detached: adapter.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const chunks = { stdout: [], stderr: [] }
  let outputBytes = 0
  let overflow = false
  let cleanup = null
  let companionAlive = true
  let interrupted = null
  const captureBroker = () => {
    if (companionAlive && child.pid) ownership.capture(child.pid)
  }
  captureBroker()
  const captureTimer = setInterval(captureBroker, 25)
  captureTimer.unref()
  child.once('exit', () => {
    companionAlive = false
    clearInterval(captureTimer)
  })
  const stopEverything = (reason = null) => {
    if (cleanup) return cleanup
    if (reason) interrupted ??= reason
    clearInterval(captureTimer)
    captureBroker()
    if (companionAlive) child.kill('SIGTERM')
    cleanup = ownership.stop()
    return cleanup
  }
  const collect = (stream, chunk) => {
    if (overflow) return
    outputBytes += chunk.length
    if (outputBytes > maxOutputBytes) {
      overflow = true
      chunks.stdout.length = 0
      chunks.stderr.length = 0
      stopEverything()
      return
    }
    chunks[stream].push(chunk)
  }
  child.stdout.on('data', (chunk) => collect('stdout', chunk))
  child.stderr.on('data', (chunk) => collect('stderr', chunk))
  const onAbort = () => stopEverything(signal?.reason)
  const onExit = () => { stopEverything() }
  process.once('exit', onExit)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearInterval(captureTimer)
      process.removeListener('exit', onExit)
      signal?.removeEventListener('abort', onAbort)
      resolve({ ...result, interrupted, sandbox: sandbox.line })
    }
    child.once('error', (error) => {
      stopEverything()
      finish(overflow
        ? { status: 1, stdout: '', stderr: `REFUSED: Codex companion output exceeded ${maxOutputBytes} bytes.\n`, cleanup }
        : { status: 1, stdout: Buffer.concat(chunks.stdout).toString(), stderr: `${Buffer.concat(chunks.stderr).toString()}${error.message}\n`, cleanup })
    })
    child.once('close', (code, childSignal) => {
      companionAlive = false
      stopEverything()
      finish(overflow
        ? { status: 1, stdout: '', stderr: `REFUSED: Codex companion output exceeded ${maxOutputBytes} bytes.\n`, cleanup }
        : { status: code ?? (childSignal ? 1 : 0), stdout: Buffer.concat(chunks.stdout).toString(), stderr: Buffer.concat(chunks.stderr).toString(), cleanup })
    })
  })
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

export function listBrokers(adapter, table = listProcessTable(adapter)) {
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
  runCodex: (runOptions) => runCodex({ ...runOptions, adapter, maxOutputBytes: options.maxOutputBytes, ...(options.resolveSandbox ? { resolveSandbox: options.resolveSandbox } : {}) }),
  resolveSdkQuery,
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
      if (result.sandbox) appendLine(options.out, result.sandbox)
      appendOutput(options.out, result.stdout)
      appendOutput(options.out, result.stderr)
      for (const line of result.cleanup ?? []) appendLine(options.out, line)
    } catch (error) {
      result = { status: 1 }
      appendLine(options.out, error instanceof Error ? error.message : String(error))
    }

    const code = signalExitCode(result.interrupted) ?? result.status
    appendLine(options.out, `EXIT=${code}`)
    return code
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
        effort: OPUS_EFFORT,
        cwd: options.repo,
        tools: ['Read', 'Glob', 'Grep'],
        settingSources: [],
        permissionMode: 'default',
        abortController: options.abortController,
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
  const code = signalExitCode(options.signal?.aborted ? options.signal.reason : null) ?? (failed ? 1 : 0)
  appendLine(options.out, `EXIT=${code}`)
  return code
}
