// Admission policies are trusted code with the caller's privileges, not sandboxed.
// A child owns the policy's descriptors; its worker preserves failure/drain semantics.
import { fork } from 'node:child_process'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { resolveAdmissionModule } from './admission-options.mjs'

export function formatAdmissionError(error) {
  try { return String(error instanceof Error ? error.message : error) } catch { return 'unprintable thrown value' }
}

export async function boundedAdmission(options, env, { moduleVariable, timeoutVariable, silent = false, admission = resolveAdmissionModule(moduleVariable, env), signal = options.signal }) {
  const timeout = Number(env[timeoutVariable] ?? 10_000)
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    return `${moduleVariable}: ${timeoutVariable} must be a positive integer no greater than 2147483647`
  }
  if (!admission) return null
  if (!path.isAbsolute(admission.path)) return `${moduleVariable}: must name an absolute ES module path`
  return processAdmission(options, env, timeout, moduleVariable, silent, admission, signal)
}

function admissionCancellation(signal, variable) {
  let abort
  const promise = new Promise((resolve) => {
    abort = () => resolve(`${variable}: interrupted during admission`)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
  return { promise, dispose: () => signal?.removeEventListener('abort', abort) }
}

async function processAdmission({ repo, request }, env, timeout, moduleVariable, silent, admission, signal) {
  const deadline = performance.now() + timeout
  const child = fork(new URL('./admission-process.mjs', import.meta.url), [], {
    env, execArgv: ['--unhandled-rejections=strict'], serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  // Drain both pipes without forwarding: even writeSync(1/2) stays off the CLI protocol.
  child.stdout.resume(); child.stderr.resume()
  // `close` also waits for inherited pipes held by descendants; only reap our direct child.
  const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve) })
  const verdict = processVerdict(child, moduleVariable)
  const expired = `${moduleVariable}: timed out after ${timeout} ms`
  const cancellation = admissionCancellation(signal, moduleVariable)
  let timer
  try {
    child.send({ options: { repo, request }, env, timeout, moduleVariable, silent, admission })
    const refusal = await Promise.race([
      verdict,
      cancellation.promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(expired), Math.max(0, deadline - performance.now())) }),
    ])
    return performance.now() >= deadline ? expired : refusal
  } finally {
    cancellation.dispose()
    clearTimeout(timer)
    child.kill('SIGKILL')
    child.stdout.destroy(); child.stderr.destroy()
    await exited
  }
}

function processVerdict(child, variable) {
  return new Promise((resolve, reject) => {
    let verdict
    let failure
    child.on('message', (message) => { verdict = message.refusal; failure = message.error })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (failure) return reject(new Error(failure))
      if (code !== 0) return resolve(`${variable}: admission worker exited with code ${code}`)
      if (verdict === null || typeof verdict === 'string') return resolve(verdict)
      resolve(`${variable}: admission worker exited without a verdict`)
    })
  })
}

export async function workerAdmission({ repo, request }, env, timeout, moduleVariable, silent, admission) {
  const deadline = performance.now() + timeout
  const worker = new Worker(new URL('./admission-worker.mjs', import.meta.url), {
    workerData: { repo, request, env, moduleVariable, admission }, env, execArgv: ['--unhandled-rejections=strict'],
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
