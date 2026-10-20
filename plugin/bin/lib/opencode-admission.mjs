import { boundedAdmission, formatAdmissionError } from './host/admission.mjs'
import { requestDigest } from './host/opencode-request-files.mjs'

// Keep the bridge protocol separate from second-opinion's file publication protocol.

export async function opencodeAdmission(options, env, moduleVariable) {
  if (env[moduleVariable] === undefined) return null
  try {
    return await boundedAdmission(options, env, { moduleVariable, timeoutVariable: `${moduleVariable}_TIMEOUT_MS`, silent: true })
  } catch (error) {
    return `${moduleVariable}: admission failed: ${formatAdmissionError(error)}`
  }
}

export class OpencodeAdmissionRefusal extends Error {
  constructor(refusal) {
    super(`OPENCODE_REFUSED: ${refusal.replace(/[\r\n\u2028\u2029]+/g, ' ')}`)
  }
}

export async function requireOpencodeAdmission(options, env, moduleVariable) {
  const refusal = await opencodeAdmission(options, env, moduleVariable)
  if (refusal !== null) throw new OpencodeAdmissionRefusal(refusal)
}

export function requireUnchangedRequest(taskfile, sha256, moduleVariable, env = process.env) {
  if (env[moduleVariable] === undefined) return
  try {
    if (requestDigest(taskfile) === sha256) return
  } catch { /* Missing or unreadable requests also fail closed. */ }
  throw new OpencodeAdmissionRefusal(`${moduleVariable}: request changed after admission: ${taskfile}`)
}
