import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseAgentFrontmatter } from '../../../scripts/run-typescript-pack-agent.mjs'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const packDir = path.resolve(testDir, '../../../../plugin/packs/python')
const manifestPath = path.join(packDir, 'pack.json')
const lspDeclarationPath = path.join(packDir, '.lsp.json')
const pluginLspDeclarationPath = path.resolve(packDir, '../..', '.lsp.json')
const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
const rulesOnDemandHookPath = path.join(configDir, 'plugins', 'wt-rules-on-demand', 'hooks', 'hooks.js')
const hasRulesOnDemandHook = fs.existsSync(rulesOnDemandHookPath)

function agentFiles() {
  return fs.readdirSync(path.join(packDir, 'agents')).filter((name) => name.endsWith('.md')).sort()
}

describe('Python pack manifest', () => {
  it.skipIf(!hasRulesOnDemandHook)('the private rules-on-demand hook triggers on .py/.pyi edits', () => {
    expect(fs.readFileSync(rulesOnDemandHookPath, 'utf8')).toContain('/\\.(?:py|pyi)$/i.test(editPath(e))')
  })

  it('declares files that exist in the pack', () => {
    expect(fs.existsSync(manifestPath), 'plugin/packs/python/pack.json exists').toBe(true)

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      language: string
      triggers: { extensions: string[] }
      rules: string[]
      skills: string[]
      agents: string[]
    }

    expect(manifest.language).toBe('python')
    expect(new Set(manifest.triggers.extensions)).toEqual(new Set(['.py', '.pyi']))
    for (const name of manifest.rules) expect(fs.existsSync(path.join(packDir, 'rules', name))).toBe(true)
    for (const name of manifest.skills) expect(fs.existsSync(path.join(packDir, 'skills', name, 'SKILL.md'))).toBe(true)
    for (const name of manifest.agents) expect(fs.existsSync(path.join(packDir, 'agents', name))).toBe(true)
    expect([...manifest.agents].sort()).toEqual(agentFiles())
    for (const name of agentFiles()) {
      const { frontmatter } = parseAgentFrontmatter(fs.readFileSync(path.join(packDir, 'agents', name), 'utf8'))
      expect(frontmatter).toMatchObject({ effort: 'high', model: 'sonnet', 'sdk-only': 'true' })
    }
  })

  it('carries the Python diagnostics declaration and root loader bridge', () => {
    expect(fs.existsSync(lspDeclarationPath), 'pack .lsp.json exists').toBe(true)
    expect(fs.existsSync(pluginLspDeclarationPath), 'plugin-root .lsp.json exists').toBe(true)

    const declaration = JSON.parse(fs.readFileSync(lspDeclarationPath, 'utf8'))
    const rootDeclaration = JSON.parse(fs.readFileSync(pluginLspDeclarationPath, 'utf8'))
    expect(declaration).toEqual({
      python: {
        command: 'pyright-langserver',
        args: ['--stdio'],
        extensionToLanguage: { '.py': 'python', '.pyi': 'python' },
        diagnostics: true,
        startupTimeout: 10000,
      },
    })
    expect(rootDeclaration.python).toEqual(declaration.python)
    expect(Object.keys(rootDeclaration).at(0)).toBe('typescript')
  })
})
