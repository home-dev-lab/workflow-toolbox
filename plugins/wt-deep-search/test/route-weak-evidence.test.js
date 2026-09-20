import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { route } from '../src/route.js'

const providers = {
  mirror: { available: true, path: '/home/u/.claude-code-docs' },
  brave: { available: true },
  exa: { available: true },
  opencode: { available: true, path: '/usr/bin/opencode' },
}

// WHY A SECOND TIER EXISTS, and why it is not a relaxation of the review's finding.
//
// The review was right that a generic noun cannot PROVE a question is about Claude Code.
// The fix answered by demanding a product-specific token, which sends a bare "comment
// marchent les agents" — the shape the owner actually types — to a PAID search.
//
// The costs are asymmetric and that is what resolves it. Consulting the mirror is local,
// free and takes milliseconds; being wrong there costs nothing, because a mirror that finds
// nothing relevant makes the caller fall through to the ordinary web search. Skipping the
// mirror costs a paid call AND a worse answer. So weak evidence CONSULTS; it does not decide.
//
// `confidence` is what carries that: 'strong' means the mirror answers, 'weak' means the
// mirror is asked first and its own result decides whether the answer stands.

test('a product-specific identifier is strong evidence', () => {
  const d = route('how do I register a hook on PostToolUse', providers)
  assert.equal(d.provider, 'mirror')
  assert.equal(d.confidence, 'strong')
})

for (const question of [
  'comment marchent les agents',
  'what changed in the changelog recently',
  'quelles options acceptent les settings de permissions',
  'what does the formatter plugin do',
]) {
  test(`weak evidence consults the mirror: ${question}`, () => {
    const d = route(question, providers)
    assert.equal(d.provider, 'mirror')
    assert.equal(d.confidence, 'weak')
  })
}

// A foreign brand cannot veto STRONG evidence, but it decides a WEAK case: "React hooks" is
// someone else's documentation and our corpus has no claim on it.
for (const question of ['how do React hooks work', 'how do I configure eslint plugins']) {
  test(`a foreign brand settles a weak case: ${question}`, () => {
    assert.notEqual(route(question, providers).provider, 'mirror')
  })
}

test('a question with no Claude signal at all never reaches the mirror', () => {
  assert.notEqual(route('what is the weather in London', providers).provider, 'mirror')
  assert.notEqual(route('quel est le prix du litre de diesel', providers).provider, 'mirror')
})
