/** Owner authorization is TOFU at pin time. Deliberate same-user rewrites of the pin,
 * install or claims defeat it, as --no-verify does. Only relayed answers are visible;
 * session and previous remote tip are not bound. answer_id is unsigned metadata.
 */
import { isAbsolute } from 'node:path'
import { sha256, verifyAttestation } from './signature-attestation.mjs'
import { answerFiles, archiveAnswer, claimExists, createClaim, localDestination, logException, readJson, validExceptionConfig, writeOwnerPin } from './host/signature-exception-io.mjs'

export const PIN_STATEMENT = 'workflow-toolbox: pin the signing key of this answer as the owner key for signature exceptions'

function remoteDestination(url) {
  const scheme = /^([a-z][\w+.-]*):\/\/((?:[^/@\s]+@)?)(\[[^\]]+\]|[^/:\s]*)(:\d+)?(\/.*)$/i.exec(url)
  if (scheme) return `${scheme[1].toLowerCase()}://${scheme[2]}${scheme[3].toLowerCase()}${scheme[4] ?? ''}${scheme[5].replace(/\/$/, '')}`
  const scp = /^((?:[^/@:]+@)?)(\[[^\]]+\]|[^/:]+):([^:].*)$/.exec(url)
  if (scp) return `${scp[1]}${scp[2].toLowerCase()}:${scp[3]}`
  return null
}

function resolveLocal(url, baseDir) {
  try { return localDestination(url, baseDir) } catch { throw Error('unmeasurable-destination') }
}

