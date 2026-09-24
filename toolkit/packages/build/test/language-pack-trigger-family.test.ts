import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface PackManifest {
  language: string
  testFramework: string
  triggers: { extensions: string[]; files?: string[] }
}

const packsDir = fileURLToPath(new URL('../../../../plugin/packs/', import.meta.url))

function duplicateClaims(triggerType: 'extensions' | 'files') {
  const claims = new Map<string, string[]>()
  const packDirs = fs.readdirSync(packsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(packsDir, entry.name, 'pack.json')))
    .map((entry) => entry.name)
    .sort()

  for (const packDir of packDirs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(packsDir, packDir, 'pack.json'), 'utf8')) as PackManifest
    for (const trigger of manifest.triggers[triggerType] ?? []) {
      claims.set(trigger, [...(claims.get(trigger) ?? []), manifest.language])
    }
  }

  return [...claims]
    .filter(([, packs]) => packs.length > 1)
    .map(([trigger, packs]) => `${trigger}: ${packs.join(', ')}`)
}

describe('language pack trigger family', () => {
  it('declares a failed-test adapter for every language pack', () => {
    const frameworks = new Set(['vitest', 'pytest', 'junit-gradle'])
    const manifests = fs.readdirSync(packsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(packsDir, entry.name, 'pack.json')))
      .map((entry) => JSON.parse(fs.readFileSync(path.join(packsDir, entry.name, 'pack.json'), 'utf8')) as PackManifest)
    expect(manifests.every((manifest) => frameworks.has(manifest.testFramework))).toBe(true)
  })

  it('assigns every file trigger to exactly one pack', () => {
    expect(duplicateClaims('files'), 'duplicate file triggers').toEqual([])
  })

  it('assigns every extension trigger to exactly one pack', () => {
    expect(duplicateClaims('extensions'), 'duplicate extension triggers').toEqual([])
  })
})
