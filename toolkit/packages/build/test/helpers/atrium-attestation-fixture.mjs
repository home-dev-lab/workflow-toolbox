import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function signingOwner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  return { identity: 'test-owner', spki, privateKey }
}

// Producer order is intentional; this helper does not call the verifier's serializer.
export function attestation(statement, owner, options = {}) {
  const context = {
    version: 1, request_id: randomUUID(), native_session_id: 'test-session', kind: 'authorization',
    input_digest: createHash('sha256').update(statement).digest('hex'), expected_responder: owner.identity,
    expires_at: Date.now() + 480_000, question_index: 0, multi_select: false, ...options.context,
  }
  const choice = options.choice ?? 'Yes'
  const answer = {
    text: choice, selections: [choice], ...options.answer, author_sig_version: 'native-ask-v1',
  }
  const room_id = options.room_id ?? 'test-room'
  const question_id = options.question_id ?? 10
  const canonical_payload = JSON.stringify([
    'atrium:native-ask-signature:v1', room_id, 'answer', answer.text, null, question_id,
    answer.selections, answer.clarification ?? null, context,
  ])
  return {
    decision: answer.clarification ? 'clarification' : choice === 'Yes' ? 'yes' : 'no',
    ...(answer.clarification ? { text: answer.clarification } : {}),
    responder_identity: owner.identity, signature_verified: true, request_id: context.request_id,
    attestation: {
      claim: 'The registered workspace owner signed this decision over the identified authorization text; it does not prove that any operation was executed.',
      room_id, question_id, answer_id: 11, responder_identity: owner.identity, context, answer,
      public_key_spki_base64: owner.spki,
      signature_base64: sign(null, Buffer.from(canonical_payload), owner.privateKey).toString('base64'), canonical_payload,
    },
  }
}

export function exceptionFixture(root) {
  const owner = signingOwner()
  const exceptionStateDir = join(root, 'exceptions')
  const exceptionInboxDir = join(exceptionStateDir, 'inbox')
  const ownerKeysFile = join(root, 'owner-keys.json')
  const config = { ownerKeysFile, exceptionStateDir, exceptionInboxDir }
  mkdirSync(exceptionInboxDir, { recursive: true })
  writeFileSync(ownerKeysFile, JSON.stringify({ version: 1, identity: owner.identity, keys: [{
    spki: owner.spki, sha256: createHash('sha256').update(Buffer.from(owner.spki, 'base64')).digest('hex'),
  }], pinnedAt: new Date().toISOString() }))
  function relay(value, name = 'answer.json') {
    const file = join(exceptionInboxDir, name)
    writeFileSync(file, JSON.stringify(value))
    return file
  }
  return { owner, config, relay }
}
