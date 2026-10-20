import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkHostPrimitives,
  formatHostPrimitiveRefusal,
  hostPrimitiveCounts,
  hostDeclarationFile,
  loadHostPrimitiveAllowList,
  scanHostPrimitives,
  updateHostPrimitiveDeclaration,
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

  it('refuses undeclared host access and names its file, primitive and remedy', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'outside.mjs'), 'if (process.platform === "linux") process.kill(1)\n')

    const result = checkHostPrimitives(root, new Map())
    const refusal = formatHostPrimitiveRefusal(result)

    expect(result.count).toBe(2)
    expect(result.exceeded).toBe(true)
    expect(refusal).toContain('bin/outside.mjs')
    expect(refusal).toContain('process.kill: 1 > 0')
    expect(refusal).toContain('Move host access behind plugin/bin/lib/host/')
    expect(refusal).toContain('pnpm --dir toolkit quality:host')
  })

  it('exempts the declared adapter directory deliberately', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'lib', 'host', 'linux.mjs'), 'process.platform; process.kill(1)\n')

    expect(checkHostPrimitives(root, new Map())).toMatchObject({ count: 0, perimeterFiles: 0, exceeded: false })
  })

})

describe('host declaration path identity', () => {
  it.skipIf(sep === '\\')('keeps a literal POSIX backslash distinct from a directory separator', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'lib', 'a.mjs'), 'export const pure = true\n')
    writeFileSync(join(root, 'bin', 'lib\\a.mjs'), 'process.kill(1)\n')
    const result = checkHostPrimitives(root, new Map([['bin/lib/a.mjs:process.kill', 1]]))

    expect(result.exceeded).toBe(true)
    expect(hostPrimitiveCounts(result.findings)).toEqual(new Map([['bin/lib\\a.mjs:process.kill', 1]]))
    expect(formatHostPrimitiveRefusal(result)).toContain('bin/lib\\a.mjs')
  })

  it('normalizes native Windows separators in declaration keys', () => {
    expect(hostDeclarationFile('C:\\plugin\\bin\\lib\\a.mjs', 'C:\\plugin', win32)).toBe('bin/lib/a.mjs')
  })
})

describe('host declaration exactness', () => {
  it.each([['process.kill(1)', 2, 1], ['export const pure = true', 1, 0]])(
    'refuses oversized or stale counts for source %s', (source, allowed, count) => {
      const root = fixturePlugin()
      writeFileSync(join(root, 'bin', 'outside.mjs'), source)
      const result = checkHostPrimitives(root, new Map([['bin/outside.mjs:process.kill', allowed]]))

      expect(result.exceeded).toBe(true)
      expect(formatHostPrimitiveRefusal(result)).toContain(`process.kill: ${count} < ${allowed}`)
      expect(formatHostPrimitiveRefusal(result)).toContain("pnpm --dir toolkit exec node scripts/host-primitive-census.mjs --update-declaration 'bin/outside.mjs'")
    },
  )

  it.each(['{"process.kill":1}', '{}'])('refuses an orphan declaration, including empty data: %s', (data) => {
    const root = fixturePlugin()
    const declarations = fixturePlugin()
    writeFileSync(join(declarations, 'bin', 'removed.mjs.json'), data)
    const result = checkHostPrimitives(root, loadHostPrimitiveAllowList(declarations))

    expect(result.exceeded).toBe(true)
    expect(formatHostPrimitiveRefusal(result)).toContain('bin/removed.mjs: declaration has no source file')
    expect(formatHostPrimitiveRefusal(result)).toContain("--update-declaration 'bin/removed.mjs'")
  })
})

describe('per-file host primitive rejection', () => {
  it('refuses an undeclared primitive even when another file has unused allowance', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'outside.mjs'), 'process.kill(1)\n')
    const allowance = new Map([['bin/removed.mjs:process.kill', 1]])

    expect(checkHostPrimitives(root, allowance).exceeded).toBe(true)
  })

  it('refuses a new primitive kind within a declared file', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'outside.mjs'), 'process.kill(1)\n')
    const allowance = new Map([['bin/outside.mjs:process.platform', 1]])

    expect(checkHostPrimitives(root, allowance).exceeded).toBe(true)
  })

  it('refuses an extra occurrence of a declared primitive', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'outside.mjs'), 'process.kill(1); process.kill(2)\n')
    const allowance = new Map([['bin/outside.mjs:process.kill', 1]])

    expect(checkHostPrimitives(root, allowance).exceeded).toBe(true)
  })

})

