import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM fixture also used by node end-to-end probes
import { attestation, exceptionFixture, signingOwner } from './helpers/atrium-attestation-fixture.mjs'
// @ts-expect-error plugin runtime module
import { authorizationDestination, exceptionStatement, findOwnerException, pinOwnerKey, PIN_STATEMENT } from '../../../../plugin/bin/lib/signature-exception.mjs'
// @ts-expect-error plugin runtime module
import { signatureCheckResult } from '../../../../plugin/bin/lib/signature-check-result.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const target = { destination: 'ssh://git@example.invalid/Team/Repo.git', ref: 'refs/heads/main', newSha: 'a'.repeat(40) }
const statement = `workflow-toolbox signature exception v1: allow updating ${target.destination} ${target.ref} to ${target.newSha} once, although it carries commits without an acceptable signature`
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-exception-'))
  roots.push(root)
  const f = exceptionFixture(root)
  const now = Date.now()
  const answer = attestation(statement, f.owner, { context: { expires_at: now + 480_000 } })
  const check = (consume = false) => findOwnerException({ statement, config: f.config, now, consume })
  return { ...f, root, now, answer, check }
}

describe('signed owner signature exception', () => {
  it.each(['', 'not JSON', '{}', '{"offenders":[{}],"text":""}'])('refuses malformed clean checker output %j', (stdout) => {
    expect(() => signatureCheckResult({ status: 0, stdout })).toThrow()
  })
  it('binds the exact destination, full ref and new object id', () => {
    expect(exceptionStatement(target)).toBe(statement)
    expect(() => exceptionStatement({ ...target, ref: 'refs/tags/v1' })).toThrow('not-a-branch')
    expect(() => exceptionStatement({ ...target, newSha: 'HEAD' })).toThrow('invalid-new-sha')
  })
  it('previews without writing, then claims, archives and logs a Yes exactly once', () => {
    const f = fixture()
    f.relay(f.answer)
    expect(f.check().opened).toBeTruthy()
    expect(existsSync(join(f.config.exceptionStateDir, 'claims'))).toBe(false)
    expect(f.check(true).opened).toBeTruthy()
    const claim = JSON.parse(readFileSync(join(f.config.exceptionStateDir, 'claims', `${f.answer.request_id}.json`), 'utf8'))
    expect(claim.statement).toBe(statement)
    expect(claim.attestation).toEqual(f.answer)
    expect(claim.answer_id_verified).toBe(false)
    expect(readdirSync(join(f.config.exceptionStateDir, 'used'))).toHaveLength(1)
    expect(readFileSync(join(f.config.exceptionStateDir, 'exceptions.jsonl'), 'utf8')).toContain('opened')
    expect(f.check(true).failure.cause).toBe('already-used')
  })
  it('refuses unrecorded answers, missing pins and older install configuration', () => {
    const f = fixture()
    expect(f.check().failure.cause).toBe('no-answer')
    rmSync(f.config.ownerKeysFile)
    expect(f.check().failure.cause).toBe('no-pinned-owner-key')
    expect(findOwnerException({ statement, config: {} }).failure.cause).toBe('install-predates-exceptions')
  })
  it.each([
    ['text', (a: Record<string, unknown>) => { a.text = 'No' }],
    ['selection', (a: Record<string, unknown>) => { a.selections = ['No'] }],
  ])('refuses altered answer %s', (_name, mutate) => {
    const f = fixture()
    mutate(f.answer.attestation.answer)
    f.relay(f.answer)
    expect(f.check().failure).toBeTruthy()
  })
  it.each(['room_id', 'question_id', 'canonical_payload', 'signature_base64', 'public_key_spki_base64'])('refuses altered %s', (field) => {
    const f = fixture()
    f.answer.attestation[field] = field === 'question_id' ? 12 : 'forged'
    f.relay(f.answer)
    expect(f.check().failure).toBeTruthy()
  })
  it.each(['request_id', 'native_session_id', 'kind', 'input_digest', 'expected_responder', 'expires_at', 'question_index', 'multi_select', 'version'])('refuses altered signed context %s', (field) => {
    const f = fixture()
    f.answer.attestation.context[field] = 'altered'
    f.relay(f.answer)
    expect(f.check().failure).toBeTruthy()
  })
  it.each(['request_id', 'decision', 'responder_identity', 'signature_verified'])('refuses mismatched transport %s', (field) => {
    const f = fixture()
    f.answer[field] = 'mismatch'
    f.relay(f.answer)
    expect(f.check().failure).toBeTruthy()
  })
  it('refuses a copied spent grant with a changed outer request id', () => {
    const f = fixture()
    f.relay(f.answer)
    expect(f.check(true).opened).toBeTruthy()
    f.answer.request_id = '00000000-0000-0000-0000-000000000000'
    f.relay(f.answer)
    expect(f.check(true).failure).toBeTruthy()
    expect(readdirSync(join(f.config.exceptionStateDir, 'claims'))).toHaveLength(1)
  })
  it('refuses an unpinned signing key and mismatched inner responder', () => {
    const f = fixture()
    f.relay(attestation(statement, signingOwner()))
    expect(f.check().failure.cause).toBe('unpinned-key')
    f.answer.attestation.responder_identity = 'another-owner'
    f.relay(f.answer)
    expect(f.check().failure).toBeTruthy()
  })
  it.each([
    [-300_001, false], [-300_000, false], [-299_999, true], [480_000, true], [480_001, false],
  ])('applies signed freshness boundary %i without rounding', (offset, opens) => {
    const f = fixture()
    f.relay(attestation(statement, f.owner, { context: { expires_at: f.now + offset } }))
    expect(Boolean(f.check().opened)).toBe(opens)
  })
  it.each(['destination', 'ref', 'newSha'])('refuses another target %s', (field) => {
    const f = fixture()
    const other = { ...target, [field]: field === 'newSha' ? 'b'.repeat(40) : `${target[field as keyof typeof target]}-other` }
    f.relay(attestation(exceptionStatement(other), f.owner))
    expect(f.check().failure.cause).toBe('digest-mismatch')
  })
  it.each(['No', 'clarification'])('vetoes every Yes when a signed %s is relayed', (choice) => {
    const f = fixture()
    f.relay(f.answer, 'a-yes.json')
    f.relay(attestation(statement, f.owner, { ...(choice === 'No' ? { choice } : { answer: { clarification: 'Wait', selections: [], text: 'Wait' } }), context: { expires_at: f.now + 480_000 } }), 'z-veto.json')
    expect(f.check(true).failure.cause).toBe('refused-by-owner')
    expect(existsSync(join(f.config.exceptionStateDir, 'claims'))).toBe(false)
  })
  it('rejects malformed JSON, unknown fields and traversal request ids', () => {
    const f = fixture()
    writeFileSync(join(f.config.exceptionInboxDir, 'answer.json'), '{')
    expect(f.check().failure.cause).toBe('malformed-json')
    f.relay(attestation(statement, f.owner, { context: { request_id: '../escape' } }))
    expect(f.check().failure).toBeTruthy()
    f.answer.attestation.context.extra = true
    f.relay(f.answer)
    expect(f.check().failure).toBeTruthy()
  })
  it('rebuilds the context in producer order rather than inbox property order', () => {
    const f = fixture()
    f.answer.attestation.context = Object.fromEntries(Object.entries(f.answer.attestation.context).reverse())
    f.relay(f.answer)
    expect(f.check().opened).toBeTruthy()
  })
  it('leaves a claim spent after an archive or journal error', () => {
    const f = fixture()
    f.relay(f.answer)
    writeFileSync(join(f.config.exceptionStateDir, 'used'), 'not a directory')
    expect(f.check(true).failure.cause).toBe('recording-failed')
    expect(f.check().failure.cause).toBe('already-used')
  })
  it('pins only a fresh signed Yes for the pin statement, without key additions', () => {
    const f = fixture()
    rmSync(f.config.ownerKeysFile)
    expect(pinOwnerKey({ config: f.config, answer: f.answer, now: f.now }).failure).toBeTruthy()
    const answer = attestation(PIN_STATEMENT, f.owner, { context: { expires_at: f.now + 480_000 } })
    expect(pinOwnerKey({ config: f.config, answer, now: f.now }).pinned).toBeTruthy()
    expect(pinOwnerKey({ config: f.config, answer, now: f.now }).pinned).toBeTruthy()
    expect(pinOwnerKey({ config: f.config, answer: attestation(PIN_STATEMENT, signingOwner(), { context: { expires_at: f.now + 480_000 } }), now: f.now }).failure.cause).toBe('pin-differs')
  })
  it('preserves case, suffixes and transport spellings; resolves existing local paths', () => {
    const f = fixture()
    expect(authorizationDestination('SSH://git@EXAMPLE.invalid/Team/Repo.git/')).toBe(target.destination)
    expect(authorizationDestination('git@EXAMPLE.invalid:Team/Repo.git')).toBe('git@example.invalid:Team/Repo.git')
    expect(authorizationDestination('git@EXAMPLE.invalid:Team/Repo.git/')).toBe('git@example.invalid:Team/Repo.git/')
    expect(authorizationDestination('ssh://git@example.invalid/Team/repo.git')).not.toBe(target.destination)
    expect(authorizationDestination('ssh://git@example.invalid/Team/Repo')).not.toBe(target.destination)
    expect(authorizationDestination('.', f.root)).toBe(authorizationDestination(f.root))
    for (const url of ['x::abc', 'ssh://host/a?b', './absent']) expect(() => authorizationDestination(url, f.root)).toThrow('unmeasurable-destination')
  })
})
