#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createSecondOpinionDependencies, runSecondOpinion } from './lib/second-opinion-core.mjs'
import { hostAdapter } from './lib/host/adapter.mjs'

const usage = 'Usage: node wt-second-opinion.mjs --request <file> --out <file> [--effort low|medium|high] [--route auto|astra|opus] [--repo <dir>]'

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
  return runSecondOpinion({ ...options, signal: abortController.signal, abortController }, createSecondOpinionDependencies(hostAdapter))
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
