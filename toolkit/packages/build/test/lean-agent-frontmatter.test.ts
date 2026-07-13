// lean-agent-frontmatter.test.ts — shape gate over plugin/agents/lean.md.
//
// The whole point of the `lean` agentType (card #1817685484130797560) is to
// strip the ambient tool/skill/MCP injection a default subagent otherwise pays
// for on every spawn — that only holds if its `tools:` allowlist stays EMPTY.
// A future edit that quietly adds a tool (or drops the SendMessage denial,
// losing parity with the `leaf` fence's no-messaging guarantee) would silently
// undo the whole point of the card without any other gate catching it — this
// is a plain string check, not a YAML parse, so it fails loudly on the exact
// regression that matters and nothing else.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const LEAN_AGENT_PATH = join(REPO_ROOT, 'plugin/agents/lean.md')

describe('plugin/agents/lean.md — minimal-ambient-context shape', () => {
  const content = readFileSync(LEAN_AGENT_PATH, 'utf8')
  const frontmatter = content.slice(0, content.indexOf('\n---', 4))

  it('declares the lean name', () => {
    expect(frontmatter).toMatch(/^name: lean$/m)
  })

  it('has an EMPTY tools allowlist — the empty-allowlist fence this whole card exists for', () => {
    // Deliberately a literal string match, not a YAML parse: what must never
    // silently regress is this EXACT empty-list shape, not "some tools field
    // is present". `tools: []` (an empty flow sequence) is the standard,
    // unambiguous way to express "explicitly zero tools" — as opposed to
    // OMITTING the key, which Claude Code's docs define as "inherits all
    // tools" (the opposite of what lean needs).
    expect(frontmatter).toMatch(/^tools: \[\]$/m)
  })

  it('also denies SendMessage explicitly — belt-and-braces parity with the leaf fence', () => {
    // Redundant with an empty tools allowlist (SendMessage cannot be in an
    // empty allowlist either way), but explicit and defense-in-depth: if the
    // empty-list interpretation ever turns out NOT to mean "zero tools" on
    // some future Claude Code version, this line alone still guarantees no
    // SendMessage regression, matching `leaf.md`'s own guarantee.
    expect(frontmatter).toMatch(/^disallowedTools: SendMessage$/m)
  })
})
