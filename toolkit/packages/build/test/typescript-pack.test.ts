import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseAgentFrontmatter,
  parseRunnerArgs,
  requireString,
  serializeRun,
} from '../../../../plugin/packs/typescript/scripts/run-agent.mjs'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const packDir = path.resolve(testDir, '../../../../plugin/packs/typescript')
const manifestPath = path.join(packDir, 'pack.json')
const rulesOnDemandHookPath = path.resolve(
  testDir,
  '../../../../../../.claude/plugins/wt-rules-on-demand/hooks/hooks.js',
)

function agentFiles() {
  return fs.readdirSync(path.join(packDir, 'agents')).filter((name) => name.endsWith('.md')).sort()
}

describe('TypeScript pack manifest', () => {
  it('declares files that exist in the pack', () => {
    expect(fs.existsSync(manifestPath), 'plugin/packs/typescript/pack.json exists').toBe(true)

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      language: string
      triggers: { extensions: string[] }
      rules: string[]
      skills: string[]
      agents: string[]
    }

    expect(manifest.language).toBe('typescript')
    expect(new Set(manifest.triggers.extensions)).toEqual(new Set(['.ts', '.tsx']))
    expect(fs.readFileSync(rulesOnDemandHookPath, 'utf8')).toContain('/\\.(?:ts|tsx)$/i.test(editPath(e))')
    for (const name of manifest.rules) expect(fs.existsSync(path.join(packDir, 'rules', name))).toBe(true)
    for (const name of manifest.skills) expect(fs.existsSync(path.join(packDir, 'skills', name, 'SKILL.md'))).toBe(true)
    for (const name of manifest.agents) expect(fs.existsSync(path.join(packDir, 'agents', name))).toBe(true)
    expect([...manifest.agents].sort()).toEqual(agentFiles())
    for (const name of agentFiles()) {
      const { frontmatter } = parseAgentFrontmatter(fs.readFileSync(path.join(packDir, 'agents', name), 'utf8'))
      expect(frontmatter).toMatchObject({ effort: 'high', model: 'sonnet', 'sdk-only': 'true' })
    }
  })
})

describe('TypeScript pack SDK agent runner', () => {
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
      'usage: run-agent.mjs <agent.md> <input.md> <output.json>',
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
