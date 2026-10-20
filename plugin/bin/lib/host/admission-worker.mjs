// An admission verdict is provisional until this worker exits cleanly. Closing the port lets
// Node drain policy callbacks and report detached rejections before that exit.
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { formatAdmissionError } from './admission.mjs'

async function admissionRefusal({ repo, request, env, moduleVariable: variable }) {
  try {
    const { default: admit } = await import(pathToFileURL(env[variable]).href)
    if (typeof admit !== 'function') return `${variable}: default export must be a function`
    const result = await admit({ repo, request, env })
    if (result === null) return null
    if (typeof result === 'string' && result.trim()) return `${variable}: ${result}`
    return `${variable}: admit must return null or a non-empty string`
  } catch (error) {
    return `${variable}: admission module failed: ${formatAdmissionError(error)}`
  }
}

// Unresolved promises alone do not keep a worker alive while policy is pending.
const pending = setInterval(() => {}, 60_000)
parentPort.postMessage(await admissionRefusal(workerData))
clearInterval(pending)
parentPort.close()
