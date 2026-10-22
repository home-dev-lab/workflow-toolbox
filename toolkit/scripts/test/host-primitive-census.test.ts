import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep, win32 } from 'node:path'
import { afterEach, describe, expect, it, type TestContext } from 'vitest'
const {
  checkHostPrimitives,
  formatHostPrimitiveRefusal,
  hostPrimitiveCounts,
  hostDeclarationFile,
  loadHostPrimitiveAllowList,
  scanHostPrimitives,
  sourceFiles,
  updateHostPrimitiveDeclaration,
} = await import(process.env.WT_HOST_CENSUS_MODULE ?? '../host-primitive-census.mjs') as typeof import('../host-primitive-census.mjs')

const TOOLKIT_ROOT = resolve(import.meta.dirname, '../..')
const PLUGIN_ROOT = resolve(TOOLKIT_ROOT, '../plugin')
const temporaryDirectories: string[] = []

function fixturePlugin(): string {
  const root = mkdtempSync(join(tmpdir(), 'host-primitive-census-'))
  temporaryDirectories.push(root)
  mkdirSync(join(root, 'bin', 'lib', 'host'), { recursive: true })
  return root
}

function fixtureLink(context: TestContext, target: string, path: string, type: 'file' | 'dir'): void {
  try {
    symlinkSync(target, path, type)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS'].includes(code ?? '')) {
      context.skip(`Windows cannot create ${type} symlinks (${code}); enable Developer Mode or grant symlink privileges`)
    }
    throw error
  }
}

function expectUndeclared(root: string, file: string, primitives: string[]): void {
  const result = checkHostPrimitives(root, new Map())
  expect(result.findings.filter((finding) => finding.file === file).map(({ primitive }) => primitive).sort()).toEqual([...primitives].sort())
  expect(result.exceeded).toBe(true)
  expect(formatHostPrimitiveRefusal(result)).toContain(file)
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

describe('host primitive element access', () => {
  it.each([
    ['import nodeFs from "node:fs"; nodeFs["readFileSync"]("x")', ['fs import', 'readFileSync']],
    ['import nodeFs from "node:fs"; nodeFs["promises"].readFile("x")', ['fs import', 'readFile']],
    ['import nodeFs from "node:fs"; nodeFs.promises["readFile"]("x")', ['fs import', 'readFile']],
    ['require("node:fs")["readFileSync"]("x")', ['fs require', 'readFileSync']],
    ['process["kill"](1); process["platform"]', ['process.kill', 'process.platform']],
    ['import child from "node:child_process"; child["execFile"]("tool")', ['child_process import', 'execFile']],
  ])('refuses string-key access: %s', (source, primitives) => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'element.mjs'), source as string)
    expectUndeclared(root, 'element.mjs', primitives as string[])
  })
})

describe('host primitive dynamic import bindings', () => {
  it.each([
    ['const fs = await import("node:fs"); fs.readFileSync("x")', ['fs import', 'readFileSync']],
    ['const fs = (await import("fs")); fs.readFileSync("x")', ['fs import', 'readFileSync']],
    ['const { readFileSync: read } = await import("node:fs"); read("x")', ['fs import', 'readFileSync']],
    ['const { "readFileSync": read } = await import("node:fs"); read("x")', ['fs import', 'readFileSync']],
    ['const child = await import("node:child_process"); child.exec("tool")', ['child_process import', 'exec']],
    ['const os = await import("node:os"); os.tmpdir()', ['os import', 'tmpdir']],
    ['const fs = await import("node:fs/promises"); fs.readFile("x")', ['fs/promises import', 'readFile']],
  ])('refuses imported host calls: %s', (source, primitives) => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'dynamic.mjs'), source as string)
    expectUndeclared(root, 'dynamic.mjs', primitives as string[])
  })
})

describe('host primitive bindings used as values', () => {
  it.each([
    ['import { existsSync } from "node:fs"; f(dir, existsSync)', ['fs import', 'existsSync']],
    ['import { existsSync as exists } from "node:fs"; f(dir, exists)', ['fs import', 'existsSync']],
    ['const { existsSync } = require("node:fs"); f(dir, existsSync)', ['fs require', 'existsSync']],
    ['const { existsSync } = await import("node:fs"); f(dir, existsSync)', ['fs import', 'existsSync']],
    ['import { existsSync } from "node:fs"; const api = { existsSync }; const copy = existsSync', ['fs import', 'existsSync', 'existsSync']],
    ['import { existsSync } from "node:fs"; existsSync("x"); f(existsSync); obj.existsSync; const x = { existsSync: true }', ['fs import', 'existsSync', 'existsSync']],
  ])('counts references without counting binding names: %s', (source, primitives) => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'value.mjs'), source as string)
    expectUndeclared(root, 'value.mjs', primitives as string[])
  })
})

describe('host primitive shebang source discovery', () => {
  it.each(['#!/usr/bin/env node\n', '#!/usr/bin/env node\r\n', '#!/usr/bin/node\n', '#!/usr/bin/env -S node --no-warnings\r\n'])(
    'refuses an extensionless Node script with shebang %j', (shebang) => {
      const root = fixturePlugin()
      writeFileSync(join(root, 'bin', 'helper'), Buffer.from(`${shebang}process.kill(1)\n`))
      expectUndeclared(root, 'bin/helper', ['process.kill'])
    },
  )

  it('does not treat shell scripts or ordinary extensionless data as Node source', () => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'shell'), '#!/bin/sh\nprocess.kill(1)')
    writeFileSync(join(root, 'data'), 'process.kill(1)')
    expect(scanHostPrimitives(root)).toEqual({ perimeterFiles: 0, findings: [] })
  })
})