describe('host primitive kind validation', () => {
  it('rejects a primitive name that could collide with a colon-containing source filename', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'a.mjs.json'), '{"b.mjs:process.kill":1}')

    expect(() => loadHostPrimitiveAllowList(root)).toThrow('Invalid host primitive kind: bin/a.mjs:b.mjs:process.kill')
  })
})

describe('host declaration regeneration', () => {
  it('regenerates a reduced declaration and removes declarations with no remaining findings', () => {
    const root = fixturePlugin()
    const declarations = fixturePlugin()
    const source = join(root, 'bin', 'outside.mjs')
    writeFileSync(source, 'process.kill(1)')
    writeFileSync(join(declarations, 'bin', 'outside.mjs.json'), '{"process.kill":2}')
    updateHostPrimitiveDeclaration('bin/outside.mjs', root, declarations)
    expect(loadHostPrimitiveAllowList(declarations)).toEqual(new Map([['bin/outside.mjs:process.kill', 1]]))
    writeFileSync(source, 'export const pure = true')
    updateHostPrimitiveDeclaration('bin/outside.mjs', root, declarations)
    expect(loadHostPrimitiveAllowList(declarations)).toEqual(new Map())
    writeFileSync(join(declarations, 'bin', 'removed.mjs.json'), '{}')
    updateHostPrimitiveDeclaration('bin/removed.mjs', root, declarations)
    expect(loadHostPrimitiveAllowList(declarations)).toEqual(new Map())
  })
})

describe('host primitive declaration data', () => {
  it('accepts declared occurrences after line shifts and discovers pure modules without declarations', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'outside.mjs'), '\n\nprocess.kill(1); process.kill(2)\n')
    writeFileSync(join(root, 'bin', 'pure.mjs'), 'export const pure = true\n')
    const allowance = new Map([['bin/outside.mjs:process.kill', 2]])

    expect(checkHostPrimitives(root, allowance)).toMatchObject({ count: 2, perimeterFiles: 2, exceeded: false })
  })

  it('loads independent declarations by full plugin-relative filename', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'outside.mjs.json'), '{"process.kill": 1}')
    writeFileSync(join(root, 'bin', 'lib', 'outside.mjs.json'), '{"process.platform": 2}')

    expect(loadHostPrimitiveAllowList(root)).toEqual(new Map([
      ['bin/outside.mjs:process.kill', 1],
      ['bin/lib/outside.mjs:process.platform', 2],
    ]))
  })

  it.each([0, -1, 1.5, '1'])('rejects an invalid declared occurrence count: %s', (count) => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'outside.mjs.json'), JSON.stringify({ 'process.kill': count }))

    expect(() => loadHostPrimitiveAllowList(root)).toThrow('Invalid host allowance: bin/outside.mjs:process.kill')
  })

})

describe('host primitive shell grammar exemption', () => {
  it('reads separators in the declared shell-command parser as shell syntax, but still counts its host access', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'bin', 'lib', 'rm-critical-path-core.mjs'), [
      "import { readFileSync } from 'node:fs'",
      "const isEscape = (c) => c === '\\\\'",
      "const isRoot = (p) => p === '/'",
    ].join('\n'))
    writeFileSync(join(root, 'bin', 'lib', 'git-bash-path.mjs'), "export const toBash = (p) => p.replace(/\\\\/g, '/') === '/'\n")
    writeFileSync(join(root, 'bin', 'lib', 'other.mjs'), "const isRoot = (p) => p === '/'\n")

    const primitives = scanHostPrimitives(root).findings.map(({ file, primitive }) => `${file} ${primitive}`)
    expect(primitives).toEqual([
      'bin/lib/other.mjs hard-coded path separator',
      'bin/lib/rm-critical-path-core.mjs fs import',
    ])
  })

})

describe('host primitive source discovery', () => {
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

})

describe('shipped host primitive declarations and quality gate', () => {
  it('pins each declared file and primitive to the tree that ships', () => {
    const allowance = loadHostPrimitiveAllowList()
    const result = checkHostPrimitives(PLUGIN_ROOT, allowance)

    expect(result.violations).toEqual([])
    expect(hostPrimitiveCounts(result.findings)).toEqual(allowance)
  })

  it('is a distinct quality gate rather than part of ordinary lint', () => {
    const manifest = JSON.parse(readFileSync(join(TOOLKIT_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }

    expect(manifest.scripts['quality:host']).toBe('node scripts/with-suite-lease.mjs --unleased-when-disabled --static -- node scripts/host-primitive-census.mjs')
    expect(manifest.scripts.quality).toContain('script-gates.mjs quality')
    expect(readFileSync(join(TOOLKIT_ROOT, 'scripts/script-gates.mjs'), 'utf8')).toContain("'quality:host'")
    expect(manifest.scripts.lint).not.toContain('host-primitive-census')
  })
})
