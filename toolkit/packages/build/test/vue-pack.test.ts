import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { packPaths } from './helpers/pack-contract.js'

const { packDir } = packPaths('vue')

describe('Vue pack', () => {
  it('ships the manifest, trigger files, SDK-only agents, and probe fixtures', () => {
    expect(existsSync(packDir), 'plugin/packs/vue must exist').toBe(true)
    const manifest = JSON.parse(readFileSync(`${packDir}/pack.json`, 'utf8'))
    expect(manifest).toMatchObject({
      language: 'vue',
      triggers: { extensions: ['.vue'], files: ['vite.config.ts', 'vitest.config.ts', 'tsconfig.json'] },
      agents: ['critic.md', 'reviewer.md'],
    })
    for (const agent of manifest.agents) expect(readFileSync(`${packDir}/agents/${agent}`, 'utf8')).toContain('sdk-only: true')
    expect(readFileSync(`${packDir}/probe/expected-diagnostic.txt`, 'utf8').trim()).not.toBe('')
    expect(existsSync(`${packDir}/probe/nav/expected-navigation.json`)).toBe(true)
  })

  it('does not declare Volar until an available-binary probe delivers diagnostics', () => {
    expect(existsSync(`${packDir}/.lsp.json`), 'an undelivered Volar diagnostic must not be declared').toBe(false)
  })
})
