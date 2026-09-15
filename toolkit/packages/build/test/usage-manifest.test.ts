import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const PLUGIN_ROOT = join(ROOT, 'plugin')

function productionModules(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const candidate = join(dir, name)
    if (statSync(candidate).isDirectory()) files.push(...productionModules(candidate))
    else if (name.endsWith('.mjs')) files.push(candidate)
  }
  return files
}

describe('plugin usage manifest', () => {
  it('declares every WT_*_TEST_* production control exactly once, one name per entry', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'usage-manifest.json'), 'utf8')) as {
      env: Array<{ name: string }>
    }
    const declaredEntries = manifest.env.filter(({ name }) => /^WT_[A-Z0-9_]*_TEST_[A-Z0-9_]*$/.test(name))
    const declared = declaredEntries.map(({ name }) => name).sort()
    const used = [...new Set(productionModules(join(PLUGIN_ROOT, 'bin')).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\bWT_[A-Z0-9_]*_TEST_[A-Z0-9_]*\b/g)].map((match) => match[0]),
    ))].sort()

    expect(new Set(declared).size).toBe(declared.length)
    expect(declared).toEqual(used)
  })
})
