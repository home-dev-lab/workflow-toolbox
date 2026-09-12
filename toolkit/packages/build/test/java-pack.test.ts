import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseAgentFrontmatter } from '../../../scripts/run-typescript-pack-agent.mjs'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const packDir = path.resolve(testDir, '../../../../plugin/packs/java')
const manifestPath = path.join(packDir, 'pack.json')
const lspDeclarationPath = path.join(packDir, '.lsp.json')
const pluginLspDeclarationPath = path.resolve(packDir, '../..', '.lsp.json')
const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
const rulesOnDemandHookPath = path.join(configDir, 'plugins', 'wt-rules-on-demand', 'hooks', 'hooks.js')
const hasRulesOnDemandHook = fs.existsSync(rulesOnDemandHookPath)

function agentFiles() {
  return fs.readdirSync(path.join(packDir, 'agents')).filter((name) => name.endsWith('.md')).sort()
}

describe('Java pack manifest', () => {
  it.skipIf(!hasRulesOnDemandHook)('the private rules-on-demand hook triggers on Java and Groovy edits', () => {
    expect(fs.readFileSync(rulesOnDemandHookPath, 'utf8')).toContain('/\\.(?:java|groovy|gradle)$/i.test(editPath(e))')
  })

  it('declares files that exist in the pack', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      language: string
      triggers: { extensions: string[]; files: string[] }
      rules: string[]
      skills: string[]
      agents: string[]
    }
    expect(manifest.language).toBe('java')
    expect(new Set(manifest.triggers.extensions)).toEqual(new Set(['.java', '.groovy', '.gradle']))
    expect(new Set(manifest.triggers.files)).toEqual(new Set(['pom.xml', 'build.gradle', 'build.gradle.kts']))
    for (const name of manifest.rules) expect(fs.existsSync(path.join(packDir, 'rules', name))).toBe(true)
    for (const name of manifest.skills) expect(fs.existsSync(path.join(packDir, 'skills', name, 'SKILL.md'))).toBe(true)
    for (const name of manifest.agents) expect(fs.existsSync(path.join(packDir, 'agents', name))).toBe(true)
    expect([...manifest.agents].sort()).toEqual(agentFiles())
    for (const name of agentFiles()) {
      expect(parseAgentFrontmatter(fs.readFileSync(path.join(packDir, 'agents', name), 'utf8')).frontmatter).toMatchObject({
        effort: 'high', model: 'sonnet', 'sdk-only': 'true',
      })
    }
  })

  it('carries the measured Java declaration and root loader bridge', () => {
    const declaration = JSON.parse(fs.readFileSync(lspDeclarationPath, 'utf8'))
    expect(declaration).toEqual({ java: { command: 'jdtls', args: [], extensionToLanguage: { '.java': 'java' }, diagnostics: true, startupTimeout: 23000 } })
    expect(declaration).not.toHaveProperty('groovy')
    const root = JSON.parse(fs.readFileSync(pluginLspDeclarationPath, 'utf8'))
    expect(Object.keys(root)[0]).toBe('typescript')
    expect(root.java).toEqual(declaration.java)
    expect(root).not.toHaveProperty('groovy')
  })
})
