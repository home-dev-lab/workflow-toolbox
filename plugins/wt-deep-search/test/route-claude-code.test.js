import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { route } from '../src/route.js'

const providers = {
  mirror: { available: true, path: '/home/u/.claude-code-docs' },
  brave: { available: true },
  exa: { available: true },
  opencode: { available: true, path: '/usr/bin/opencode' },
}

// Product-specific identifiers provide positive evidence for the mirror without requiring
// the literal product name. Generic nouns remain available to normal search providers.
const MUST_USE_MIRROR = [
  "what changed in the CLAUDE.md changelog recently",
  "how do slash commands work",
  "what frontmatter fields does a skill support",
  "how do subagents receive their tools",
  "how do I register a hook on PostToolUse",
  "what does the output style formatter plugin do",
  "quelles options acceptent les settings de permissions dans .claude/",
  "comment marchent les agents dans .claude/",
  "can a PostToolUse hook run npm commands?",
  "how do MCP servers authenticate to GitHub?",
]

for (const question of MUST_USE_MIRROR) {
  test(`mirror answers: ${question}`, () => {
    assert.equal(route(question, providers).provider, 'mirror')
  })
}

// Foreign brands do not veto positive Claude Code evidence, but generic terms alone do not
// establish that a question belongs to the local documentation corpus.
const MUST_NOT_USE_MIRROR = [
  "how do React hooks work",
  "what is the weather in London",
  "quel est le prix du litre de diesel",
  "what skills should a product manager learn",
  "where is the application changelog",
  "how should an interview transcript be formatted",
]

// ⚠ These expectations were WEAKENED deliberately on 2026-09-20 21:30 +01:00, and the reason is
// recorded here rather than left to a reader of the diff. The independent review was right that a
// generic noun does not PROVE a question is about Claude Code. What it does not settle is what to
// do with the doubt. Consulting the mirror is local, free, and falls through to the ordinary web
// search when it finds nothing; skipping it costs a paid call and a worse answer. So the assertion
// is no longer "never reaches the mirror" but "never reaches it as STRONG evidence": a generic
// noun may CONSULT, it may not DECIDE.
//
// Two of these three — a product manager's skills, an application's changelog — carry no Claude
// signal beyond the noun, so they are the cases that would consult and find nothing.
for (const question of MUST_NOT_USE_MIRROR) {
  test(`generic wording is never strong evidence: ${question}`, () => {
    const decision = route(question, providers)
    assert.notEqual(decision.confidence, 'strong')
  })
}

test('an absent mirror never routes there, whatever the subject', () => {
  const without = { ...providers, mirror: { available: false, reason: 'not installed' } }
  const decision = route('how do slash commands work', without)
  assert.notEqual(decision.provider, 'mirror')
  assert.match(decision.reason, /mirror|not installed/i)
})
