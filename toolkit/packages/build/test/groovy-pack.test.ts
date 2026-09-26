import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { describePackContract, packPaths } from './helpers/pack-contract.js'

const { manifestPath, packDir } = packPaths('groovy')

// `.gradle` is deliberately unmapped: groovy-language-server has no Gradle API on its classpath and reports
// `unable to resolve class org.gradle...` on an ordinary build script (measured 2026-09-26, README).
describePackContract({
  pack: 'groovy',
  extensions: ['.groovy', '.gradle'],
  files: ['build.gradle', 'settings.gradle', 'spock.conf'],
  declaration: { command: 'groovy-language-server', args: [], extensionToLanguage: { '.groovy': 'groovy' }, diagnostics: true, startupTimeout: 30000 },
})

describe('Groovy pack', () => {
  it('owns Groovy, Gradle, and Spock trigger paths', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    expect(manifest).toMatchObject({
      language: 'groovy',
      triggers: {
        extensions: ['.groovy', '.gradle'],
        files: ['build.gradle', 'settings.gradle', 'spock.conf'],
      },
    })
  })

  it('ships its named rules and SDK-only agents', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    for (const rule of manifest.rules) expect(fs.existsSync(path.join(packDir, 'rules', rule))).toBe(true)
    for (const agent of manifest.agents) expect(fs.readFileSync(path.join(packDir, 'agents', agent), 'utf8')).toContain('sdk-only: true')
  })

  it('ships diagnostics and navigation probe fixtures', () => {
    expect(fs.readFileSync(path.join(packDir, 'probe', 'expected-diagnostic.txt'), 'utf8').trim()).not.toBe('')
    expect(fs.existsSync(path.join(packDir, 'probe', 'Probe.groovy'))).toBe(true)
    expect(fs.existsSync(path.join(packDir, 'probe', 'nav', 'expected-navigation.json'))).toBe(true)
  })
})
