import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { describePackContract } from './helpers/pack-contract.js'
import {
  loadSdk,
  main,
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
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/bin/wt-tsls.mjs'],
    extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact', '.mts': 'typescript', '.cts': 'typescript', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript' },
    diagnostics: true,
    startupTimeout: 10000,
  },
})

async function hooksDisabledOptionsCase() {
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'typescript-pack-hooks-'))
  const previous = process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
  try {
    const agent = path.join(scratch, 'agent.md')
    const input = path.join(scratch, 'input.md')
    const output = path.join(scratch, 'nested', 'output.json')
    fs.writeFileSync(agent, '---\nmodel: sonnet\neffort: high\nsdk-only: true\n---\nSystem prompt')
    fs.writeFileSync(input, 'Review this input')
    const transcript = [{ type: 'system' }, { type: 'result', usage: { input_tokens: 3 } }]
    await main([agent, input, output], async function* (parameters) {
      expect(parameters).toEqual({
        prompt: 'Review this input',
        options: {
          cwd: process.cwd(), effort: 'high', model: 'sonnet', settingSources: [],
          settings: { disableAllHooks: true }, systemPrompt: 'System prompt', tools: [],
        },
      })
      yield* transcript
    })
    expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual({
      agent: { path: agent, model: 'sonnet', effort: 'high' }, transcript, usage: { input_tokens: 3 },
    })
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
    else process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = previous
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

async function inheritedSwitchCase() {
  const scratch = fs.mkdtempSync(path.join(tmpdir(), 'typescript-pack-switch-'))
  const previous = process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
  try {
    const agent = path.join(scratch, 'agent.md')
    const input = path.join(scratch, 'input.md')
    fs.writeFileSync(agent, '---\nmodel: sonnet\neffort: high\nsdk-only: true\n---\nSystem prompt')
    fs.writeFileSync(input, 'Review this input')
    process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = '1'
    let seen: string | undefined = 'not called'
    await main([agent, input, path.join(scratch, 'output.json')], async function* () {
      seen = process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
      yield { type: 'result' }
    })
    expect(seen).toBeUndefined()
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS
    else process.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS = previous
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

describe('TypeScript pack SDK agent runner hook isolation', () => {
  it('disables hooks explicitly while preserving isolated query options and the transcript', hooksDisabledOptionsCase)
  it('keeps an inherited function-hooks switch away from an older bundled CLI', inheritedSwitchCase)
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
