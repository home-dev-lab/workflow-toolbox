// Admission policies are trusted code with the caller's privileges, not sandboxed.
// A child owns the policy's descriptors; its worker preserves failure/drain semantics.
import { fork } from 'node:child_process'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

export function formatAdmissionError(error) {
  try { return String(error instanceof Error ? error.message : error) } catch { return 'unprintable thrown value' }
}

export async function boundedAdmission(options, env, { moduleVariable, timeoutVariable, silent = false }) {
  const timeout = Number(env[timeoutVariable] ?? 10_000)
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    return `${moduleVariable}: ${timeoutVariable} must be a positive integer no greater than 2147483647`
  }
  if (!path.isAbsolute(env[moduleVariable])) return `${moduleVariable}: must name an absolute ES module path`
  return processAdmission(options, env, timeout, moduleVariable, silent)
}

async function processAdmission({ repo, request }, env, timeout, moduleVariable, silent) {
  const deadline = performance.now() + timeout
  const child = fork(new URL('./admission-process.mjs', import.meta.url), [], {
    env, execArgv: ['--unhandled-rejections=strict'], serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  // Drain both pipes without forwarding: even writeSync(1/2) stays off the CLI protocol.
  child.stdout.resume(); child.stderr.resume()
  const exited = new Promise((resolve) => child.once('close', resolve))
  const verdict = processVerdict(child, moduleVariable)
  const expired = `${moduleVariable}: timed out after ${timeout} ms`
  let timer
  try {
    child.send({ options: { repo, request }, env, timeout, moduleVariable, silent })
    const refusal = await Promise.race([
      verdict,
      new Promise((resolve) => { timer = setTimeout(() => resolve(expired), Math.max(0, deadline - performance.now())) }),
    ])
    return performance.now() >= deadline ? expired : refusal
  } finally {
    clearTimeout(timer)
    child.kill('SIGKILL')
    await exited
  }
}

function processVerdict(child, variable) {
  return new Promise((resolve, reject) => {
    let verdict
    let failure
    child.on('message', (message) => { verdict = message.refusal; failure = message.error })
    child.on('error', reject)
    child.on('close', (code) => {
      if (failure) return reject(new Error(failure))
      if (code !== 0) return resolve(`${variable}: admission worker exited with code ${code}`)
      if (verdict === null || typeof verdict === 'string') return resolve(verdict)
      resolve(`${variable}: admission worker exited without a verdict`)
    })
  })
}

export async function workerAdmission({ repo, request }, env, timeout, moduleVariable, silent) {
  const deadline = performance.now() + timeout
  const worker = new Worker(new URL('./admission-worker.mjs', import.meta.url), {
    workerData: { repo, request, env, moduleVariable }, env, execArgv: ['--unhandled-rejections=strict'],
    ...(silent ? { stdout: true, stderr: true } : {}),
  })
  if (silent) { worker.stdout.resume(); worker.stderr.resume() }
  let timer
  const expired = `${moduleVariable}: timed out after ${timeout} ms`
  try {
    const refusal = await Promise.race([
      workerVerdict(worker, moduleVariable),
      new Promise((resolve) => { timer = setTimeout(() => resolve(expired), Math.max(0, deadline - performance.now())) }),
    ])
    return performance.now() >= deadline ? expired : refusal
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
}

function workerVerdict(worker, variable) {
  return new Promise((resolve) => {
    let verdict
    let failure
    worker.on('message', (message) => { verdict = message })
    worker.on('error', (error) => { failure = `${variable}: admission worker failed: ${formatAdmissionError(error)}` })
    worker.on('exit', (code) => {
      if (failure) return resolve(failure)
      if (code !== 0) return resolve(`${variable}: admission worker exited with code ${code}`)
      if (verdict === null || typeof verdict === 'string') return resolve(verdict)
      resolve(`${variable}: admission worker exited without a verdict`)
    })
  })
}
