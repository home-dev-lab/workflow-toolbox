#!/usr/bin/env node
import { closeSync, openSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOLD_MS = 60 * 60 * 1000

function worker() {
  const descriptors = Array.from({ length: 8 }, () => openSync(process.platform === 'win32' ? 'NUL' : '/dev/null', 'r'))
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${HOLD_MS})`], { stdio: 'ignore' })
  process.send?.({ ready: true, childPid: child.pid, descriptors: descriptors.length })
  const stop = () => {
    try { child.kill('SIGKILL') } catch {}
    for (const descriptor of descriptors) try { closeSync(descriptor) } catch {}
    process.exit(0)
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  process.once('message', (message) => { if (message === 'stop') stop() })
  setTimeout(stop, HOLD_MS).unref()
}

function parse(argv) {
  const separator = argv.indexOf('--')
  const workerIndex = argv.indexOf('--workers')
  const workers = workerIndex === -1 ? 6 : Number(argv[workerIndex + 1])
  if (!Number.isSafeInteger(workers) || workers < 6) throw new Error('--workers must be an integer of at least 6')
  if (separator === -1 || !argv[separator + 1]) throw new Error('usage: process-enumeration-load.mjs [--workers N] -- <command> [args...]')
  return { workers, command: argv[separator + 1], args: argv.slice(separator + 2) }
}

async function main() {
  if (process.argv.includes('--worker')) return worker()
  const options = parse(process.argv.slice(2))
  const load = Array.from({ length: options.workers }, () => spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  }))
  const stop = () => {
    for (const child of load) {
      try { child.send('stop') } catch {}
      setTimeout(() => {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL') } catch {}
      }, 1_000).unref()
    }
  }
  process.once('exit', stop)
  process.once('SIGTERM', () => { stop(); process.exit(143) })
  process.once('SIGINT', () => { stop(); process.exit(130) })
  try {
    const receipts = await Promise.all(load.map((child) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`load worker ${child.pid ?? 'unknown'} did not become ready`)), 5_000)
      child.once('message', (message) => { clearTimeout(timer); resolve(message) })
      child.once('error', reject)
    })))
    process.stderr.write(`process-enumeration-load: ready workers=${load.length} children=${receipts.length} held_fds=${receipts.reduce((sum, item) => sum + Number(item.descriptors), 0)}\n`)
    const command = spawn(options.command, options.args, { stdio: 'inherit', env: { ...process.env, WT_PROCESS_LOAD_COUNT: String(load.length) } })
    process.exitCode = await new Promise((resolve, reject) => {
      command.once('error', reject)
      command.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    })
  } finally {
    stop()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { process.stderr.write(`process-enumeration-load: ${error.message}\n`); process.exitCode = 1 })
}
