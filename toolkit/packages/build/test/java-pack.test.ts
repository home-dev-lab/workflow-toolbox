import * as fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { describePackContract, packPaths } from './helpers/pack-contract.js'

describePackContract({
  pack: 'java',
  extensions: ['.java'],
  files: ['pom.xml'],
  consumerRules: ['java-lint-typecheck-build.md', 'tdd-junit.md'],
  // The plugin's own launcher starts jdtls on a JVM >= 21 whatever the session's JAVA_HOME (jdtls-launcher.test.ts).
  declaration: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/wt-jdtls.mjs'], extensionToLanguage: { '.java': 'java' }, diagnostics: true, startupTimeout: 23000 },
})

describe('Java pack ownership', () => {
  it('does not retain Groovy or Gradle triggers after ownership moves to the Groovy pack', () => {
    const { lspDeclarationPath, pluginLspDeclarationPath, manifestPath } = packPaths('java')
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).triggers.extensions).not.toContain('.groovy')
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).triggers.extensions).not.toContain('.gradle')
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).triggers.files).not.toContain('build.gradle')
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).triggers.files).not.toContain('build.gradle.kts')
    expect(JSON.parse(fs.readFileSync(lspDeclarationPath, 'utf8'))).not.toHaveProperty('groovy')
    // The root's `groovy` entry is the Groovy pack's own (groovy-pack.test.ts): the Java server never claims `.groovy`.
    expect(Object.keys(JSON.parse(fs.readFileSync(pluginLspDeclarationPath, 'utf8')).java.extensionToLanguage)).toEqual(['.java'])
  })
})
