import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildLspRoot, topLevelKeys } from '../../../scripts/build-lsp-root.mjs'

const temporaryDirectories: string[] = []

function fixture(packs: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lsp-root-'))
  temporaryDirectories.push(root)
  for (const [pack, declaration] of Object.entries(packs)) {
    const directory = join(root, 'plugin', 'packs', pack)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, '.lsp.json'), declaration)
  }
  return root
}

const valid = (command = 'server') => ({
  command,
  args: [],
  extensionToLanguage: { '.x': 'x' },
  diagnostics: true,
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('LSP root generator', () => {
  it('rejects duplicate declaration keys within one pack before JSON.parse collapses them', () => {
    const root = fixture({ alpha: `{"same":${JSON.stringify(valid())},"same":${JSON.stringify(valid('other'))}}` })
    expect(() => buildLspRoot(root)).toThrow('plugin/packs/alpha/.lsp.json: duplicate declaration key "same"')
  })

  it('rejects duplicate declaration keys across packs and names the refusing file', () => {
    const root = fixture({ alpha: JSON.stringify({ same: valid() }), beta: JSON.stringify({ same: valid('other') }) })
    expect(() => buildLspRoot(root)).toThrow('plugin/packs/beta/.lsp.json: duplicate declaration key "same"')
  })

  it.each([
    ['command', { args: [], extensionToLanguage: {}, diagnostics: true }, 'field command must be a string'],
    ['args', { command: 'server', extensionToLanguage: {}, diagnostics: true }, 'field args must be an array'],
    ['extensionToLanguage', { command: 'server', args: [], diagnostics: true }, 'field extensionToLanguage must be an object'],
    ['diagnostics', { command: 'server', args: [], extensionToLanguage: {}, diagnostics: 'yes' }, 'field diagnostics must be a boolean'],
    ['absent diagnostics', { command: 'server', args: [], extensionToLanguage: {} }, 'field diagnostics must be a boolean'],
  ])('rejects an invalid %s field and names the pack file', (_field, declaration, message) => {
    const root = fixture({ alpha: JSON.stringify({ alpha: declaration }) })
    expect(() => buildLspRoot(root)).toThrow(`plugin/packs/alpha/.lsp.json: declaration "alpha" ${message}`)
  })

  it('accepts diagnostics: false, a navigation-only server, and emits it unchanged', () => {
    const navigationOnly = { ...valid('nav'), diagnostics: false }
    const root = fixture({ typescript: JSON.stringify({ typescript: valid('ts') }), alpha: JSON.stringify({ alpha: navigationOnly }) })
    expect(JSON.parse(buildLspRoot(root)).alpha).toEqual(navigationOnly)
  })

  it('writes TypeScript first, then packs alphabetically, preserving written declaration order', () => {
    const root = fixture({
      zebra: JSON.stringify({ zebraSecond: valid('z2'), zebraFirst: valid('z1') }),
      typescript: JSON.stringify({ typescript: valid('ts') }),
      alpha: JSON.stringify({ alpha: valid('a') }),
    })
    expect(Object.keys(JSON.parse(buildLspRoot(root)))).toEqual(['typescript', 'alpha', 'zebraSecond', 'zebraFirst'])
  })

  it('emits pure two-space JSON with a trailing newline', () => {
    const root = fixture({ typescript: JSON.stringify({ typescript: valid('ts') }) })
    const output = buildLspRoot(root)
    expect(JSON.parse(output)).toEqual({ typescript: valid('ts') })
    expect(output).toBe(`${JSON.stringify({ typescript: valid('ts') }, null, 2)}\n`)
    expect(output).not.toContain('//')
  })
})

describe('top-level key scanner boundaries', () => {
  it('reads keys through escaped quotes and backslashes, nested objects, arrays, and strings not followed by a colon', () => {
    const text = '{"a\\"b": {"inner": "x", "deep": {"k": ":"}}, "c\\\\": ["not a key", {"nested": 1}], "d": "value: not a key", "e": 1}'
    expect(topLevelKeys(text, 'f')).toEqual(['a"b', 'c\\', 'd', 'e'])
  })

  it('refuses an unterminated string and reports the file', () => {
    expect(() => topLevelKeys('{"a": "open', 'plugin/packs/x/.lsp.json')).toThrow('plugin/packs/x/.lsp.json: unterminated JSON string')
  })

  it('refuses a duplicate key that differs only by escaping before JSON.parse can collapse it', () => {
    const root = fixture({ alpha: `{"s\\u0061me":${JSON.stringify(valid())},"same":${JSON.stringify(valid('other'))}}` })
    expect(() => buildLspRoot(root)).toThrow('duplicate declaration key "same"')
  })

  it('refuses a command that is a path rather than a bare executable name', () => {
    const root = fixture({ alpha: JSON.stringify({ alpha: { ...valid('/usr/local/bin/server') } }) })
    expect(() => buildLspRoot(root)).toThrow('field command must be a bare executable name')
    const windows = fixture({ alpha: JSON.stringify({ alpha: { ...valid('tools\\\\server.exe') } }) })
    expect(() => buildLspRoot(windows)).toThrow('field command must be a bare executable name')
  })
})
