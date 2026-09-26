import * as fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describePackContract, packPaths } from './helpers/pack-contract.js'

describePackContract({
  pack: 'java',
  extensions: ['.java'],
  files: ['pom.xml'],
  consumerRules: ['java-lint-typecheck-build.md', 'tdd-junit.md'],
  declaration: { command: 'jdtls', args: [], extensionToLanguage: { '.java': 'java' }, diagnostics: true, startupTimeout: 23000 },
})

describe('Java pack ownership', () => {
  it('does not retain Groovy or Gradle triggers after ownership moves to the Groovy pack', () => {
    const { lspDeclarationPath, pluginLspDeclarationPath, manifestPath } = packPaths('java')
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).triggers.extensions).not.toContain('.groovy')
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).triggers.extensions).not.toContain('.gradle')
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).triggers.files).not.toContain('build.gradle')
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).triggers.files).not.toContain('build.gradle.kts')
    expect(JSON.parse(fs.readFileSync(lspDeclarationPath, 'utf8'))).not.toHaveProperty('groovy')
    expect(JSON.parse(fs.readFileSync(pluginLspDeclarationPath, 'utf8'))).not.toHaveProperty('groovy')
  })
})
