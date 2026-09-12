import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseAgentFrontmatter } from '../../../../scripts/run-typescript-pack-agent.mjs'
import { rulesOnDemandHookPath as locateRulesOnDemandHook } from './pack-consumer.js'

/**
 * The pack contract every language pack must satisfy (`docs/public/language-packs.md`), asserted
 * once here and instantiated per pack: the manifest names assets that exist, every agent is
 * SDK-only with the pinned frontmatter, the pack's `.lsp.json` is exactly the expected declaration,
 * the generated root carries the identical entry with `typescript` first, and — where the private
 * rules-on-demand consumer can be located — its trigger for this pack is registered. Each pack's
 * own test adds only what is specific to it (a Groovy exclusion, the SDK runner, …).
 */
export interface PackContract {
  pack: string
  extensions: string[]
  /** Exact file names the consumer must also trigger on (build files without a distinctive extension). */
  files?: string[]
  /** The literal regex expression the private consumer must contain for this pack, if it owns one. */
  consumerTrigger?: string
  declaration: Record<string, unknown>
}

const testDir = path.dirname(fileURLToPath(import.meta.url))

export function packPaths(pack: string) {
  const packDir = path.resolve(testDir, '../../../../../plugin/packs', pack)
  return {
    packDir,
    manifestPath: path.join(packDir, 'pack.json'),
    lspDeclarationPath: path.join(packDir, '.lsp.json'),
    pluginLspDeclarationPath: path.resolve(packDir, '../..', '.lsp.json'),
    repoRoot: path.resolve(packDir, '../../..'),
  }
}

export function describePackContract(contract: PackContract) {
  const { pack, extensions, files, consumerTrigger, declaration } = contract
  const { packDir, manifestPath, lspDeclarationPath, pluginLspDeclarationPath, repoRoot } = packPaths(pack)
  const rulesOnDemandHookPath = locateRulesOnDemandHook(repoRoot)
  const agentFiles = () => fs.readdirSync(path.join(packDir, 'agents')).filter((name) => name.endsWith('.md')).sort()

  describe(`${pack} pack contract`, () => {
    it.skipIf(rulesOnDemandHookPath === undefined || consumerTrigger === undefined)(`the private rules-on-demand hook triggers on ${extensions.join('/')} edits`, () => {
      expect(fs.readFileSync(rulesOnDemandHookPath!, 'utf8')).toContain(consumerTrigger)
    })

    it('declares files that exist in the pack, and SDK-only agents with the pinned frontmatter', () => {
      expect(fs.existsSync(manifestPath), `plugin/packs/${pack}/pack.json exists`).toBe(true)
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        language: string
        triggers: { extensions: string[]; files?: string[] }
        rules: string[]
        skills: string[]
        agents: string[]
      }
      expect(manifest.language).toBe(pack)
      expect(new Set(manifest.triggers.extensions)).toEqual(new Set(extensions))
      if (files) expect(new Set(manifest.triggers.files)).toEqual(new Set(files))
      else expect(manifest.triggers).not.toHaveProperty('files')
      for (const name of manifest.rules) expect(fs.existsSync(path.join(packDir, 'rules', name)), `rule ${name}`).toBe(true)
      for (const name of manifest.skills) expect(fs.existsSync(path.join(packDir, 'skills', name, 'SKILL.md')), `skill ${name}`).toBe(true)
      for (const name of manifest.agents) expect(fs.existsSync(path.join(packDir, 'agents', name)), `agent ${name}`).toBe(true)
      expect([...manifest.agents].sort()).toEqual(agentFiles())
      for (const name of agentFiles()) {
        const { frontmatter } = parseAgentFrontmatter(fs.readFileSync(path.join(packDir, 'agents', name), 'utf8'))
        expect(frontmatter, name).toMatchObject({ effort: 'high', model: 'sonnet', 'sdk-only': 'true' })
      }
    })

    it('carries exactly the expected diagnostics declaration, mirrored in the generated root after typescript', () => {
      expect(fs.existsSync(lspDeclarationPath), 'pack .lsp.json exists').toBe(true)
      expect(fs.existsSync(pluginLspDeclarationPath), 'plugin-root .lsp.json exists').toBe(true)
      const packDeclaration = JSON.parse(fs.readFileSync(lspDeclarationPath, 'utf8'))
      expect(packDeclaration).toEqual({ [pack]: declaration })
      const root = JSON.parse(fs.readFileSync(pluginLspDeclarationPath, 'utf8'))
      expect(Object.keys(root).at(0)).toBe('typescript')
      expect(root[pack]).toEqual(declaration)
    })

    it('ships the probe fixture the documented probe command reads', () => {
      const probeDir = path.join(packDir, 'probe')
      expect(fs.readFileSync(path.join(probeDir, 'expected-diagnostic.txt'), 'utf8').trim().length).toBeGreaterThan(0)
      const sources = fs.readdirSync(probeDir).filter((name) => !['expected-diagnostic.txt', 'workspace-modules.txt', 'nav'].includes(name))
      expect(sources, 'exactly one planted-error source file').toHaveLength(1)
      expect(fs.existsSync(path.join(probeDir, 'nav', 'expected-navigation.json')), 'navigation fixture manifest').toBe(true)
    })
  })
}
