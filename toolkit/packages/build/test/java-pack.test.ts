import * as fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describePackContract, packPaths } from './helpers/pack-contract.js'

describePackContract({
  pack: 'java',
  extensions: ['.java', '.groovy', '.gradle'],
  files: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  consumerTrigger: '/\\.(?:java|groovy|gradle)$/i.test(editPath(e))',
  declaration: { command: 'jdtls', args: [], extensionToLanguage: { '.java': 'java' }, diagnostics: true, startupTimeout: 23000 },
})

describe('Java pack: Groovy is guidance, never a declaration (plan D2)', () => {
  it('declares no groovy language key in the pack or the root while .groovy is a trigger', () => {
    const { lspDeclarationPath, pluginLspDeclarationPath, manifestPath } = packPaths('java')
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).triggers.extensions).toContain('.groovy')
    expect(JSON.parse(fs.readFileSync(lspDeclarationPath, 'utf8'))).not.toHaveProperty('groovy')
    expect(JSON.parse(fs.readFileSync(pluginLspDeclarationPath, 'utf8'))).not.toHaveProperty('groovy')
  })
})
