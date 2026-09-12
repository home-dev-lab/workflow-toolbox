import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  loadSdk,
  parseAgentFrontmatter,
  parseRunnerArgs,
  requireString,
  serializeRun,
} from '../../../scripts/run-typescript-pack-agent.mjs'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const packDir = path.resolve(testDir, '../../../../plugin/packs/typescript')
const manifestPath = path.join(packDir, 'pack.json')
const lspDeclarationPath = path.join(packDir, '.lsp.json')
const pluginLspDeclarationPath = path.resolve(packDir, '../..', '.lsp.json')
// The rules-on-demand hook is a PRIVATE plugin living in the user's config dir, not in this
// repository: resolve it through the config dir (never by a fixed `..` depth, which breaks the
// moment the checkout is nested differently, e.g. under <root>/.claude/worktrees/<name>), and
// skip its assertion visibly when the plugin is absent — a public consumer never has it.
const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
const rulesOnDemandHookPath = path.join(configDir, 'plugins', 'wt-rules-on-demand', 'hooks', 'hooks.js')
const hasRulesOnDemandHook = fs.existsSync(rulesOnDemandHookPath)

function agentFiles() {
  return fs.readdirSync(path.join(packDir, 'agents')).filter((name) => name.endsWith('.md')).sort()
}

describe('TypeScript pack manifest', () => {
  it.skipIf(!hasRulesOnDemandHook)('the private rules-on-demand hook triggers on .ts/.tsx edits', () => {
    expect(fs.readFileSync(rulesOnDemandHookPath, 'utf8')).toContain('/\\.(?:ts|tsx)$/i.test(editPath(e))')
  })

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
    for (const name of manifest.rules) expect(fs.existsSync(path.join(packDir, 'rules', name))).toBe(true)
    for (const name of manifest.skills) expect(fs.existsSync(path.join(packDir, 'skills', name, 'SKILL.md'))).toBe(true)
    for (const name of manifest.agents) expect(fs.existsSync(path.join(packDir, 'agents', name))).toBe(true)
    expect([...manifest.agents].sort()).toEqual(agentFiles())
    for (const name of agentFiles()) {
      const { frontmatter } = parseAgentFrontmatter(fs.readFileSync(path.join(packDir, 'agents', name), 'utf8'))
      expect(frontmatter).toMatchObject({ effort: 'high', model: 'sonnet', 'sdk-only': 'true' })
    }
  })

  it('carries the TypeScript diagnostics declaration and root loader bridge', () => {
    expect(fs.existsSync(lspDeclarationPath), 'pack .lsp.json exists').toBe(true)
    expect(fs.existsSync(pluginLspDeclarationPath), 'plugin-root .lsp.json exists').toBe(true)

    const declaration = JSON.parse(fs.readFileSync(lspDeclarationPath, 'utf8'))
    expect(declaration).toEqual({
      typescript: {
        command: 'typescript-language-server',
        args: ['--stdio'],
        extensionToLanguage: { '.ts': 'typescript' },
        diagnostics: true,
        startupTimeout: 10000,
      },
    })
    expect(JSON.parse(fs.readFileSync(pluginLspDeclarationPath, 'utf8')).typescript).toEqual(declaration.typescript)
  })
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
