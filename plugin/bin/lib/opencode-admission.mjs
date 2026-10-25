import { boundedAdmission, formatAdmissionError } from './host/admission.mjs'
import { requestDigest } from './host/opencode-request-files.mjs'
import { resolveAdmissionModule } from './host/admission-options.mjs'
import { createAdmissionSnapshot } from './host/admission-snapshot.mjs'

// Keep the bridge protocol separate from second-opinion's file publication protocol.
export class OpencodeAdmissionRefusal extends Error {
  constructor(refusal) {
    super(`OPENCODE_REFUSED: ${refusal.replace(/[\r\n\u2028\u2029]+/g, ' ')}`)
  }
}

export function resolveOpencodeAdmission(moduleVariable, env) {
  try { return resolveAdmissionModule(moduleVariable, env) } catch (error) {
    throw new OpencodeAdmissionRefusal(formatAdmissionError(error))
  }
}

export function opencodeSnapshot(repo, spellings, moduleVariable) {
  try {
    const snapshot = createAdmissionSnapshot(repo, spellings)
    return {
      ...snapshot,
      rewrite(text) {
        try { return snapshot.rewrite(text) } catch (error) {
          throw new OpencodeAdmissionRefusal(`${moduleVariable}: ${formatAdmissionError(error)}`)
        }
      },
    }
  } catch (error) {
    throw new OpencodeAdmissionRefusal(`${moduleVariable}: ${formatAdmissionError(error)}`)
  }
}

export function freezeOpencodeSnapshot(snapshot) {
  try { snapshot?.freeze() } catch (error) {
    throw new OpencodeAdmissionRefusal(formatAdmissionError(error))
  }
}

export async function opencodeAdmission(options, env, moduleVariable, admission = resolveOpencodeAdmission(moduleVariable, env)) {
  if (!admission) return null
  try {
    return await boundedAdmission(options, env, { moduleVariable, timeoutVariable: `${moduleVariable}_TIMEOUT_MS`, silent: true, admission })
  } catch (error) {
    return `${moduleVariable}: admission failed: ${formatAdmissionError(error)}`
  }
}

export async function requireOpencodeAdmission(options, env, moduleVariable, admission = resolveOpencodeAdmission(moduleVariable, env)) {
  const refusal = await opencodeAdmission(options, env, moduleVariable, admission)
  if (refusal !== null) throw new OpencodeAdmissionRefusal(refusal)
}

export function requireUnchangedRequest(taskfile, sha256, moduleVariable, admission, signal) {
  if (signal?.aborted) throw new OpencodeAdmissionRefusal(`${moduleVariable}: interrupted before launch`)
  if (!admission) return
  try {
    if (requestDigest(taskfile) === sha256) return
  } catch { /* Missing or unreadable requests also fail closed. */ }
  throw new OpencodeAdmissionRefusal(`${moduleVariable}: request changed after admission: ${taskfile}`)
}
