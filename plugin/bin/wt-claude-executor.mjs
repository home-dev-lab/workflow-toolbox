#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { executorBrief, executorCanUseTool, parseExecutorArgs } from './lib/claude-executor-core.mjs'
import { resolveRoleVariant } from './lib/lane-model-allowlist.mjs'
import { assertHarnessAlias } from './lib/pilot-model-config.mjs'
import { resolveAgentSdk, resolvedAgentSdkCodePaths } from './lib/sdk-resolution.mjs'
import { assertSdkRoleReceipt, composeSdkRoleQueryOptions, prepareSdkRole, withRepositoryGuide } from './lib/sdk-role-profile.mjs'

const usage = () => 'Usage: node wt-claude-executor.mjs --dir <worktree> --model <alias> --brief <file> --role <tdd|critic|review|refutation> [--variant <name>] [--knowledge-base-index <path>] [--log <path>] [--timeout 5400]'

function finish(log, code) {
  try {
    const tail = readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).at(-1) ?? ''
    if (/^EXIT=\d+$/.test(tail)) return
  } catch {}
  appendFileSync(log, `EXIT=${code}\n`)
}

async function worker(options) {
  mkdirSync(path.dirname(options.log), { recursive: true })
  const launch = executorBrief(options)
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const resolution = resolveAgentSdk({ sdkEntry: options.sdkPath, ownToolkitManifest: null, projectDir: null, npmRoot: null, writableRoots: [options.dir] })
  const sdkRole = prepareSdkRole(options.role, { worktree: options.dir, env: process.env, pluginRoot, loadedCodePaths: resolvedAgentSdkCodePaths(resolution), adapterOptions: { log: (line) => appendFileSync(options.log, `${line}\n`) } })
  const { query } = resolution.require(resolution.entryPath)
  const abortController = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true; abortController.abort()
    setTimeout(() => { finish(options.log, 124); process.exit(124) }, 250).unref()
  }, options.timeout * 1000)
  const stop = (code) => { clearTimeout(timer); abortController.abort(); finish(options.log, code); process.exitCode = code }
  // Windows has no POSIX SIGTERM/SIGINT exit-status contract; forced termination cannot promise 143/130 markers.
  process.once('SIGTERM', () => stop(143)); process.once('SIGINT', () => stop(130))
  let failed = false
  let initReceiptSeen = false
  let readOnlyReport = ''
  let servedModel = options.model
  const effort = options.variant
    ? { value: options.variant, origin: options.variantOrigin ?? 'override' }
    : resolveRoleVariant(options.role === 'tdd' ? 'code' : options.role, options.model)
  const totals = { input: 0, cache_creation: 0, cache_read: 0, output: 0 }
  appendFileSync(options.log, `variant=${effort.value} origin=${effort.origin} forced=false\n`)
  try {
    const queryOptions = composeSdkRoleQueryOptions({
      model: options.model,
      effort: effort.value,
      cwd: options.dir,
      settingSources: [],
      canUseTool: async (toolName, input) => executorCanUseTool(options.dir, launch.report, launch.readOnly, toolName, input, { knowledgeBaseIndex: options.knowledgeBaseIndex, profile: sdkRole.profile }),
      permissionMode: 'default',
      sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false, failIfUnavailable: true },
      settings: { permissions: { blockReadsOutsideWorkingDirectories: true, disableBypassPermissionsMode: 'disable' } },
      abortController,
      env: { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
    }, sdkRole)
    const stream = query({ prompt: withRepositoryGuide(options.dir, launch.prompt), options: queryOptions })
    for await (const message of stream) {
      if (!initReceiptSeen && !(message.type === 'system' && (message.subtype === 'init' || message.subtype?.startsWith('hook_')))) throw new Error(`SDK executor initialization receipt never arrived: the first message was ${message.type}/${message.subtype ?? 'none'}`)
      if (message.type === 'system' && message.subtype === 'init') {
        initReceiptSeen = true
        if (message.model) servedModel = message.model
        assertSdkRoleReceipt(options.role, message, sdkRole)
      }
      if (message.type === 'result') {
        if (message.is_error) failed = true
        if (launch.readOnly && typeof message.result === 'string' && message.result.trim()) readOnlyReport = message.result
        const value = message.usage ?? {}
        totals.input += value.input_tokens ?? 0
        totals.cache_creation += value.cache_creation_input_tokens ?? 0
        totals.cache_read += value.cache_read_input_tokens ?? 0
        totals.output += value.output_tokens ?? 0
      }
    }
    if (!initReceiptSeen) throw new Error('SDK executor run ended without an initialization receipt')
    if (launch.readOnly && !existsSync(launch.report) && readOnlyReport) writeFileSync(launch.report, `${readOnlyReport.trim()}\n`)
    if (existsSync(launch.report)) appendFileSync(launch.report, `\nvariant=${effort.value} origin=${effort.origin} forced=false\n`)
  } catch (error) {
    if (!timedOut) { failed = true; appendFileSync(options.log, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`) }
  } finally {
    clearTimeout(timer)
  }
  const code = timedOut ? 124 : failed || !existsSync(launch.report) || statSync(launch.report).size === 0 ? 1 : 0
  writeFileSync(`${options.log}.usage.json`, `${JSON.stringify({ model: servedModel, totals }, null, 2)}\n`)
  finish(options.log, code)
  return code
}

async function main() {
  const isWorker = process.argv[2] === '--worker'
  const options = parseExecutorArgs(process.argv.slice(isWorker ? 3 : 2))
  if (options.help) { process.stdout.write(`${usage()}\n`); return 0 }
  if (options.error) { process.stderr.write(`wt-claude-executor: ${options.error}\n${usage()}\n`); return 2 }
  if (!existsSync(options.dir) || !statSync(options.dir).isDirectory()) { process.stderr.write(`wt-claude-executor: --dir is not a directory: ${options.dir}\n`); return 2 }
  if (!existsSync(options.brief)) { process.stderr.write(`wt-claude-executor: --brief does not exist: ${options.brief}\n`); return 2 }
  if (isWorker && !options.sdkPath) { process.stderr.write('wt-claude-executor: worker requires parent-resolved --sdk-path\n'); return 2 }
  try { assertHarnessAlias(options.model); executorBrief(options) } catch (error) { process.stderr.write(`wt-claude-executor: ${error instanceof Error ? error.message : String(error)}\n`); return 2 }
  if (isWorker) return worker(options)
  mkdirSync(path.join(options.dir, '.lane'), { recursive: true })
  const resolution = resolveAgentSdk({ projectDir: options.dir, writableRoots: [options.dir] })
  const child = spawn(process.execPath, [process.argv[1], '--worker', '--sdk-path', resolution.entryPath, '--dir', options.dir, '--model', options.model, ...(options.variant ? ['--variant', options.variant] : []), ...(options.variantOrigin ? ['--variant-origin', options.variantOrigin] : []), '--brief', options.brief, '--log', options.log, '--timeout', String(options.timeout), '--role', options.role, ...(options.knowledgeBaseIndex ? ['--knowledge-base-index', options.knowledgeBaseIndex] : [])], { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
  process.stdout.write(`pid=${child.pid}\nlog=${options.log}\n`)
  return 0
}

main().then((code) => { process.exitCode = code })
