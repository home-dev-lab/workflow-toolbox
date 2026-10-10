#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSecondOpinionDependencies, runSecondOpinion } from './lib/second-opinion-core.mjs'
import { hostAdapter } from './lib/host/adapter.mjs'

const usage = 'Usage: node wt-second-opinion.mjs --request <file> --out <file> [--effort low|medium|high] [--route auto|astra|opus] [--repo <dir>]\nLinux sandbox refuses a named file the reviewer cannot read (exit 2); a named directory it cannot read is reported and the review runs.\nWT_SECOND_OPINION_ADMISSION optionally names an absolute ES module path: default admit({ repo, request, env }) returns null to admit or a non-empty refusal string (exit 3); configuration or module failures refuse too. This trusted in-process check is awaited before launch, without a timeout.'

function parseArgs(argv) {
  const options = { effort: 'medium', route: 'auto', repo: process.cwd() }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (['--request', '--out', '--effort', '--route', '--repo'].includes(arg)) {
      if (!argv[i + 1]) return { error: `${arg} requires a value`, out: options.out }
      options[arg.slice(2)] = argv[++i]
    } else return { error: `unknown argument: ${arg}`, out: options.out }
  }
  if (!options.request) return { error: '--request is required', out: options.out }
  if (!options.out) return { error: '--out is required' }
  if (!['low', 'medium', 'high'].includes(options.effort)) return { error: '--effort must be low, medium, or high', out: options.out }
  if (!['auto', 'astra', 'opus'].includes(options.route)) return { error: '--route must be auto, astra, or opus', out: options.out }
  options.request = path.resolve(options.request)
  options.out = path.resolve(options.out)
  options.repo = path.resolve(options.repo)
  if (!existsSync(options.request) || !statSync(options.request).isFile()) return { error: `--request is not a file: ${options.request}`, out: options.out }
  if (!existsSync(options.repo) || !statSync(options.repo).isDirectory()) return { error: `--repo is not a directory: ${options.repo}`, out: options.out }
  return options
}

let outputPath
const abortController = new AbortController()
const requestTermination = (signal) => {
  abortController.abort(signal)
}
const signalListeners = new Map(['SIGHUP', 'SIGTERM', 'SIGINT'].map((signal) => [signal, () => requestTermination(signal)]))
for (const [signal, listener] of signalListeners) process.once(signal, listener)

function removeSignalListeners() {
  for (const [signal, listener] of signalListeners) process.removeListener(signal, listener)
}

async function admissionRefusal({ repo, request }, env) {
  const variable = 'WT_SECOND_OPINION_ADMISSION'
  const modulePath = env[variable]
  if (!path.isAbsolute(modulePath)) return `${variable}: must name an absolute ES module path`
  try {
    const { default: admit } = await import(pathToFileURL(modulePath).href)
    if (typeof admit !== 'function') return `${variable}: default export must be a function`
    const result = await admit({ repo, request, env })
    if (result === null) return null
    if (typeof result === 'string' && result.trim()) return `${variable}: ${result}`
    return `${variable}: admit must return null or a non-empty string`
  } catch (error) {
    return `${variable}: admission module failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

function refuseAdmission(out, refusal) {
  const message = refusal.replace(/\r?\n/g, ' ')
  process.stderr.write(`wt-second-opinion: ${message}\n`)
  writeFileSync(out, `REFUSED: ${message}\nEXIT=3\n`)
  return 3
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${usage}\n`)
    return 0
  }
  if (options.error) {
    if (options.out) writeFileSync(options.out, `REFUSED: ${options.error}\nEXIT=2\n`)
    process.stderr.write(`wt-second-opinion: ${options.error}\n${usage}\n`)
    return 2
  }
  outputPath = options.out
  const env = process.env
  if (env.WT_SECOND_OPINION_ADMISSION !== undefined) {
    const refusal = await admissionRefusal(options, env)
    if (refusal !== null) return refuseAdmission(options.out, refusal)
  }
  return runSecondOpinion({ ...options, signal: abortController.signal, abortController }, createSecondOpinionDependencies(hostAdapter), env)
}

function finish(code) {
  removeSignalListeners()
  process.exitCode = code
}

main().then(finish).catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  if (outputPath) {
    try {
      const existing = readFileSync(outputPath, 'utf8')
      if (!/^EXIT=\d+$/m.test(existing.split(/\r?\n/).filter(Boolean).at(-1) ?? '')) {
        appendFileSync(outputPath, `REFUSED: second-opinion failed: ${message.replace(/\r?\n/g, ' ')}\nEXIT=1\n`)
      }
    } catch {
      try { writeFileSync(outputPath, `REFUSED: second-opinion failed: ${message.replace(/\r?\n/g, ' ')}\nEXIT=1\n`) } catch {}
    }
  }
  process.stderr.write(`wt-second-opinion: ${message}\n`)
  finish(1)
})
