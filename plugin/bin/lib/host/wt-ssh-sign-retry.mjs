#!/usr/bin/env node
// Standalone adopted program: no plugin installation or neighbouring modules needed.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const AGENT_FAILURES = ['No private key found', 'communication with agent failed', 'agent refused', 'agent not present']
const ATTEMPTS = 3
const RETRY_MS = 1000

function executableOtherThanSelf(candidate, self) {
  try {
    const stat = fs.statSync(candidate, { bigint: true })
    if (!stat.isFile() || (stat.dev === self.dev && stat.ino === self.ino)) return false
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch { return false }
}

function resolveKeygen() {
  const self = fs.statSync(fileURLToPath(import.meta.url), { bigint: true })
  const name = process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen'
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.resolve(directory.replace(/^"|"$/g, ''), name)
    if (executableOtherThanSelf(candidate, self)) return candidate
  }
  throw new Error(`${name} not found on PATH (the retry wrapper itself is excluded)`)
}

function mirrorExit(code, signal) {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 127
}

function passThrough(executable, args) {
  if (process.platform !== 'win32' && typeof process.execve === 'function') {
    process.execve(executable, [executable, ...args], process.env)
    return
  }
  const child = spawn(executable, args, { stdio: 'inherit' })
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => {
    const handler = () => child.kill(signal)
    process.on(signal, handler)
    return [signal, handler]
  })
  child.once('error', (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 127 })
  child.once('close', (code, signal) => {
    for (const [name, handler] of handlers) process.removeListener(name, handler)
    mirrorExit(code, signal)
  })
}

function signAttempt(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    child.stdout.on('data', (bytes) => stdout.push(bytes))
    child.stderr.on('data', (bytes) => stderr.push(bytes))
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error) })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }))
    child.stdin.end(input)
  })
}

async function sign(executable, args) {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const input = Buffer.concat(chunks)
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const result = await signAttempt(executable, args, input)
    process.stderr.write(result.stderr)
    const reason = AGENT_FAILURES.find((text) => result.stderr.includes(text))
    if (result.code === 0 || result.signal || !reason || attempt === ATTEMPTS) {
      // Failed stdout is withheld even at exhaustion: it cannot become a signature.
      if (result.code === 0) process.stdout.write(result.stdout)
      mirrorExit(result.code, result.signal)
      return
    }
    if (result.stderr.length && result.stderr.at(-1) !== 10) process.stderr.write('\n')
    process.stderr.write(`ssh-sign-retry: retrying because ${reason} (attempt ${attempt + 1}/${ATTEMPTS} in 1s)\n`)
    await delay(RETRY_MS)
  }
}

function invokedDirectly() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) }
  catch { return false }
}

async function main() {
  const executable = resolveKeygen()
  const args = process.argv.slice(2)
  const operation = args.indexOf('-Y')
  const signing = operation !== -1 && args[operation + 1] === 'sign' && args.lastIndexOf('-Y') === operation
  if (signing) await sign(executable, args)
  else passThrough(executable, args)
}

if (invokedDirectly()) {
  try { await main() }
  catch (error) { process.stderr.write(`ssh-sign-retry: ${error.message}\n`); process.exitCode = 127 }
}
