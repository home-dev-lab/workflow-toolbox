// Admission policies are trusted code with the caller's privileges, not sandboxed.
// A child owns the policy's descriptors; its worker preserves failure/drain semantics.
import path from 'node:path'
import { resolveAdmissionModule } from './admission-options.mjs'
import { reportAdmissionCleanup } from './admission-process.mjs'
import { admissionContainmentHost, admissionContainmentRefusal, finishAdmissionContainer, startAdmissionContainer } from './admission-containment.mjs'

export { formatAdmissionError, workerAdmission } from './admission-process.mjs'

export async function boundedAdmission(options, env, { moduleVariable, timeoutVariable, silent = false, admission = resolveAdmissionModule(moduleVariable, env), signal = options.signal, host }) {
  const timeout = Number(env[timeoutVariable] ?? 10_000)
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    return `${moduleVariable}: ${timeoutVariable} must be a positive integer no greater than 2147483647`
  }
  if (!admission) return null
  if (!path.isAbsolute(admission.path)) return `${moduleVariable}: must name an absolute ES module path`
  return processAdmission(options, env, timeout, moduleVariable, silent, admission, { signal, host })
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

async function processAdmission({ repo, request }, env, timeout, moduleVariable, silent, admission, { signal, host = admissionContainmentHost() }) {
  const unsupported = admissionContainmentRefusal(host)
  if (unsupported) return `${moduleVariable}: ${unsupported}`
  const deadline = performance.now() + timeout
  const child = startAdmissionContainer(env, host)
  reportAdmissionCleanup(moduleVariable)
  // Drain both pipes without forwarding: even writeSync(1/2) stays off the CLI protocol.
  child.stdout.resume(); child.stderr.resume()
  // `close` also waits for inherited pipes; reap the supervisor separately after cleanup.
  const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', () => { if (!child.pid) resolve() }) })
  const verdict = processVerdict(child, moduleVariable)
  const expired = `${moduleVariable}: timed out after ${timeout} ms`
  const cancellation = admissionCancellation(signal, moduleVariable)
  let timer
  let refusal
  let failure
  try {
    child.send({ options: { repo, request }, env, timeout, moduleVariable, silent, admission })
    refusal = await Promise.race([
      verdict,
      cancellation.promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(expired), Math.max(0, deadline - performance.now())) }),
    ])
    if (performance.now() >= deadline) refusal = expired
  } catch (error) {
    failure = error
  } finally {
    cancellation.dispose()
    clearTimeout(timer)
    await finishAdmissionContainer(child, exited)
  }
  if (child.exitCode !== 0) return `${moduleVariable}: containment unknown: launcher exited with code ${child.exitCode}, signal ${child.signalCode}`
  if (failure) throw failure
  return refusal
}

function processVerdict(child, variable) {
  return new Promise((resolve, reject) => {
    let verdict
    let failure
    child.on('message', (message) => {
      verdict = message.refusal; failure = message.error
      if (failure) return reject(new Error(failure))
      if (verdict === null || typeof verdict === 'string') return resolve(verdict)
      resolve(`${variable}: admission worker exited without a verdict`)
    })
    child.on('error', error => resolve(`${variable}: containment unknown: ${error.message}`))
    child.on('exit', (code) => {
      if (failure) return reject(new Error(failure))
      if (code !== 0) return resolve(`${variable}: admission worker exited with code ${code}`)
      if (verdict === null || typeof verdict === 'string') return resolve(verdict)
      resolve(`${variable}: admission worker exited without a verdict`)
    })
  })
}
