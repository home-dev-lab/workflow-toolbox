import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  it('rejects raw argv entry guards in plugin bin modules', () => {
    const rawEntryGuard = /import\.meta\.url\s*===\s*pathToFileURL\([^)]*(?:argv|invokedPath)|path\.resolve\(process\.argv\[1\]\)\s*===\s*fileURLToPath\(import\.meta\.url\)/
    const binSources = readdirSync(join(PLUGIN_ROOT, 'bin'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
      .map((entry) => ({ file: `bin/${entry.name}`, source: readFileSync(join(PLUGIN_ROOT, 'bin', entry.name), 'utf8') }))

    expect(binSources.filter(({ source }) => rawEntryGuard.test(source)).map(({ file }) => file)).toEqual([])
  })

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

  it('counts child-process, OS and filesystem calls in every executable source extension', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'direct.js'), [
      "import { spawn as launch } from 'node:child_process'",
      "import { readFileSync as read } from 'node:fs'",
      "import { writeFile as write } from 'node:fs/promises'",
      'launch("tool", [])',
      'read("file")',
      'write("file", "value")',
    ].join('\n'))
    writeFileSync(join(root, 'namespace.cjs'), [
      "const child = require('child_process')",
      "const os = require('node:os')",
      'child.exec("tool")',
      'os.tmpdir()',
    ].join('\n'))
    writeFileSync(join(root, 'default.mjs'), [
      "import fs from 'node:fs'",
      "import * as child from 'node:child_process'",
      'fs.realpathSync("file")',
      'child.execFile("tool", [])',
      'child.fork("worker.js")',
    ].join('\n'))

    const result = scanHostPrimitives(root)
    expect(result.perimeterFiles).toBe(3)
    expect(result.findings.map(({ primitive }) => primitive)).toEqual(expect.arrayContaining([
      'spawn', 'readFileSync', 'writeFile', 'exec', 'tmpdir', 'realpathSync', 'execFile', 'fork',
    ]))
  })

  it('pins the measured ceiling to the tree that ships', () => {
    const result = scanHostPrimitives(PLUGIN_ROOT)

    // The grounding CLI, two hooks, and pure public re-export add four perimeter files;
    // their host operations stay behind bin/lib/host, so the primitive ceiling is unchanged. The Java pack's
    // wt-jdtls.mjs launcher adds one more; its JVM discovery and spawn live in bin/lib/host/jdtls-java.mjs.
    // The decision store keeps its filesystem operations behind bin/lib/host, so neither perimeter
    // count nor primitive ceiling increases.
    expect(result.perimeterFiles).toBe(233)
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
