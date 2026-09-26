import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  /**
   * The rule names the private rules-on-demand consumer serves on an `Edit`/`Write` of this pack's files, if it
   * owns this pack. Asserted by BEHAVIOUR (the hook's registered edit handler is driven with a fake host), never
   * by matching its source text: a refactor of the trigger code must not break the contract, only a lost trigger.
   */
  consumerRules?: string[]
  declaration: Record<string, unknown>
}

const testDir = path.dirname(fileURLToPath(import.meta.url))

interface ConsumerResult {
  context?: string[]
  deny?: string
}
type ConsumerHook = ($: unknown, event: Record<string, unknown>, next: () => Promise<ConsumerResult>) => Promise<ConsumerResult>
interface ConsumerModule {
  register: (on: (event: string, matcher: unknown, hook?: ConsumerHook) => void, options?: Record<string, unknown>) => void
  resetForSelftest?: () => void
}

/**
 * Drives the consumer's `tool.call` handler for an edit tool on `filePath`, in a freshly reset hook state, and
 * returns the rule names attached to the call (ride-along context, or a refusal's text). Uses the same fake-host
 * shape as the consumer's own selftest; the consumer's options are its defaults (embedded rules, served once).
 */
async function rulesServedOnEdit(hookPath: string, tool: 'Edit' | 'Write', filePath: string): Promise<string[]> {
  const module = (await import(pathToFileURL(hookPath).href)) as ConsumerModule
  module.resetForSelftest?.()
  const hooks: { event: string; matcher: unknown; hook: ConsumerHook }[] = []
  module.register((event, matcher, hook) => {
    hooks.push(hook ? { event, matcher, hook } : { event, matcher: undefined, hook: matcher as ConsumerHook })
  })
  const matches = (matcher: unknown) => {
    const wanted = (matcher as { tool?: unknown } | undefined)?.tool
    return wanted === tool || (wanted instanceof RegExp && wanted.test(tool))
  }
  const handler = hooks.find((entry) => entry.event === 'tool.call' && matches(entry.matcher)) ?? hooks.find((entry) => entry.event === 'tool.call' && entry.matcher === undefined)
  expect(handler, `the consumer registers a tool.call handler reaching ${tool}`).toBeDefined()
  const store = new Map<string, unknown>()
  const host = {
    ui: { log: async () => {} },
    env: { get: async (name: string) => process.env[name], set: async () => {} },
    store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
    session: { id: async () => 'pack-contract', messages: async () => [] },
    fs: { list: async () => [], read: async () => '', write: async () => {} },
    model: { classify: async () => 'followed' },
  }
  const result = await handler!.hook(host, { tool, path: filePath, input: { file_path: filePath } }, async () => ({ context: [] }))
  const text = [...(result.context ?? []), result.deny ?? ''].join('\n')
  return [...text.matchAll(/<rule name="([^"]+)">/g)].map((match) => match[1]!).sort()
}

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
  const { pack, extensions, files, consumerRules, declaration } = contract
  const { packDir, manifestPath, lspDeclarationPath, pluginLspDeclarationPath, repoRoot } = packPaths(pack)
  const rulesOnDemandHookPath = locateRulesOnDemandHook(repoRoot)
  const agentFiles = () => fs.readdirSync(path.join(packDir, 'agents')).filter((name) => name.endsWith('.md')).sort()

  describe(`${pack} pack contract`, () => {
    it.skipIf(rulesOnDemandHookPath === undefined || consumerRules === undefined)(`the private rules-on-demand hook triggers on ${extensions.join('/')} edits`, async () => {
      const expected = [...consumerRules!].sort()
      // The consumer's pack rules include the pack's own TDD rule, so the pair cannot drift apart unnoticed.
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { rules: string[] }
      expect(expected.filter((name) => manifest.rules.includes(name)), 'the consumer serves at least one of the pack rules').not.toHaveLength(0)
      const targets = [...extensions.map((extension) => `src/sample${extension}`), ...(files ?? []).map((name) => `module/${name}`)]
      for (const target of targets) {
        for (const tool of ['Edit', 'Write'] as const) {
          expect(await rulesServedOnEdit(rulesOnDemandHookPath!, tool, target), `${tool} ${target}`).toEqual(expected)
        }
      }
      // Control readable in both outcomes: a non-pack edit through the same handler serves none of them.
      const unrelated = await rulesServedOnEdit(rulesOnDemandHookPath!, 'Edit', 'docs/notes.md')
      expect(unrelated.filter((name) => expected.includes(name)), 'Edit docs/notes.md').toEqual([])
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
      const sources = fs.readdirSync(probeDir).filter((name) => !['expected-diagnostic.txt', 'workspace-modules.txt', 'tsconfig.json', 'nav'].includes(name))
      expect(sources, 'exactly one planted-error source file').toHaveLength(1)
      expect(fs.existsSync(path.join(probeDir, 'nav', 'expected-navigation.json')), 'navigation fixture manifest').toBe(true)
    })
  })
}
