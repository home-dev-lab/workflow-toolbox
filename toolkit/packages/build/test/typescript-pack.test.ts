import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { describePackContract } from './helpers/pack-contract.js'
import {
  loadSdk,
  parseAgentFrontmatter,
  parseRunnerArgs,
  requireString,
  serializeRun,
} from '../../../scripts/run-typescript-pack-agent.mjs'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const packDir = path.resolve(testDir, '../../../../plugin/packs/typescript')
// The rules-on-demand hook is a PRIVATE plugin living in the user's config dir, not in this
// repository: resolve it through the config dir (never by a fixed `..` depth, which breaks the
// moment the checkout is nested differently, e.g. under <root>/.claude/worktrees/<name>), and
// skip its assertion visibly when the plugin is absent — a public consumer never has it.

describePackContract({
  pack: 'typescript',
  extensions: ['.ts', '.tsx'],
  consumerRules: ['lint-typecheck-build.md', 'tdd-vitest.md'],
  declaration: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensionToLanguage: { '.ts': 'typescript' },
    diagnostics: true,
    startupTimeout: 10000,
  },
})

describe('TypeScript pack SDK agent runner', () => {
  it('loads the SDK from the toolkit-owned runner rather than the shipped plugin pack', async () => {
    expect(fs.existsSync(path.join(packDir, 'scripts', 'run-agent.mjs'))).toBe(false)
    await expect(loadSdk()).resolves.toHaveProperty('query')
  })

  it('parses required agent frontmatter without loading the SDK', () => {
    expect(
      parseAgentFrontmatter(`---
model: sonnet

effort: high
sdk-only: true
---

System prompt`),
    ).toEqual({
      body: 'System prompt',
      frontmatter: { effort: 'high', model: 'sonnet', 'sdk-only': 'true' },
    })
    expect(() => parseAgentFrontmatter('System prompt')).toThrow('agent definition must start with YAML frontmatter')
    expect(() => parseAgentFrontmatter('---\nmodel: sonnet\nmodel: haiku\n---\nPrompt')).toThrow(
      'duplicate frontmatter field: model',
    )
    expect(() => requireString({}, 'model')).toThrow('agent frontmatter requires model')
  })

  it('requires agent, input, and output arguments', () => {
    expect(parseRunnerArgs(['critic.md', 'plan.md', 'critic.json'])).toEqual({
      agentPath: 'critic.md',
      inputPath: 'plan.md',
      outputPath: 'critic.json',
    })
    expect(() => parseRunnerArgs(['critic.md', 'plan.md'])).toThrow(
      'usage: run-typescript-pack-agent.mjs <agent.md> <input.md> <output.json>',
    )
  })

  it('serializes the transcript and final usage', () => {
    expect(serializeRun('critic.md', 'sonnet', 'high', [{ type: 'system' }, { type: 'result', usage: { total_cost_usd: 1 } }])).toEqual({
      agent: { path: 'critic.md', model: 'sonnet', effort: 'high' },
      transcript: [{ type: 'system' }, { type: 'result', usage: { total_cost_usd: 1 } }],
      usage: { total_cost_usd: 1 },
    })
    expect(() => serializeRun('critic.md', 'sonnet', 'high', [{ type: 'system' }])).toThrow(
      'agent query did not end with a result message',
    )
  })
})
