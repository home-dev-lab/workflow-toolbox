#!/usr/bin/env node
// wt-lane.mjs -- detached, one-command external opencode lane launcher.

import { appendFileSync, mkdirSync, openSync, existsSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { resolveConsent } from './lib/lane-consent-check-core.mjs'
import { evaluateConsentGate } from './lib/lane-consent-gate-core.mjs'

const DEFAULT_TIMEOUT = 5400
const GRACE_MS = 250

function usage() {
  return 'Usage: node wt-lane.mjs --dir <project-root>/.claude/worktrees/<name> --model <provider/model> --brief <file> [--timeout 5400] [--log <path>] [--variant <name>]'
}

function parse(argv) {
  const out = { dir: null, model: null, brief: null, timeout: DEFAULT_TIMEOUT, log: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir') out.dir = argv[++i] ?? null
    else if (arg === '--model') out.model = argv[++i] ?? null
    else if (arg === '--brief') out.brief = argv[++i] ?? null
    else if (arg === '--timeout') out.timeout = Number(argv[++i])
    else if (arg === '--log') out.log = argv[++i] ?? null
    else if (arg === '--variant') out.variant = argv[++i] ?? null
    else if (arg === '--help' || arg === '-h') return { help: true }
    else return { error: `unknown argument: ${arg}` }
  }
  if (!out.dir || !out.model || !out.brief) return { error: 'missing required --dir, --model, or --brief' }
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) return { error: '--timeout must be a positive number of seconds' }
  // opencode's built-in effort axis; an unknown name falls back SILENTLY to the default on the opencode side, so it is validated here.
  if (out.variant !== undefined && out.variant !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out.variant)) return { error: '--variant must be a plain variant name' }
  out.dir = path.resolve(out.dir)
  out.brief = path.resolve(out.brief)
  out.log = path.resolve(out.log ?? path.join(out.dir, '.lane', 'run.log'))
  return out
}

function main() {
  const worker = process.argv[2] === '--worker'
  const opts = parse(process.argv.slice(worker ? 3 : 2))
  if (opts.help) { process.stdout.write(`${usage()}\n`); return 0 }
  if (opts.error) { process.stderr.write(`wt-lane: ${opts.error}\n${usage()}\n`); return 2 }
  if (!existsSync(opts.dir) || !statSync(opts.dir).isDirectory()) { process.stderr.write(`wt-lane: --dir is not a directory: ${opts.dir}\n`); return 2 }
  if (!existsSync(opts.brief)) { process.stderr.write(`wt-lane: --brief does not exist: ${opts.brief}\n`); return 2 }

  // Invoke the same consent resolver and wording as the PreToolUse gate before a node wrapper
  // can bypass its text matcher.
  const consent = evaluateConsentGate({ tool_input: { command: 'opencode run' }, cwd: opts.dir }, { resolveConsentImpl: resolveConsent })
  if (!consent.silent) { process.stderr.write(`${consent.message}\n`); return 1 }

  if (!worker) {
    const child = spawn(process.execPath, [process.argv[1], '--worker', '--dir', opts.dir, '--model', opts.model, '--brief', opts.brief, '--timeout', String(opts.timeout), '--log', opts.log, ...(opts.variant ? ['--variant', opts.variant] : [])], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    process.stdout.write(`pid=${child.pid}\nlog=${opts.log}\n`)
    return 0
  }

  mkdirSync(path.dirname(opts.log), { recursive: true })
  const fd = openSync(opts.log, 'a')
  const args = ['run', `Read and execute the complete brief at ${opts.brief}.`, '--auto', '--dir', opts.dir, '--model', opts.model, ...(opts.variant ? ['--variant', opts.variant] : [])]
  const child = spawn('opencode', args, { cwd: opts.dir, detached: true, stdio: ['ignore', fd, fd] })
  let finished = false
  const finish = (code) => {
    if (finished) return
    finished = true
    try { appendFileSync(opts.log, `EXIT=${code}\n`) } catch { /* best effort after a log write failure */ }
  }
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already exited */ }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }; finish(124) }, GRACE_MS).unref()
  }, opts.timeout * 1000)
  timer.unref()
  child.on('error', () => { clearTimeout(timer); finish(1) })
  child.on('close', (code, signal) => { clearTimeout(timer); finish(signal ? 124 : (code ?? 1)) })
  return 0
}

process.exitCode = main()
