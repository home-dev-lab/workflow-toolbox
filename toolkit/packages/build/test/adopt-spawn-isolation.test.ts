import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'
// @ts-expect-error read-only structural scanner
import { scanAdoptSpawnIsolation } from './helpers/adopt-spawn-isolation.mjs'

const ROOT = join(import.meta.dirname, '../../..')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function scanSnippet(env: string, args = '[HOOK]', alias = 'spawnSync') {
  const root = mkdtempSync(join(tmpdir(), 'wt-adopt-isolation-')); roots.push(root)
  const file = join(root, 'fixture.test.ts')
  writeFileSync(file, `import { spawnSync as ${alias} } from 'node:child_process';
const HOOK = 'wt-adopt-check-hook.mjs'; const INSTALL = 'install.mjs';
const SAFE = { HOME: '/fixture/home', CLAUDE_CONFIG_DIR: '/fixture/config' };
${alias}(process.execPath, ${args}, { ${env} });`)
  return scanAdoptSpawnIsolation(root, [file]) as { file: string; missing: string[] }[]
}

describe('adopt writer test isolation', () => {
  it('every hook/shim or write-mode installer spawn supplies HOME and CLAUDE_CONFIG_DIR', () => {
    expect(scanAdoptSpawnIsolation(ROOT)).toEqual([])
  })
  it('accepts the known isolated installer witness through its used shared env constant', () => {
    expect(scanAdoptSpawnIsolation(ROOT, [join(ROOT, 'packages/build/test/adopt-installer.test.ts')])).toEqual([])
  })
})

describe('adopt isolation scanner witnesses', () => {
  it.each(['', 'env: process.env', 'env: { HOME: "home" }', 'env: { ...SAFE, HOME: undefined }', 'env: { ...SAFE, ...{ CLAUDE_CONFIG_DIR: undefined } }', 'env: { ...SAFE, HOME: "" }', 'env: { ...SAFE, ...process.env }'])('rejects unsafe passed environment %s despite unused isolated words', (env) => {
    expect(scanSnippet(env).map((finding) => finding.file)).toEqual(['fixture.test.ts'])
  })
  it('accepts the actually used shared environment and exempts read-only installer calls', () => {
    expect(scanSnippet('env: SAFE')).toEqual([])
    expect(scanSnippet('env: { ...process.env, ...SAFE }')).toEqual([])
    expect(scanSnippet('', '[INSTALL, "--check"]')).toEqual([])
    expect(scanSnippet('', '[INSTALL, "--diff", "rule.md"]')).toEqual([])
    expect(scanSnippet('', '[INSTALL, "--install"]')).toHaveLength(1)
    expect(scanSnippet('', '[INSTALL, ...(write ? ["--install"] : ["--check"])]')).toHaveLength(1)
  })
  it('resolves renamed child-process imports instead of depending on the local spawn name', () => {
    expect(scanSnippet('', '[HOOK]', 'launch')).toHaveLength(1)
    expect(scanSnippet('env: SAFE', '[HOOK]', 'launch')).toEqual([])
  })
  it('sets both isolation keys on Windows as well as USERPROFILE', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-adopt-windows-env-')); roots.push(root)
    const env = sealedPluginCliEnv(root, {}, 'win32')
    expect(env.HOME).toBe(join(root, 'home'))
    expect(env.USERPROFILE).toBe(env.HOME)
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(root, 'claude-config'))
  })
})
