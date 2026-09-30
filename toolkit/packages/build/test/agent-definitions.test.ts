import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { resolveAgentDefinition } from '../../../../plugin/bin/lib/agent-definitions.mjs'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { createBudget } from '../../../../plugin/bin/lib/bounded-walk.mjs'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { resolveAgentTypeTools } from '../../../../plugin/bin/lib/agent-type-tools.mjs'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { parseFrontmatter } from '../../../../plugin/bin/lib/frontmatter.mjs'

function withWalkFixture(run: (root: string, opts: object, unrelated: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-agent-walk-'))
  const configDir = path.join(root, 'config')
  const agents = path.join(root, '.claude', 'agents')
  const unrelated = path.join(configDir, 'agents', 'different.md')
  try {
    fs.mkdirSync(agents, { recursive: true })
    fs.mkdirSync(path.dirname(unrelated), { recursive: true })
    fs.writeFileSync(path.join(agents, 'pilot.md'), '---\nname: pilot\ndescription: worker\nobserver: watchdog\n---\n')
    // If read, this user-scope child makes even the project winner ineligible.
    fs.writeFileSync(unrelated, '---\nname: pilot\n---\n')
    run(root, { cwd: root, configDir, env: {}, pluginRoot: path.join(root, 'unused') }, unrelated)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

describe('agent definitions', () => {
  it('keeps the project winner when a child vanishes in an unrelated root', () => withWalkFixture((_root, opts, unrelated) => {
    expect(resolveAgentDefinition('pilot', opts)).toMatchObject({ unresolved: expect.stringContaining('ineligible') })
    const vanished: string[] = []
    const walkFs = { ...fs, lstatSync: (file: string) => {
      if (file === unrelated && !vanished.length) { vanished.push(file); fs.unlinkSync(file) }
      return fs.lstatSync(file)
    } }
    const result = resolveAgentDefinition('pilot', { ...opts, walkFs })
    expect(vanished).toEqual([unrelated])
    expect(fs.existsSync(unrelated)).toBe(false)
    expect(result).toMatchObject({ scope: 'project', identity: 'pilot', data: { observer: 'watchdog' } })
  }))

  it('stays unresolved when a child is renamed in an unrelated root', () => withWalkFixture((_root, opts, unrelated) => {
    const renamed = path.join(path.dirname(unrelated), 'lead.md')
    const moved: string[] = []
    const walkFs = { ...fs, lstatSync: (file: string) => {
      if (file === unrelated && !moved.length) { moved.push(file); fs.renameSync(file, renamed) }
      return fs.lstatSync(file)
    } }
    const result = resolveAgentDefinition('pilot', { ...opts, walkFs })
    expect(moved).toEqual([unrelated])
    expect(fs.existsSync(unrelated)).toBe(false)
    expect(fs.readFileSync(renamed, 'utf8')).toBe('---\nname: pilot\n---\n')
    expect(result).toEqual({ unresolved: `unreadable definition: ENOENT ${unrelated}` })
  }))

  it.skipIf(process.platform === 'win32')('ignores a non-agent FIFO but refuses an agent-named FIFO (requires POSIX mkfifo)', () => withWalkFixture((_root, opts, unrelated) => {
    fs.unlinkSync(unrelated)
    const pipe = path.join(path.dirname(unrelated), 'pipe')
    execFileSync('mkfifo', [pipe])
    expect(resolveAgentDefinition('pilot', opts)).toMatchObject({ scope: 'project', identity: 'pilot' })
    const agentPipe = `${pipe}.md`
    fs.renameSync(pipe, agentPipe)
    expect(resolveAgentDefinition('pilot', opts)).toEqual({ unresolved: `unreadable definition: NOT_REGULAR ${agentPipe}` })
  }))

  it('does not treat opaque tools as unrestricted or missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-opaque-tools-'))
    const previous = process.env.CLAUDE_CONFIG_DIR
    try {
      process.env.CLAUDE_CONFIG_DIR = path.join(root, 'config')
      const agents = path.join(root, '.claude', 'agents')
      fs.mkdirSync(agents, { recursive: true })
      fs.writeFileSync(path.join(agents, 'opaque-agent.md'), '---\nname: opaque-agent\ndescription: worker\ntools: {Read: true}\n---\n')
      expect(parseFrontmatter(fs.readFileSync(path.join(agents, 'opaque-agent.md'), 'utf8'))).toMatchObject({ ok: true, data: { tools: { Read: 'true' } } })
      expect(resolveAgentTypeTools('opaque-agent', root)).toMatchObject({ resolved: false, unresolved: expect.any(String) })
      fs.writeFileSync(path.join(agents, 'opaque-agent.md'), '---\nname: opaque-agent\ndescription: worker\ntools: [Read, {Write: yes}]\n---\n')
      expect(resolveAgentTypeTools('opaque-agent', root)).toMatchObject({ resolved: false, unresolved: expect.any(String) })
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('finds an ancestor across a nested worktree, ignores malformed siblings, and honors frontmatter identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-agent-'))
    try {
      const agents = path.join(root, '.claude', 'agents', 'review')
      fs.mkdirSync(agents, { recursive: true })
      fs.writeFileSync(path.join(agents, 'a-readme.md'), 'not frontmatter')
      fs.writeFileSync(path.join(agents, 'different.md'), '---\nname: pilot # worker\ndescription: a worker\nobserver: watchdog\n---\n')
      fs.symlinkSync(path.join(root, 'missing'), path.join(agents, 'z-broken'))
      const cwd = path.join(root, 'nested', 'worktree')
      fs.mkdirSync(cwd, { recursive: true })
      fs.writeFileSync(path.join(root, 'nested', '.git'), 'gitdir: elsewhere')
      const configDir = path.join(root, 'config')
      const opts = { cwd, configDir, env: {}, pluginRoot: path.join(root, 'plugin') }
      expect(resolveAgentDefinition('pilot', opts)).toEqual({ unresolved: `unreadable definition: ENOENT ${path.join(agents, 'z-broken')}` }) // broken sibling could have hidden another name
      expect(resolveAgentDefinition('pilot', { ...opts, budget: createBudget({ maxEntries: 1 }) })).toMatchObject({ unresolved: expect.stringContaining('budget') })
      fs.unlinkSync(path.join(agents, 'z-broken')) // rmSync leaves a dangling symlink behind on Node 24.0-24.13.0
      fs.rmSync(path.join(agents, 'a-readme.md'))
      expect(resolveAgentDefinition('pilot', opts)).toMatchObject({ unresolved: expect.any(String) }) // speculative ancestor cannot establish a winner
      expect(resolveAgentDefinition('pilot', { ...opts, env: { CLAUDE_PROJECT_DIR: root } })).toMatchObject({ scope: 'project', identity: 'pilot', data: { observer: 'watchdog' } })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('reads every registry installation and marketplace plus the running tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-registry-'))
    try {
      const configDir = path.join(root, 'config')
      fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true })
      const one = path.join(root, 'one')
      const two = path.join(root, 'two')
      const own = path.join(root, 'own')
      for (const plugin of [one, two, own]) {
        fs.mkdirSync(path.join(plugin, 'agents', 'review'), { recursive: true })
        fs.writeFileSync(path.join(plugin, 'agents', 'review', 'security.md'), '---\nname: security\ndescription: reviews code\nobserver: watchdog\n---\n')
      }
      fs.writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'workflow-toolbox@first': [{ installPath: one }, { installPath: two }], 'workflow-toolbox@second': [{ installPath: own }] } }))
      for (const marketplace of ['first', 'second']) {
        const listing = path.join(configDir, 'plugins', 'marketplaces', marketplace, '.claude-plugin', 'marketplace.json')
        fs.mkdirSync(path.dirname(listing), { recursive: true })
        fs.writeFileSync(listing, JSON.stringify({ plugins: [{ name: 'workflow-toolbox' }] }))
      }
      const registry = path.join(configDir, 'plugins', 'installed_plugins.json')
      const opts = { cwd: root, configDir, env: {}, pluginRoot: own }
      expect(resolveAgentDefinition('workflow-toolbox:review:security', opts)).toMatchObject({ file: path.join(one, 'agents', 'review', 'security.md') })
      for (const install of [one, two, own]) {
        fs.writeFileSync(registry, JSON.stringify({ plugins: { 'workflow-toolbox@first': [{ installPath: install }] } }))
        expect(resolveAgentDefinition('workflow-toolbox:review:security', opts)).toMatchObject({ file: path.join(install, 'agents', 'review', 'security.md') })
      }
      expect(resolveAgentDefinition('security', opts)).toMatchObject({ scope: 'plugin', file: path.join(own, 'agents', 'review', 'security.md') })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('uses manifest agent paths instead of the default directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-manifest-'))
    try {
      const configDir = path.join(root, 'config')
      const plugin = path.join(root, 'plugin')
      fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true })
      fs.mkdirSync(path.join(plugin, 'custom'), { recursive: true })
      fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true })
      fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', agents: ['custom/x.md'] }))
      fs.writeFileSync(path.join(plugin, 'custom', 'x.md'), '---\nname: x\ndescription: custom\n---\n')
      fs.writeFileSync(path.join(plugin, 'agents', 'x.md'), '---\nname: x\ndescription: default\n---\n')
      fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true })
      fs.writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ 'p@market': [{ installPath: plugin }] }))
      const listing = path.join(configDir, 'plugins', 'marketplaces', 'market', '.claude-plugin', 'marketplace.json')
      fs.mkdirSync(path.dirname(listing), { recursive: true })
      fs.writeFileSync(listing, JSON.stringify({ plugins: [{ name: 'p' }] }))
      expect(resolveAgentDefinition('p:x', { cwd: root, configDir, env: {}, pluginRoot: path.join(root, 'unused') })).toMatchObject({ file: path.join(plugin, 'custom', 'x.md'), data: { description: 'custom' } })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('treats missing descriptions, BOMs and same-tree ties as unresolved', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tie-'))
    try {
      const agents = path.join(root, '.claude', 'agents')
      fs.mkdirSync(path.join(agents, 'nested'), { recursive: true })
      fs.writeFileSync(path.join(agents, 'pilot.md'), '---\nname: pilot\nobserver: watchdog\n---\n')
      expect(resolveAgentDefinition('pilot', { cwd: root, configDir: path.join(root, 'empty'), env: {}, pluginRoot: path.join(root, 'empty-plugin') })).toMatchObject({ unresolved: expect.stringContaining('ineligible') })
      fs.writeFileSync(path.join(agents, 'pilot.md'), '\uFEFF---\nname: pilot\ndescription: worker\n---\n')
      expect(resolveAgentDefinition('pilot', { cwd: root, configDir: path.join(root, 'empty'), env: {}, pluginRoot: path.join(root, 'empty-plugin') })).toMatchObject({ unresolved: expect.stringContaining('uncertain') })
      fs.writeFileSync(path.join(agents, 'pilot.md'), '---\nname: pilot\ndescription: worker\n---\n')
      fs.writeFileSync(path.join(agents, 'nested', 'other.md'), '---\nname: pilot\ndescription: worker\n---\n')
      expect(resolveAgentDefinition('pilot', { cwd: root, configDir: path.join(root, 'empty'), env: {}, pluginRoot: path.join(root, 'empty-plugin') })).toMatchObject({ unresolved: expect.stringContaining('ambiguous') })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