describe('host primitive symlink file discovery', () => {
  it('scans a linked executable under its real target exactly once', (context) => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'payload.txt'), 'process.kill(1)')
    fixtureLink(context, join(root, 'payload.txt'), join(root, 'a-link.mjs'), 'file')
    fixtureLink(context, join(root, 'payload.txt'), join(root, 'b-link.mjs'), 'file')
    expectUndeclared(root, 'payload.txt', ['process.kill'])
    expect(scanHostPrimitives(root).perimeterFiles).toBe(1)
  })

  it('deduplicates a linked source and its ordinary source path', (context) => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'z-target.mjs'), 'process.kill(1)')
    fixtureLink(context, join(root, 'z-target.mjs'), join(root, 'a-link.mjs'), 'file')
    expectUndeclared(root, 'z-target.mjs', ['process.kill'])
    expect(scanHostPrimitives(root).perimeterFiles).toBe(1)
  })
})

describe('host primitive symlink directory discovery', () => {
  it('canonicalizes a linked scan root and terminates directory cycles', (context) => {
    const root = fixturePlugin()
    const holder = fixturePlugin()
    writeFileSync(join(root, 'bin', 'helper.mjs'), 'process.kill(1)')
    fixtureLink(context, root, join(root, 'bin', 'cycle'), 'dir')
    fixtureLink(context, root, join(holder, 'linked-root'), 'dir')
    expect(sourceFiles(join(holder, 'linked-root'))).toEqual([join(realpathSync(root), 'bin', 'helper.mjs')])
    expectUndeclared(join(holder, 'linked-root'), 'bin/helper.mjs', ['process.kill'])
    expect(scanHostPrimitives(join(holder, 'linked-root')).perimeterFiles).toBe(1)
  })

  it('deduplicates directory aliases without escaping the scanned root', (context) => {
    const root = fixturePlugin()
    const outside = fixturePlugin()
    writeFileSync(join(root, 'bin', 'helper.mjs'), 'process.kill(1)')
    writeFileSync(join(outside, 'escape.mjs'), 'process.kill(2)')
    fixtureLink(context, join(root, 'bin'), join(root, 'a-bin'), 'dir')
    fixtureLink(context, outside, join(root, 'external'), 'dir')
    fixtureLink(context, join(outside, 'escape.mjs'), join(root, 'escape.mjs'), 'file')
    expectUndeclared(root, 'bin/helper.mjs', ['process.kill'])
    expect(scanHostPrimitives(root).perimeterFiles).toBe(1)
  })
})

describe('host primitive symlink boundaries', () => {
  it('accepts real-target declarations when the scanned root is a directory link', (context) => {
    const root = fixturePlugin()
    const holder = fixturePlugin()
    const declarations = fixturePlugin()
    writeFileSync(join(root, 'helper.mjs'), 'process.kill(1)')
    writeFileSync(join(declarations, 'helper.mjs.json'), '{"process.kill":1}')
    fixtureLink(context, root, join(holder, 'linked-root'), 'dir')
    const result = checkHostPrimitives(join(holder, 'linked-root'), loadHostPrimitiveAllowList(declarations))
    expect(result.violations).toEqual([])
    expect(result.exceeded).toBe(false)
  })

  it('does not bypass adapter or generated-source exemptions through a link', (context) => {
    const root = fixturePlugin()
    const adapter = join(root, 'bin', 'lib', 'host', 'adapter.mjs')
    const generated = join(root, 'bin', 'wt-observe.mjs')
    writeFileSync(adapter, 'process.kill(1)')
    writeFileSync(generated, 'process.kill(2)')
    fixtureLink(context, adapter, join(root, 'adapter.mjs'), 'file')
    fixtureLink(context, generated, join(root, 'generated.mjs'), 'file')
    expect(scanHostPrimitives(root)).toEqual({ perimeterFiles: 0, findings: [] })
  })

  it('ignores dangling links', (context) => {
    const root = fixturePlugin()
    fixtureLink(context, join(root, 'missing.mjs'), join(root, 'dangling.mjs'), 'file')
    expect(scanHostPrimitives(root)).toEqual({ perimeterFiles: 0, findings: [] })
  })
})

describe('relative module URL separator exemption', () => {
  it.each(['./lib/x.mjs', '../lib/x.mjs'])(
    'does not count relative module URL %s', (url) => {
      const root = fixturePlugin()
      writeFileSync(join(root, 'url.mjs'), `new URL(${JSON.stringify(url)}, import.meta.url)`)
      expect(checkHostPrimitives(root, new Map())).toMatchObject({ count: 0, exceeded: false })
    },
  )

  it.each([
    'const path = "./lib/x.mjs"', 'new URL("./lib/x.mjs", base)',
    'new OtherURL("./lib/x.mjs", import.meta.url)', 'new URL("/root/x.mjs", import.meta.url)',
    'new URL("C:\\\\lib\\\\x.mjs", import.meta.url)', 'const separator = "/"',
    'new URL("./lib/x.mjs", import.meta.url, extra)',
  ])('still counts other separator literal: %s', (source) => {
    const root = fixturePlugin()
    writeFileSync(join(root, 'path.mjs'), source)
    expectUndeclared(root, 'path.mjs', ['hard-coded path separator'])
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
