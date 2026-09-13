#!/usr/bin/env node
// One stable command for the verifier bridge. The agent supplies a task file or stdin; this
// process owns its cwd-local copy, the external invocation, retry, and cleanup.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { laneTextFromOutput } from './wt-verifier-cli-guard-hook.mjs'
import { opencodeChildEnv, opencodeSkillFenceRefusal, verifyOpencodeSkillFence } from './lib/opencode-skill-fence.mjs'

export const DEFAULT_MODEL = 'openai/gpt-5.6-luna'
export const DEFAULT_TIMEOUT_SEC = 570
const MESSAGE = 'Follow the instructions in the attached file and output ONLY what it asks for (e.g. the verdict JSON). Do not add commentary.'

function usage() {
  return [
    'wt-opencode-verify — run one verifier task through opencode.',
    '',
    'Usage:',
    '  wt-opencode-verify.mjs --dir <workdir> --id <unique-id> [-m <model>] [--fallback-model <model>] [--variant <name>] (--task-file <path> | --stdin)',
    '',
    'Copies the task into the workdir, runs the read-only plan agent with closed stdin, and retries once on a rate limit.',
  ].join('\n')
}

export function parseArgs(argv, env = process.env) {
  const options = { dir: null, taskFile: null, stdin: false, id: null, model: env.OPENCODE_MODEL || DEFAULT_MODEL, fallbackModel: null, variant: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dir') options.dir = argv[++i] ?? null
    else if (arg === '--task-file') options.taskFile = argv[++i] ?? null
    else if (arg === '--stdin') options.stdin = true
    else if (arg === '--id') options.id = argv[++i] ?? null
    else if (arg === '-m' || arg === '--model') options.model = argv[++i] ?? options.model
    else if (arg === '--fallback-model') options.fallbackModel = argv[++i] ?? null
    else if (arg === '--variant') options.variant = argv[++i] ?? null
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!options.dir || !options.id || (options.stdin === (options.taskFile !== null))) {
    throw new Error('usage: wt-opencode-verify.mjs --dir <workdir> --id <unique-id> [-m <model>] [--fallback-model <model>] [--variant <name>] (--task-file <path> | --stdin)')
  }
  return options
}

export function buildRunArgs({ model, dir, taskFile, variant }) {
  const args = ['run', MESSAGE, '--agent', 'plan', '--model', model]
  if (variant) args.push('--variant', variant)
  // These must be explicit: the verifier must neither inherit a directory nor block on a prompt.
  args.push('--dir', dir, '--format', 'json', '-f', taskFile)
  return args
}

function resolveBinary() {
  const which = spawnSync('command -v opencode', { shell: true, encoding: 'utf8' })
  if (which.status === 0 && which.stdout?.trim()) return which.stdout.trim().split('\n')[0]
  for (const candidate of [path.join(os.homedir(), '.opencode/bin/opencode'), path.join(os.homedir(), '.local/bin/opencode'), '/usr/local/bin/opencode', '/opt/homebrew/bin/opencode']) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate } catch { /* try next */ }
  }
  return null
}

function runOnce(spawnFn, bin, args, timeoutSec = DEFAULT_TIMEOUT_SEC, env = process.env) {
  return new Promise((resolve) => {
    const child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: opencodeChildEnv(env) })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutSec * 1000)
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.once('error', (error) => { clearTimeout(timer); resolve({ stdout, stderr: `${stderr}${error}`, code: 1, timedOut: false }) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: timedOut || signal === 'SIGKILL' ? 124 : (code ?? 1), timedOut })
    })
  })
}

function rateLimited(result) {
  return /429|rate[ _-]?limit|rate_limit_exceeded|too many requests|resource_exhausted/i.test(`${result.stdout}\n${result.stderr}`)
}

function externalDirectoryDenial(result) {
  return `${result.stdout}\n${result.stderr}`.match(/[^\n]*external_directory[^\n]*/i)?.[0].trim() ?? null
}

export async function runVerifier(options, { spawnFn = spawn, binary = resolveBinary(), providerAuthenticated = (bin) => spawnSync(bin, ['providers', 'list'], { encoding: 'utf8', timeout: 30000, env: opencodeChildEnv() }).status === 0, skillFenceVerifier = verifyOpencodeSkillFence, readStdin = () => fs.readFileSync(0, 'utf8'), timeoutSec = DEFAULT_TIMEOUT_SEC, env = process.env } = {}) {
  if (!binary) return { code: 1, output: 'OPENCODE_UNAVAILABLE: opencode binary not found on PATH or known install locations' }
  const fence = skillFenceVerifier(binary, { env })
  if (!fence.ok) return { code: 1, output: opencodeSkillFenceRefusal(fence.reason) }
  if (!providerAuthenticated(binary)) {
    return { code: 1, output: 'OPENCODE_UNAVAILABLE: no opencode provider authenticated (providers list failed)' }
  }
  const task = options.stdin ? readStdin() : fs.readFileSync(options.taskFile, 'utf8')
  const taskFile = path.join(path.resolve(options.dir), `.oc-verify-${options.id}-${process.pid}.md`)
  fs.writeFileSync(taskFile, task, 'utf8')
  try {
    let result = await runOnce(spawnFn, binary, buildRunArgs({ ...options, taskFile }), timeoutSec, env)
    if (result.code !== 0 && rateLimited(result)) {
      result = await runOnce(spawnFn, binary, buildRunArgs({ ...options, model: options.fallbackModel || DEFAULT_MODEL, taskFile }), timeoutSec, env)
    }
    const denial = externalDirectoryDenial(result)
    if (result.code === 0 && denial) return { code: 1, output: `OPENCODE_EXTERNAL_DIRECTORY: ${denial}` }
    if (result.code === 0) return { code: 0, output: laneTextFromOutput(result.stdout) ?? result.stdout }
    return { code: result.code, output: result.stderr || result.stdout || `opencode exited ${result.code}` }
  } finally {
    fs.rmSync(taskFile, { force: true })
  }
}

async function main() {
  try {
    if (process.argv.length === 3 && (process.argv[2] === '--help' || process.argv[2] === '-h')) {
      process.stdout.write(`${usage()}\n`)
      return
    }
    const result = await runVerifier(parseArgs(process.argv.slice(2)))
    process.stdout.write(result.output)
    process.exitCode = result.code
  } catch (error) {
    process.stderr.write(`OPENCODE_ERROR: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main()
