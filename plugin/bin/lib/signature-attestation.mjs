// Re-verifies request_authorization's returned attestation; no store access.
import { createHash, createPublicKey, verify } from 'node:crypto'

const CONTEXT = ['version', 'request_id', 'native_session_id', 'kind', 'input_digest', 'expected_responder', 'expires_at', 'question_index', 'multi_select']
const OUTER = ['decision', 'responder_identity', 'signature_verified', 'request_id', 'attestation']
const ATTESTATION = ['claim', 'room_id', 'question_id', 'answer_id', 'responder_identity', 'context', 'answer', 'public_key_spki_base64', 'signature_base64', 'canonical_payload']
const ANSWER = ['text', 'selections', 'author_sig_version']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const nonempty = (value) => typeof value === 'string' && value.length > 0

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
}

function contextShape(context) {
  if (!exactKeys(context, CONTEXT)) return false
  if (context.version !== 1 || context.question_index !== 0 || context.multi_select !== false) return false
  if (!Number.isSafeInteger(context.expires_at)) return false
  return ['request_id', 'native_session_id', 'kind', 'input_digest', 'expected_responder'].every((key) => nonempty(context[key])) && UUID.test(context.request_id)
}

function answerShape(answer) {
  if (!exactKeys(answer, ANSWER, ['clarification'])) return false
  if (typeof answer.text !== 'string' || answer.author_sig_version !== 'native-ask-v1') return false
  if (!Array.isArray(answer.selections) || !answer.selections.every((s) => s === 'Yes' || s === 'No')) return false
  return answer.selections.length <= 1 && (answer.clarification === undefined || nonempty(answer.clarification))
}

function envelopeShape(value) {
  if (!exactKeys(value, OUTER, ['text'])) return false
  const a = value.attestation
  if (!exactKeys(a, ATTESTATION) || !contextShape(a.context) || !answerShape(a.answer)) return false
  if (!['claim', 'room_id', 'responder_identity', 'public_key_spki_base64', 'signature_base64', 'canonical_payload'].every((key) => nonempty(a[key]))) return false
  return Number.isSafeInteger(a.question_id) && a.question_id > 0 && Number.isSafeInteger(a.answer_id) && a.answer_id > 0
}

function signedAttestationBytes(a) {
  const context = Object.fromEntries(CONTEXT.map((key) => [key, a.context[key]]))
  return JSON.stringify(['atrium:native-ask-signature:v1', a.room_id, 'answer', a.answer.text,
    null, a.question_id, a.answer.selections, a.answer.clarification ?? null, context])
}

function decisionOf(answer) {
  if (answer.clarification) return 'clarification'
  if (answer.selections.length !== 1 || answer.text !== answer.selections[0]) throw Error('not-yes')
  return answer.text === 'Yes' ? 'yes' : 'no'
}

function transportFault(value, decision) {
  const a = value.attestation
  if (value.signature_verified !== true || value.request_id !== a.context.request_id) return 'transport-mismatch'
  if ([value.responder_identity, a.responder_identity].some((v) => v !== a.context.expected_responder)) return 'other-responder'
  if (value.decision !== decision) return 'decision-mismatch'
  if (decision === 'clarification' && value.text !== a.answer.clarification) return 'transport-mismatch'
  if (decision !== 'clarification' && value.text !== undefined) return 'transport-mismatch'
  return null
}

function keyOf(a, pin) {
  const bytes = Buffer.from(a.public_key_spki_base64, 'base64')
  const fingerprint = sha256(bytes)
  if (pin && (pin.identity !== a.context.expected_responder || !pin.keys.some((k) => k.spki === a.public_key_spki_base64 && k.sha256 === fingerprint))) throw Error('unpinned-key')
  const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw Error('wrong-key-type')
  return { key, fingerprint }
}

function authenticate(value, statement, pin) {
  const a = value.attestation
  const decision = decisionOf(a.answer)
  const fault = transportFault(value, decision)
  if (fault) throw Error(fault)
  if (a.context.kind !== 'authorization') throw Error('wrong-kind')
  if (a.context.input_digest !== sha256(statement)) throw Error('digest-mismatch')
  const bytes = signedAttestationBytes(a)
  if (bytes !== a.canonical_payload) throw Error('canonical-payload-mismatch')
  const { key, fingerprint } = keyOf(a, pin)
  if (!verify(null, Buffer.from(bytes), key, Buffer.from(a.signature_base64, 'base64'))) throw Error('altered-answer')
  return { decision, fingerprint, requestId: a.context.request_id, room: a.room_id, questionId: a.question_id, answerId: a.answer_id }
}

function fresh(context, now) {
  if (!Number.isFinite(now)) throw Error('invalid-clock')
  if (now >= context.expires_at + 300_000) throw Error('expired')
  if (context.expires_at > now + 480_000) throw Error('expiry-too-far')
}

/** All errors close here, including a hostile shape, key, canonical string or clock. */
export function verifyAttestation({ answer: value, statement, pin, now = Date.now() }) {
  try {
    if (!envelopeShape(value)) throw Error('unknown-answer-shape')
    const verified = authenticate(value, statement, pin)
    fresh(value.attestation.context, now)
    return { verified }
  } catch (error) { return { failure: { cause: error.message } } }
}
