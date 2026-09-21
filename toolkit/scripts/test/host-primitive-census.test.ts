import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST_PRIMITIVE_CEILING,
  checkHostPrimitives,
  formatHostPrimitiveRefusal,
  scanHostPrimitives,
} from '../host-primitive-census.mjs'

const TOOLKIT_ROOT = resolve(import.meta.dirname, '../..')
const PLUGIN_ROOT = resolve(TOOLKIT_ROOT, '../plugin')
const temporaryDirectories: string[] = []

function fixturePlugin(): string {
  const root = mkdtempSync(join(tmpdir(), 'host-primitive-census-'))
  temporaryDirectories.push(root)
  mkdirSync(join(root, 'bin', 'lib', 'host'), { recursive: true })
  return root
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('raw host primitive quality ratchet', () => {
  it('refuses a fixture above the ceiling and names its file and remedy', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'outside.mjs'), 'if (process.platform === "linux") process.kill(1)\n')

    const result = checkHostPrimitives(root, 0)
    const refusal = formatHostPrimitiveRefusal(result)

    expect(result.count).toBe(2)
    expect(refusal).toContain('bin/outside.mjs')
    expect(refusal).toContain('Move host access behind plugin/bin/lib/host/')
  })

  it('exempts the declared adapter directory deliberately', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'lib', 'host', 'linux.mjs'), 'process.platform; process.kill(1)\n')

    expect(checkHostPrimitives(root, 0)).toMatchObject({ count: 0, perimeterFiles: 0, exceeded: false })
  })

  it('pins the measured ceiling to the tree that ships', () => {
    const result = scanHostPrimitives(PLUGIN_ROOT)

    expect(result.perimeterFiles).toBe(212)
    expect(result.findings).toHaveLength(HOST_PRIMITIVE_CEILING)
  })

  it('is a distinct quality gate rather than part of ordinary lint', () => {
    const manifest = JSON.parse(readFileSync(join(TOOLKIT_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(manifest.scripts['quality:host']).toBe('node scripts/host-primitive-census.mjs')
    expect(manifest.scripts.quality).toContain('pnpm run quality:host')
    expect(manifest.scripts.lint).not.toContain('host-primitive-census')
  })
})
