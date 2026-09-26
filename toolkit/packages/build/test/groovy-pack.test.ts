import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { describePackContract, packPaths } from './helpers/pack-contract.js'

const { manifestPath, packDir } = packPaths('groovy')

// Navigation only: groovy-language-server compiles with an empty classpath unless a client sends one, so any
// import of a dependency or of the project's own Java classes is reported `unable to resolve class` (README).
// With diagnostics on, those false errors would reach Claude's context on every edit. `.gradle` stays unmapped.
describePackContract({
  pack: 'groovy',
  extensions: ['.groovy', '.gradle'],
  files: ['build.gradle', 'settings.gradle', 'spock.conf'],
  declaration: { command: 'groovy-language-server', args: [], extensionToLanguage: { '.groovy': 'groovy' }, diagnostics: false, startupTimeout: 30000 },
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