export function authorizationDestination(url, baseDir = process.cwd()) {
  if (typeof url !== 'string' || !url || /[?#\r\n]/.test(url)) throw Error('unmeasurable-destination')
  if (isAbsolute(url) || /^[a-z]:[\\/]/i.test(url)) return resolveLocal(url, baseDir)
  const remote = remoteDestination(url)
  if (remote) return remote
  if (url.includes(':')) throw Error('unmeasurable-destination')
  return resolveLocal(url, baseDir)
}

export function exceptionStatement({ destination, ref, newSha }) {
  if (typeof ref !== 'string' || !/^refs\/heads\/[^\s]+$/.test(ref)) throw Error('not-a-branch')
  if (typeof newSha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(newSha)) throw Error('invalid-new-sha')
  if (typeof destination !== 'string' || !destination || /[\r\n]/.test(destination)) throw Error('unmeasurable-destination')
  return `workflow-toolbox signature exception v1: allow updating ${destination} ${ref} to ${newSha.toLowerCase()} once, although it carries commits without an acceptable signature`
}

function loadPin(file) {
  try {
    const pin = readJson(file)
    if (pin.version !== 1 || typeof pin.identity !== 'string' || !pin.identity || !Array.isArray(pin.keys) || !pin.keys.length) throw Error('invalid pin')
    if (!pin.keys.every((key) => typeof key.spki === 'string' && key.sha256 === sha256(Buffer.from(key.spki, 'base64')))) throw Error('invalid pin key')
    return pin
  } catch { throw Error('no-pinned-owner-key') }
}

function candidate(file, statement, pin, now, used) {
  let answer
  try { answer = readJson(file) }
  catch { return { failure: { cause: 'malformed-json', file } } }
  const result = verifyAttestation({ answer, statement, pin, now })
  if (result.failure) return { failure: { ...result.failure, file } }
  return { ...result, answer, file, used }
}

function selectAnswer(config, statement, pin, now) {
  const inbox = answerFiles(config)
  if (inbox.length > 1000) throw Error('too-many-answers')
  const candidates = inbox.map((file) => candidate(file, statement, pin, now, false))
  const veto = candidates.find((c) => c.verified && c.verified.decision !== 'yes')
  if (veto) return { failure: { cause: 'refused-by-owner', file: veto.file } }
  const grants = candidates.filter((c) => c.verified)
  const grant = grants.find((c) => !claimExists(config, c.verified.requestId))
  if (grant) return { grant }
  if (grants.length) return { failure: { cause: 'already-used' } }
  const used = answerFiles(config, true)
  if (used.length > 1000) throw Error('too-many-answers')
  const replay = used.some((file) => candidate(file, statement, pin, now, true).verified)
  if (replay) return { failure: { cause: 'already-used' } }
  return { failure: candidates[0]?.failure ?? { cause: 'no-answer' } }
}

function spend(config, grant, statement, now) {
  const record = { attestation: grant.answer, statement, digest: sha256(statement), guard: 'pre-push',
    at: new Date(now).toISOString(), pid: process.pid, answer_id_verified: false }
  let claim
  try { claim = createClaim(config, grant.verified.requestId, record) }
  catch (error) { return { failure: { cause: error.code === 'EEXIST' ? 'already-used' : 'claim-failed', detail: error.message } } }
  try {
    archiveAnswer(config, grant.verified.requestId, grant.file)
    logException(config, { ...grant.verified, digest: record.digest, statement, guard: 'pre-push', at: record.at, outcome: 'opened', claim, answer_id_verified: false })
    return { opened: { ...grant.verified, claim } }
  } catch (error) { return { failure: { cause: 'recording-failed', detail: error.message, claim } } }
}

function evaluate({ statement, config, now, consume }) {
  if (!validExceptionConfig(config)) return { failure: { cause: 'install-predates-exceptions' } }
  const pin = loadPin(config.ownerKeysFile)
  const result = selectAnswer(config, statement, pin, now)
  if (!result.grant) return result
  return consume ? spend(config, result.grant, statement, now) : { opened: result.grant.verified }
}

/** Preview is read-only. Only the installed pre-push runtime requests consume=true. */
export function findOwnerException({ statement, config, now = Date.now(), consume = false }) {
  let result
  try { result = evaluate({ statement, config, now, consume }) }
  catch (error) { result = { failure: { cause: error.message } } }
  if (consume && result.failure && validExceptionConfig(config)) {
    try { logException(config, { statement, digest: sha256(statement), guard: 'pre-push', at: new Date(now).toISOString(), outcome: 'refused', ...result.failure }) }
    catch (error) { result.failure.logError = error.message }
  }
  return result
}

export function pinOwnerKey({ config, answer, now = Date.now() }) {
  try {
    if (!validExceptionConfig(config)) throw Error('install-predates-exceptions')
    const result = verifyAttestation({ answer, statement: PIN_STATEMENT, now })
    if (result.failure) return result
    if (result.verified.decision !== 'yes') throw Error('refused-by-owner')
    const a = answer.attestation
    const pin = { version: 1, identity: a.context.expected_responder,
      keys: [{ spki: a.public_key_spki_base64, sha256: result.verified.fingerprint }],
      pinnedAt: new Date(now).toISOString(), pinnedFrom: { room_id: a.room_id, question_id: a.question_id, answer_id: a.answer_id, request_id: a.context.request_id } }
    writeOwnerPin(config.ownerKeysFile, pin)
    logException(config, { outcome: 'pinned', ...result.verified, answer_id_verified: false, at: pin.pinnedAt })
    return { pinned: pin, limit: 'TOFU: check the responder identity with Atrium get_owner. Rotation requires deliberately deleting this pin and pinning again.' }
  } catch (error) { return { failure: { cause: error.message } } }
}

export function exceptionHelp(statement, failure, repo) {
  const reinstall = `node plugin/bin/wt-push-guard-install.mjs --install --repo ${JSON.stringify(repo)} --guard-remote <remote>`
  const file = failure.file ? ' in ' + failure.file : ''
  const lines = [`Owner signature exception unavailable [${failure.cause}]${file}.`]
  if (failure.cause === 'install-predates-exceptions') lines.push(`Reinstall: ${reinstall}`)
  if (failure.cause === 'no-pinned-owner-key') lines.push(`Call Atrium request_authorization with exactly ${JSON.stringify(PIN_STATEMENT)}, save its returned JSON, then run node plugin/bin/wt-signature-exception.mjs pin --repo ${JSON.stringify(repo)} --attestation <file>. Verify the identity with Atrium get_owner (TOFU).`)
  if (statement) lines.push(`The main session calls Atrium request_authorization with exactly this text:\n${statement}\nRelay the returned JSON unmodified to the installed config's exceptionInboxDir as a .json file, then retry the same push within the signed freshness window (at most 13 minutes from the request).`)
  lines.push('One signed Yes covers one ref update attempt, including a failed push or dry-run. Other refs need separate answers. A plain message, report or environment variable does not open this exception. A relayed signed No or clarification vetoes it; unrelayed answers are not visible.')
  return lines.join('\n')
}
