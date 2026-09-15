#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { executorBrief, executorCanUseTool, executorTools, parseExecutorArgs } from './lib/claude-executor-core.mjs'
import { assertHarnessAlias } from './lib/pilot-model-config.mjs'
import { resolveAgentSdkRequire } from './lib/sdk-resolution.mjs'

const usage = () => 'Usage: node wt-claude-executor.mjs --dir <worktree> --model <alias> --brief <file> --role <tdd|harden|critic|review|refutation> [--knowledge-base-index <path>] [--log <path>] [--timeout 5400]'

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
  const guardPlugin = path.join(pluginRoot, 'hooks-modules', 'pilot-guard')
  for (const file of [path.join(guardPlugin, 'hooks', 'hooks.json'), path.join(guardPlugin, 'hooks', 'hooks.js')]) {
    if (!existsSync(file)) throw new Error(`required pilot-guard file is absent: ${file}`)
  }
  const require = resolveAgentSdkRequire({ projectDir: options.dir })
  const { query } = require('@anthropic-ai/claude-agent-sdk')
  const abortController = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true; abortController.abort()
    setTimeout(() => { finish(options.log, 124); process.exit(124) }, 250).unref()
  }, options.timeout * 1000)
  const stop = (code) => { clearTimeout(timer); abortController.abort(); finish(options.log, code); process.exitCode = code }
  process.once('SIGTERM', () => stop(143)); process.once('SIGINT', () => stop(130))
  let failed = false
  let servedModel = options.model
  const totals = { input: 0, cache_creation: 0, cache_read: 0, output: 0 }
  try {
    const stream = query({ prompt: launch.prompt, options: {
      model: options.model,
      cwd: options.dir,
      settingSources: [],
      plugins: [{ type: 'local', path: guardPlugin }],
      tools: executorTools(launch.readOnly),
      canUseTool: async (toolName, input) => executorCanUseTool(options.dir, launch.report, launch.readOnly, toolName, input, { knowledgeBaseIndex: options.knowledgeBaseIndex }),
      permissionMode: 'default',
      sandbox: { enabled: true, autoAllowBashIfSandboxed: false },
      settings: { permissions: { blockReadsOutsideWorkingDirectories: true, disableBypassPermissionsMode: 'disable' } },
      abortController,
      env: process.env,
    } })
    for await (const message of stream) {
      if (message.type === 'system' && message.subtype === 'init' && message.model) servedModel = message.model
      if (message.type === 'result') {
        if (message.is_error) failed = true
        const value = message.usage ?? {}
        totals.input += value.input_tokens ?? 0
        totals.cache_creation += value.cache_creation_input_tokens ?? 0
        totals.cache_read += value.cache_read_input_tokens ?? 0
        totals.output += value.output_tokens ?? 0
      }
    }
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
  try { assertHarnessAlias(options.model); executorBrief(options) } catch (error) { process.stderr.write(`wt-claude-executor: ${error instanceof Error ? error.message : String(error)}\n`); return 2 }
  if (isWorker) return worker(options)
  mkdirSync(path.join(options.dir, '.lane'), { recursive: true })
  const child = spawn(process.execPath, [process.argv[1], '--worker', '--dir', options.dir, '--model', options.model, '--brief', options.brief, '--log', options.log, '--timeout', String(options.timeout), '--role', options.role, ...(options.knowledgeBaseIndex ? ['--knowledge-base-index', options.knowledgeBaseIndex] : [])], { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
  process.stdout.write(`pid=${child.pid}\nlog=${options.log}\n`)
  return 0
}

main().then((code) => { process.exitCode = code })
