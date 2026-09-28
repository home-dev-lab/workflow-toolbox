import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { resolveAgentDefinition } from '../../../../plugin/bin/lib/agent-definitions.mjs'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { readFrontmatterFile } from '../../../../plugin/bin/lib/frontmatter.mjs'

function setup(run: (root: string, options: object, write: (file: string, data: string) => void) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-discovery-lock-'))
  const write = (file: string, data: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data)
    if (file.endsWith('installed_plugins.json')) {
      const marketplace = path.join(root, 'config/plugins/marketplaces/m/.claude-plugin/marketplace.json')
      fs.mkdirSync(path.dirname(marketplace), { recursive: true })
      if (!fs.existsSync(marketplace)) fs.writeFileSync(marketplace, JSON.stringify({ plugins: [{ name: 'p' }] }))
    }
  }
  try { run(root, { cwd: root, configDir: path.join(root, 'config'), pluginRoot: path.join(root, 'unused'), env: {} }, write) }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
}
const agent = (name: string, observer = '') => `---\nname: ${name}\ndescription: worker\n${observer ? `observer: ${observer}\n` : ''}---\n`
describe('definition discovery uncertainty', () => {
  it.each(['oversized', 'malformed', 'unreadable', 'subtree'])('E1 treats renamed %s definition as unresolved', (kind) => setup((root, opts, write) => {
    const dir = path.join(root, '.claude/agents')
    const file = path.join(dir, 'different.md')
    write(file, kind === 'oversized' ? agent('pilot', 'x'.repeat(66000)) : kind === 'malformed' ? '---\n"name": pilot\ndescription: [oops\n---\n' : agent('pilot'))
    if (kind === 'unreadable') fs.symlinkSync('missing.md', path.join(dir, 'missing.md'))
    if (kind === 'subtree') fs.symlinkSync('missing', path.join(dir, 'review'))
    expect(resolveAgentDefinition('pilot', opts)).toMatchObject({ unresolved: expect.any(String) })
  }))
  it('E1 reports an EACCES opening a differently named definition', () => setup((root, opts, write) => {
    write(path.join(root, '.claude/agents/different.md'), agent('pilot'))
    const readDefinition = (file: string, options: object) => file.endsWith('different.md')
      ? { ok: false, reason: 'io-error', detail: 'EACCES' } : readFrontmatterFile(file, options)
    expect(resolveAgentDefinition('pilot', { ...opts, readDefinition })).toMatchObject({ unresolved: expect.any(String) })
  }))
  it('E1 treats an invalid name shape as unknown rather than filename-only proof', () => setup((root, opts, write) => {
    const install = path.join(root, 'install')
    write(path.join(root, 'config/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: install }] } }))
    write(path.join(install, 'agents/pilot.md'), '---\nname: {other: identity}\ndescription: worker\n---\n')
    expect(resolveAgentDefinition('p:pilot', opts)).toMatchObject({ unresolved: expect.any(String) })
  }))
  it('E2 detects conflicting installations even if the first has out-of-project metadata', () => setup((root, opts, write) => {
    const config = path.join(root, 'config/plugins/installed_plugins.json')
    const old = path.join(root, 'old'), current = path.join(root, 'new')
    write(config, JSON.stringify({ plugins: { 'p@m': [{ installPath: old, scope: 'project', projectPath: '/other' }, { installPath: current, scope: 'project', projectPath: root }] } }))
    write(path.join(old, 'agents/pilot.md'), agent('pilot'))
    write(path.join(current, 'agents/pilot.md'), agent('pilot', 'watchdog'))
    expect(resolveAgentDefinition('p:pilot', opts)).toMatchObject({ unresolved: expect.any(String) })
  }))
  it('E2 compares identical installation data deeply even for YAML alias cycles', () => setup((root, opts, write) => {
    const old = path.join(root, 'old'), current = path.join(root, 'current')
    write(path.join(root, 'config/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: old }, { installPath: current }] } }))
    write(path.join(old, 'agents/pilot.md'), '---\nname: pilot\ndescription: worker\nmetadata: &a {x: *a}\n---\n')
    write(path.join(current, 'agents/pilot.md'), '---\ndescription: worker\nmetadata: &a {x: *a}\nname: pilot\n---\n')
    expect(resolveAgentDefinition('p:pilot', opts)).toMatchObject({ data: { name: 'pilot' } })
  }))
  it('E2 records conflicting plugin installations even behind a project winner', () => setup((root, opts, write) => {
    const old = path.join(root, 'old'), current = path.join(root, 'current')
    write(path.join(root, '.claude/agents/pilot.md'), agent('pilot'))
    write(path.join(root, 'config/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: old }, { installPath: current }] } }))
    write(path.join(old, 'agents/pilot.md'), agent('pilot'))
    write(path.join(current, 'agents/pilot.md'), agent('pilot', 'watchdog'))
    expect(resolveAgentDefinition('pilot', opts)).toMatchObject({ unresolved: expect.any(String) })
  }))
  it('E3 puts ancestors above git below user and marks a conflicting match unresolved', () => setup((root, opts, write) => {
    const repo = path.join(root, 'repo')
    write(path.join(repo, '.git/HEAD'), 'ref: refs/heads/main')
    write(path.join(root, '.claude/agents/pilot.md'), agent('pilot'))
    write(path.join(root, 'config/agents/pilot.md'), agent('pilot', 'watchdog'))
    expect(resolveAgentDefinition('pilot', { ...opts, cwd: repo })).toMatchObject({ unresolved: expect.any(String) })
  }))
  it('E3 treats a project-dir ancestor as documented even when cwd saw it speculatively', () => setup((root, opts, write) => {
    const nested = path.join(root, 'nested')
    write(path.join(root, '.git/HEAD'), 'ref: main')
    write(path.join(nested, '.git/HEAD'), 'ref: nested')
    write(path.join(root, '.claude/agents/pilot.md'), agent('pilot', 'watchdog'))
    expect(resolveAgentDefinition('pilot', { ...opts, cwd: nested, env: { CLAUDE_PROJECT_DIR: root } })).toMatchObject({ scope: 'project', data: { observer: 'watchdog' } })
  }))
  it('E4 walks lexical directory aliases', () => setup((root, opts, write) => {
    const install = path.join(root, 'install')
    write(path.join(root, 'config/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: install }] } }))
    write(path.join(install, 'agents/review/security.md'), agent('security', 'watchdog'))
    fs.symlinkSync('review', path.join(install, 'agents/a'))
    expect(resolveAgentDefinition('p:review:security', opts)).toMatchObject({ data: { observer: 'watchdog' } })
  }))
  it('E5 refuses filename/name disagreement', () => setup((root, opts, write) => {
    const install = path.join(root, 'install')
    write(path.join(root, 'config/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: install }] } }))
    write(path.join(install, 'agents/a.md'), agent('pilot'))
    write(path.join(install, 'agents/pilot.md'), agent('different', 'watchdog'))
    expect(resolveAgentDefinition('p:pilot', opts)).toMatchObject({ unresolved: expect.any(String) })
  }))
  it('E5 refuses two lexical files in one installation even across manifest roots', () => setup((root, opts, write) => {
    const install = path.join(root, 'install')
    write(path.join(root, 'config/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: install }] } }))
    write(path.join(install, '.claude-plugin/plugin.json'), JSON.stringify({ agents: ['./first', './second'] }))
    write(path.join(install, 'first/pilot.md'), agent('pilot'))
    write(path.join(install, 'second/pilot.md'), agent('pilot'))
    expect(resolveAgentDefinition('p:pilot', opts)).toMatchObject({ unresolved: expect.any(String) })
  }))
  it('E6 honors marketplace component paths', () => setup((root, opts, write) => {
    const install = path.join(root, 'install')
    write(path.join(root, 'config/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: install }] } }))
    write(path.join(root, 'config/plugins/marketplaces/m/.claude-plugin/marketplace.json'), JSON.stringify({ plugins: [{ name: 'p', source: './p', agents: ['./custom/pilot.md'] }] }))
    write(path.join(install, 'agents/pilot.md'), agent('pilot'))
    write(path.join(install, 'custom/pilot.md'), agent('pilot', 'watchdog'))
    expect(resolveAgentDefinition('p:pilot', opts)).toMatchObject({ data: { observer: 'watchdog' } })
  }))
  it('E6 refuses a corrupt marketplace entry instead of accepting the default directory', () => setup((root, opts, write) => {
    const install = path.join(root, 'install')
    write(path.join(root, 'config/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: install }] } }))
    write(path.join(root, 'config/plugins/marketplaces/m/.claude-plugin/marketplace.json'), '{broken')
    write(path.join(install, 'agents/pilot.md'), agent('pilot'))
    expect(resolveAgentDefinition('p:pilot', opts)).toMatchObject({ unresolved: expect.any(String) })
  }))
  it('E7 treats an empty install path as uncertainty', () => setup((root, opts, write) => {
    write(path.join(root, 'config/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'p@m': [{ installPath: '' }] } }))
    expect(resolveAgentDefinition('p:pilot', opts)).toMatchObject({ unresolved: expect.any(String) })
  }))
  it('R16 never walks a slash or dot-dot leaf', () => setup((_root, opts) => {
    for (const type of ['../pilot', 'p:review/../../pilot', 'p:..']) {
      expect(resolveAgentDefinition(type, opts)).toBeNull()
    }
  }))
})
