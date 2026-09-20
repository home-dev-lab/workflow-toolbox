import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import test from 'node:test'

import { bestPages, register } from '../hooks/hooks.js'

const mirrorPath = `${homedir()}/.claude-code-docs`
const $ = { fs: { read: (path) => readFile(path, 'utf8') } }

// Each expected page and title comes from the real mirror manifest. The reason records why a
// reader would choose it; these authored judgments await arbiter review at integration.
const fixtures = [
  {
    query: 'Search the web for what a PostToolUse hook receives on stdin in Claude Code, then summarise what you found',
    expected: 'hooks.md',
    reason: 'Hooks reference documents event input schemas and command-hook stdin.',
  },
  {
    query: 'how do I register a PostToolUse hook',
    expected: 'hooks-guide.md',
    reason: 'Automate actions with hooks is the setup guide for registering hooks.',
  },
  {
    query: 'How does Claude Code remember project instructions in CLAUDE.md?',
    expected: 'memory.md',
    reason: 'How Claude remembers your project explains CLAUDE.md and auto memory.',
  },
  {
    query: 'Comment connecter Claude Code a un serveur MCP externe ?',
    expected: 'mcp.md',
    reason: 'Connect to external tools with MCP is the full MCP connection reference.',
  },
  {
    query: 'Ou configurer les permissions fines dans Claude Code ?',
    expected: 'permissions.md',
    reason: 'Configure permissions defines fine-grained permission rules and modes.',
  },
  {
    query: 'How do I create a custom subagent in Claude Code?',
    expected: 'sub-agents.md',
    reason: 'Create custom subagents is the dedicated custom-subagent guide.',
  },
  {
    query: 'Comment etendre un agent Claude Code avec des skills ?',
    expected: 'skills.md',
    reason: 'Extend agents with skills documents Agent SDK skills.',
  },
  {
    query: 'How can I discover and install Claude Code plugins from a marketplace?',
    expected: 'discover-plugins.md',
    reason: 'Discover and install prebuilt plugins through marketplaces covers that workflow.',
  },
  {
    query: 'Comment configurer le Bash sandbox de Claude Code ?',
    expected: 'sandboxing.md',
    reason: 'Configure the sandboxed Bash tool is the sandbox configuration guide.',
  },
  {
    query: 'How do I customize the Claude Code status line?',
    expected: 'statusline.md',
    reason: 'Customize your status line is the dedicated status-line page.',
  },
  {
    query: 'Ou trouver les options CLI et le print mode de Claude Code ?',
    expected: 'cli-reference.md',
    reason: 'CLI reference lists command-line flags and print mode.',
  },
  {
    query: 'How do I use Claude Code inside VS Code?',
    expected: 'vs-code.md',
    reason: 'Use Claude Code in VS Code documents the editor integration.',
  },
  {
    query: 'Comment utiliser Claude Code avec Amazon Bedrock ?',
    expected: 'amazon-bedrock.md',
    reason: 'Claude Code on Amazon Bedrock is the provider-specific setup page.',
  },
  {
    query: 'How can I manage Claude Code API costs effectively?',
    expected: 'costs.md',
    reason: 'Manage costs effectively covers cost tracking and reduction.',
  },
]

test('real bilingual questions rank the reader-selected page first or second', async (t) => {
  let hits = 0
  for (const fixture of fixtures) {
    await t.test(`${fixture.expected}: ${fixture.reason}`, async () => {
      const pages = await bestPages($, mirrorPath, fixture.query)
      const rank = pages.findIndex(({ name }) => name === fixture.expected)
      if (rank >= 0 && rank < 2) hits += 1
      assert.ok(rank >= 0 && rank < 2, `${fixture.expected} ranked ${rank < 0 ? 'outside the results' : rank + 1}; got ${pages.map(({ name }) => name).join(', ')}`)
    })
  }
  console.log(`mirror scorer fixture: ${hits}/${fixtures.length} expected pages ranked first or second`)
  assert.ok(hits > fixtures.length / 2, `${hits}/${fixtures.length} is not a majority`)
})

test('a Claude Code question with no relevant mirror page returns nothing', async () => {
  assert.deepEqual(await bestPages($, mirrorPath, 'What is Claude Code\'s favorite color?'), [])
})

test('the hook falls through when the mirror has no relevant page', async () => {
  let handler
  register((_event, _filter, callback) => { handler = callback })
  const engine = {
    env: { get: async (name) => name === 'HOME' ? homedir() : undefined },
    fs: {
      exists: async () => true,
      read: (path) => readFile(path, 'utf8'),
    },
  }
  const event = { query: 'What is Claude Code\'s favorite color?' }
  const result = await handler(engine, event, (forwarded) => ({ forwarded }))
  assert.deepEqual(result, { forwarded: event })
})
