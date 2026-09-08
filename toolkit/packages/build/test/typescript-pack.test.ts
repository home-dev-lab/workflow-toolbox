import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const packDir = path.resolve(testDir, '../../../../plugin/packs/typescript')
const manifestPath = path.join(packDir, 'pack.json')

describe('TypeScript pack manifest', () => {
  it('declares files that exist in the pack', () => {
    expect(fs.existsSync(manifestPath), 'plugin/packs/typescript/pack.json exists').toBe(true)

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      language: string
      rules: string[]
      skills: string[]
      agents: string[]
    }

    expect(manifest.language).toBe('typescript')
    for (const name of manifest.rules) expect(fs.existsSync(path.join(packDir, 'rules', name))).toBe(true)
    for (const name of manifest.skills) expect(fs.existsSync(path.join(packDir, 'skills', name, 'SKILL.md'))).toBe(true)
    for (const name of manifest.agents) expect(fs.existsSync(path.join(packDir, 'agents', name))).toBe(true)
  })
})
