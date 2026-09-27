import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
// @ts-expect-error runtime JS modules
import { resolveAgentDefinition } from '../../../../plugin/bin/lib/agent-definitions.mjs'
// @ts-expect-error runtime JS modules
import { parseFrontmatter } from '../../../../plugin/bin/lib/frontmatter.mjs'
// @ts-expect-error runtime JS modules
import { createBudget, walkFiles } from '../../../../plugin/bin/lib/bounded-walk.mjs'
// @ts-expect-error runtime JS modules
import { boundedJson } from '../../../../plugin/bin/lib/host/bounded-json.mjs'
// @ts-expect-error runtime JS modules
import { agentHasNoMessagingTool } from '../../../../plugin/bin/lib/subagent-delivery-shape.mjs'
// @ts-expect-error runtime JS modules
import { skillIsUnlistedByInit } from '../../../../plugin/bin/lib/sdk-role-profile.mjs'

function fixture(run: (root: string, write: (file: string, text: string) => void) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-frontmatter-r4-'))
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
  try { run(root, write) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
const agent = (name: string, tools = 'Write') => `---\nname: ${name}\ndescription: worker\ntools: [${tools}]\n---\n`
const options = (root: string, env = {}) => ({ cwd: root, configDir: path.join(root, 'config'), pluginRoot: path.join(root, 'unused'), env })

it('A1 uses manifest namespace for scoped and bare discovery; unreadable manifest is uncertain', () => fixture((root, write) => {
  const install = path.join(root, 'install')
  write(path.join(root, 'config/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'catalog-name@m': [{ installPath: install }] } }))
  write(path.join(root, 'config/plugins/marketplaces/m/.claude-plugin/marketplace.json'), JSON.stringify({ plugins: [{ name: 'catalog-name' }] }))
  write(path.join(install, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'runtime-name' }))
  write(path.join(install, 'agents/pilot.md'), agent('pilot'))
  expect(resolveAgentDefinition('runtime-name:pilot', options(root))).toMatchObject({ data: { tools: ['Write'] } })
  expect(resolveAgentDefinition('pilot', options(root))).toMatchObject({ data: { tools: ['Write'] } })
  fs.writeFileSync(path.join(install, '.claude-plugin/plugin.json'), '{broken')
  expect(resolveAgentDefinition('runtime-name:pilot', options(root))).toMatchObject({ unresolved: expect.any(String) })
  write(path.join(root, 'config/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'catalog-name@m': [{ installPath: '' }] } }))
  expect(resolveAgentDefinition('runtime-name:pilot', options(root))).toMatchObject({ unresolved: expect.any(String) })
}))

it('A2 honors known marketplace installLocation and extra cache registries; unknown metadata is unresolved', () => fixture((root, write) => {
  const install = path.join(root, 'install'), market = path.join(root, 'market'), cache = path.join(root, 'cache')
  write(path.join(cache, 'installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: install }] } }))
  write(path.join(cache, 'known_marketplaces.json'), JSON.stringify({ m: { installLocation: market } }))
  write(path.join(market, '.claude-plugin/marketplace.json'), JSON.stringify({ plugins: [{ name: 'p', agents: ['./custom/pilot.md'] }] }))
  write(path.join(install, 'agents/pilot.md'), agent('pilot', 'Read'))
  write(path.join(install, 'custom/pilot.md'), agent('pilot', 'Write'))
  const opts = options(root, { CLAUDE_CODE_PLUGIN_CACHE_DIR: cache })
  expect(resolveAgentDefinition('p:pilot', opts)).toMatchObject({ data: { tools: ['Write'] } })
  fs.rmSync(path.join(market, '.claude-plugin/marketplace.json'))
  expect(resolveAgentDefinition('p:pilot', opts)).toMatchObject({ unresolved: expect.any(String) })
}))

it('A2 accepts a file marketplace installLocation and flags conflicting cache installations', () => fixture((root, write) => {
  const install = path.join(root, 'install'), other = path.join(root, 'other'), cache = path.join(root, 'cache')
  const listing = path.join(root, 'local-marketplace.json')
  write(path.join(root, 'config/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: install }] } }))
  write(path.join(root, 'config/plugins/known_marketplaces.json'), JSON.stringify({ m: { installLocation: listing } }))
  write(listing, JSON.stringify({ plugins: [{ name: 'p', agents: ['./custom/pilot.md'] }] }))
  write(path.join(install, 'custom/pilot.md'), agent('pilot', 'Write'))
  const opts = options(root, { CLAUDE_CODE_PLUGIN_CACHE_DIR: cache })
  expect(resolveAgentDefinition('p:pilot', opts)).toMatchObject({ data: { tools: ['Write'] } })
  write(path.join(cache, 'installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: other }] } }))
  write(path.join(other, 'custom/pilot.md'), agent('pilot', 'Read'))
  expect(resolveAgentDefinition('p:pilot', opts)).toMatchObject({ unresolved: expect.any(String) })
}))

it('A3 accepts double dots within identifiers', () => fixture((root, write) => {
  write(path.join(root, '.claude/agents/different.md'), agent('pilot..review'))
  expect(resolveAgentDefinition('pilot..review', options(root))).toMatchObject({ data: { name: 'pilot..review' } })
  const install = path.join(root, 'install')
  write(path.join(root, 'config/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: install }] } }))
  write(path.join(root, 'config/plugins/marketplaces/m/.claude-plugin/marketplace.json'), JSON.stringify({ plugins: [{ name: 'p' }] }))
  write(path.join(install, 'agents/review..security.md'), agent('review..security'))
  expect(resolveAgentDefinition('p:review..security', options(root))).toMatchObject({ data: { name: 'review..security' } })
  expect(agentHasNoMessagingTool('pilot..review', root)).toBe(true)
}))

it.each(['@reserved: value', '`reserved: value', '%reserved: value', '- Read: Write', '? Read: Write', 'value\0: word'])('A4 rejects invalid colon-extension value %s', (value) => {
  expect(parseFrontmatter(`---\ndescription: ${value}\n---\n`).ok).toBe(false)
})

it('A5 does not call an oversized opening fence absent', () => {
  const text = `---${' '.repeat(254)}\nname: x\nuser-invocable: false\n---\n`
  expect(parseFrontmatter(text).reason).toBe('oversized')
  expect(skillIsUnlistedByInit(text)).toBe(true)
})

it('A6 charges and deduplicates explicit file roots', () => fixture((root, write) => {
  const files = Array.from({ length: 10 }, (_, i) => path.join(root, `${i}.md`))
  for (const file of files) write(file, agent('pilot'))
  const limited = walkFiles(files, { budget: createBudget({ maxEntries: 1 }) })
  expect(limited.exhausted).toBe('entries')
  expect(limited.files).toHaveLength(1)
  const repeated = walkFiles([files[0]!, files[0]!], { budget: createBudget({ maxEntries: 1 }) })
  expect(repeated.files).toHaveLength(1)
  expect(repeated.exhausted).toBeNull()
}))

it('A6 charges directory roots to the entry budget', () => fixture((root) => {
  const dirA = path.join(root, 'dir-a'), dirB = path.join(root, 'dir-b')
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })
  const limited = walkFiles([dirA, dirB], { budget: createBudget({ maxEntries: 1, maxDirs: 10 }) })
  expect(limited.exhausted).toBe('entries')
}))

it('A7 compares cyclic aliases in the corpus CLI', () => fixture((root, write) => {
  write(path.join(root, 'agent.md'), '---\nmetadata: &a {x: *a}\n---\n')
  const script = path.resolve(import.meta.dirname, '../../../scripts/frontmatter-corpus-diff.mjs')
  const output = execFileSync('node', [script, '--examples', '0', root], { encoding: 'utf8' })
  expect(JSON.parse(output.split('\n')[0]!)).toMatchObject({ agree: 1, mismatch: 0 })
}))

it('A4 corpus independently classifies invalid indicators rather than counting extensions', () => fixture((root, write) => {
  write(path.join(root, 'agent.md'), '---\ndescription: @reserved: value\n---\n')
  const script = path.resolve(import.meta.dirname, '../../../scripts/frontmatter-corpus-diff.mjs')
  const output = execFileSync('node', [script, '--examples', '0', root], { encoding: 'utf8' })
  expect(JSON.parse(output.split('\n')[0]!)).toMatchObject({ bothReject: 1, extension: 0, readerOkYamlReject: 0 })
}))

it('A9 bounds JSON reads to the remaining allowance when a file grows', () => fixture((root, write) => {
  const file = path.join(root, 'registry.json')
  write(file, '{}'.repeat(100))
  const original = fs.fstatSync
  const reads: number[] = []
  const injected = { ...fs, fstatSync: (fd: number) => ({ ...original(fd), isFile: () => true, size: 0 }), readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => { reads.push(length); return fs.readSync(fd, buffer, offset, length, position) } }
  const budget = createBudget({ maxBytes: 1 })
  expect(() => boundedJson(file, budget, injected)).toThrow()
  expect(reads).toEqual([2])
  expect(budget.exhausted).toBe('bytes')
}))

it('A11 exempts only the byte-identity-checked vendor artifact from lint', () => {
  const config = fs.readFileSync(path.resolve(import.meta.dirname, '../../../eslint.config.mjs'), 'utf8')
  expect(config).toContain("'plugin/bin/lib/vendor/yaml.mjs'")
  expect(config).not.toContain("'plugin/bin/lib/vendor/**'")
  expect(config).not.toContain("'../plugin/bin/lib/vendor/**'")
})
