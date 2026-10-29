#!/usr/bin/env node
// Standalone adopted program: no plugin installation or neighbouring modules needed.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const AGENT_FAILURES = ['No private key found', 'communication with agent failed', 'agent refused', 'agent not present']
const ATTEMPTS = 2
const RETRY_MS = 1000

function wrapperCopy(candidate) {
  let fd
  try {
    fd = fs.openSync(candidate, 'r')
    const prefix = Buffer.alloc(1024)
    const size = fs.readSync(fd, prefix, 0, prefix.length, 0)
    // Stable across installed banners, distinct copies, and older adopted versions.
    return prefix.subarray(0, size).includes('// Standalone adopted program: no plugin installation or neighbouring modules needed.')
  } catch (error) {
    // Execute-only native programs are valid; a Node wrapper would need read access.
    if (error.code === 'EACCES') return false
    throw error
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}

function executableOtherThanSelf(candidate, self) {
  try {
    const stat = fs.statSync(candidate, { bigint: true })
    if (!stat.isFile() || (stat.dev === self.dev && stat.ino === self.ino)) return false
    fs.accessSync(candidate, fs.constants.X_OK)
    return !wrapperCopy(candidate)
  } catch { return false }
}

function keygenNames() {
  if (process.platform !== 'win32') return ['ssh-keygen']
  return (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean).map((extension) => `ssh-keygen${extension}`)
}

function executablePath() {
  if (process.env.PATH !== undefined) return process.env.PATH
  if (process.platform === 'win32') return `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32`
  return '/usr/bin:/bin'
}

function keygenCandidate(directory, name) {
  if (process.platform === 'win32') return path.resolve(directory.replace(/^"|"$/g, ''), name)
  // Concatenate before native traversal: path.resolve/join normalize link/.. too early.
  let prefix = directory
  if (!path.isAbsolute(directory)) prefix = directory ? `${process.cwd()}/${directory}` : process.cwd()
  return `${prefix}/${name}`
}

function resolveKeygen() {
  const self = fs.statSync(fileURLToPath(import.meta.url), { bigint: true })
  for (const directory of executablePath().split(path.delimiter)) {
    for (const name of keygenNames()) {
      const candidate = keygenCandidate(directory, name)
      if (!executableOtherThanSelf(candidate, self)) continue
      if (process.platform === 'win32' && !['.exe', '.com'].includes(path.extname(candidate))) throw new Error(`unsupported Windows command shim: ${candidate}; put native OpenSSH before this directory on PATH`)
      // Pass the natively resolved file to interpreters too; Node normalizes script argv.
      return process.platform === 'win32' ? candidate : fs.realpathSync.native(candidate)
    }
  }
  throw new Error('ssh-keygen not found on PATH (the retry wrapper itself is excluded)')
}

function signingOption(arg, next) {
  for (let offset = 1; offset < arg.length; offset++) {
    const option = arg[offset]
    if ('qvU'.includes(option)) continue
    if (!'YfnO'.includes(option)) return null
    const attached = arg.slice(offset + 1)
    const value = attached || next
    if (value === undefined) return null
    return { option, value, consumed: attached ? 0 : 1 }
  }
  return { consumed: 0 }
}

function stdinOperands(args) {
  // Replaying named files can repeat .sig writes and overwrite/confirmation prompts.
  return args.length <= 1 && args.every((word) => word === '-')
}

function signingArguments(args) {
  let operation
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') return operation === 'sign' && stdinOperands(args.slice(index + 1))
    if (arg === '-' || !arg.startsWith('-')) {
      return operation === 'sign' && stdinOperands(args.slice(index))
    }
    // Deliberately conservative: unknown/mixed modes are always pass-through.
    const parsed = signingOption(arg, args[index + 1])
    if (!parsed) return false
    index += parsed.consumed
    if (parsed.option === 'Y') {
      if (operation !== undefined) return false
      operation = parsed.value
    }
  }
  return operation === 'sign'
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

function forwardInput(child, input) {
  const record = (bytes) => input.push(Buffer.from(bytes))
  child.stdin.write(Buffer.concat(input))
  if (process.stdin.readableEnded) child.stdin.end()
  else {
    process.stdin.on('data', record)
    process.stdin.pipe(child.stdin)
  }
  return () => {
    process.stdin.unpipe(child.stdin)
    process.stdin.removeListener('data', record)
    process.stdin.pause()
    child.stdin.destroy()
  }
}

function signAttempt(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = [], stderr = []
    child.stdout.on('data', (bytes) => stdout.push(bytes))
    child.stderr.on('data', (bytes) => { stderr.push(bytes); process.stderr.write(bytes) })
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error) })
    child.once('error', reject)
    const detach = forwardInput(child, input)
    child.once('close', (code, signal) => {
      detach()
      resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
  })
}

async function sign(executable, args) {
  const input = []
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const result = await signAttempt(executable, args, input)
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
  if (signingArguments(args)) await sign(executable, args)
  else passThrough(executable, args)
}

if (invokedDirectly()) {
  try { await main() }
  catch (error) { process.stderr.write(`ssh-sign-retry: ${error.message}\n`); process.exitCode = 127 }
}
