import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const packDir = resolve(repoRoot, 'plugin/packs/svelte')

describe('Svelte language pack', () => {
  it('ships Svelte and svelte-check selection with a measured LSP probe fixture', () => {
    const manifest = JSON.parse(readFileSync(join(packDir, 'pack.json'), 'utf8'))
    expect(manifest).toMatchObject({
      language: 'svelte',
      triggers: {
        extensions: ['.svelte'],
        files: ['svelte.config.js'],
      },
    })
    expect(JSON.parse(readFileSync(join(packDir, '.lsp.json'), 'utf8'))).toEqual({
      svelte: {
        command: 'svelteserver',
        args: ['--stdio'],
        extensionToLanguage: { '.svelte': 'svelte' },
        diagnostics: true,
        startupTimeout: 10000,
      },
    })
    for (const file of ['README.md', 'rules/svelte.md', 'agents/critic.md', 'agents/reviewer.md', 'probe/probe.svelte', 'probe/expected-diagnostic.txt', 'probe/nav/expected-navigation.json', 'probe/nav/definitions.svelte', 'probe/nav/use.svelte']) {
      expect(existsSync(join(packDir, file)), `missing ${file}`).toBe(true)
    }
    expect(readFileSync(join(packDir, 'probe/expected-diagnostic.txt'), 'utf8').trim()).not.toBe('')
  })
})
