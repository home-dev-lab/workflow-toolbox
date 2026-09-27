import { describe, expect, it } from 'vitest'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { splitFrontmatter, parseFrontmatter, readFrontmatterFile } from '../../../../plugin/bin/lib/frontmatter.mjs'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parse as yamlParse } from 'yaml'

describe('shared frontmatter', () => {
  it.each([
    ['R1 scalar child masquerading as observer', 'name: x\ndescription: a\n  observer: w', false, null],
    ['R2 folded plain scalar', 'name: x\ndescription: first line\n  second line', true, 'first line second line'],
    ['R2 blank paragraph', 'name: x\ndescription: first line\n\n  second line', true, 'first line\nsecond line'],
    ['R2 invalid mapping in continuation', 'name: x\ndescription: first line\n  observer: w', false, null],
    ['R3 sequence at key indent', 'name: x\ntools:\n- Read\n- Grep', true, ['Read', 'Grep']],
    ['R4 multiline single quote', "name: x\ndescription: 'a\n  b'", true, 'a b'],
    ['R5 keep chomping', 'name: x\ndescription: |+\n  a\n\n', true, 'a\n\n\n'],
    ['R5 reserved indicator', 'name: x\ndescription: @bad', false, null],
    ['R5 reserved backtick', 'name: x\ndescription: `bad', false, null],
    ['R5 directive indicator', 'name: x\ndescription: %bad', false, null],
  ])('%s', (_label, block, ok, value) => {
    const result = parseFrontmatter(`---\n${block}\n---\n`)
    expect(result.ok).toBe(ok)
    if (ok) expect(result.data.description ?? result.data.tools).toEqual(value)
  })
  it.each([
    ['commented name', 'name: pilot # worker', 'name', 'pilot'],
    ['quoted name comment', 'name: "pilot" # c', 'name', 'pilot'],
    ['quoted observer key', '"observer": watchdog', 'observer', 'watchdog'],
    ['single quoted observer key', "'observer': watchdog", 'observer', 'watchdog'],
    ['indented document', '  observer: watchdog', 'observer', 'watchdog'],
    ['colon in description', 'description: Triggers include: X, Y', 'description', 'Triggers include: X, Y'],
    ['block scalar hides key', 'description: |\n  observer: watchdog', 'observer', undefined],
    ['multiline quoted hides key', 'description: "example\n  observer: watchdog\n  "', 'observer', undefined],
  ])('%s', (_title, yaml, key, wanted) => {
    const result = parseFrontmatter(`---\n${yaml}\n---\nbody`)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data[key]).toBe(wanted)
  })

  it('BOM, CRLF and exact closing fence', () => {
    const result = parseFrontmatter('\uFEFF---\r\nname: pilot\r\n---suffix\r\nobserver: watchdog\r\n---\r\nbody')
    expect(result.ok).toBe(false)
    expect(splitFrontmatter('\uFEFF---\r\nname: pilot\r\n---suffix\r\nobserver: watchdog\r\n---\r\nbody')).toMatchObject({ ok: true, hadBom: true })
  })

  it('R10 preserves sibling tools across deeply nested hooks sequences and opaque nested values', () => {
    const result = parseFrontmatter('---\nname: worker\nhooks:\n  Stop:\n    - hooks:\n        - type: prompt\n          prompt: "check"\n          timeout: 30\n    - hooks:\n        - type: command\n          command: [one, {complex: value}]\ntools: [Read, Grep]\n---\n')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.tools).toEqual(['Read', 'Grep'])
      expect(result.data.hooks.Stop[0].hooks[0]).toEqual({ type: 'prompt', prompt: 'check', timeout: '30' })
      expect(result.data.hooks.Stop[1].hooks[0].command).toEqual(['one', { complex: 'value' }])
    }
  })

  it('R10 reads multi-line flow sequences', () => {
    const result = parseFrontmatter('---\nallowed-tools:\n  [\n    "Read",\n    "Write"\n  ]\nname: worker\n---\n')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data['allowed-tools']).toEqual(['Read', 'Write'])
  })

  it('R10 isolates an unsupported first field within a sequence mapping', () => {
    const result = parseFrontmatter('---\nhooks:\n  Stop:\n    - command: {complex: value}\n      type: prompt\nname: worker\n---\n')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.hooks.Stop[0].command).toEqual({ complex: 'value' })
      expect(result.data.hooks.Stop[0].type).toBe('prompt')
      expect(result.data.name).toBe('worker')
    }
  })

  it('R10 preserves identity when a tools flow contains an unsupported mapping', () => {
    const result = parseFrontmatter('---\nname: worker\ndescription: does work\ntools: [Read, {custom: true}]\nobserver: watchdog\n---\n')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.tools).toEqual(['Read', { custom: 'true' }])
      expect(result.data.observer).toBe('watchdog')
    }
  })

  it('R11 rejects a second unquoted bracket pair inside a flow sequence', () => {
    expect(parseFrontmatter('---\nargument-hint: [system] [--source <path>]\n---\n').ok).toBe(false)
  })

  it.each(['\\0', '\\a', '\\b', '\\t', '\\n', '\\v', '\\f', '\\r', '\\e', '\\ ', '\\"', '\\/', '\\\\', '\\N', '\\_', '\\L', '\\P', '\\x00', '\\u2028', '\\U0001F600'])('R12 YAML double-quoted escape %s', (escape) => {
    const block = `description: "before${escape}after"`
    const expected = yamlParse(block, { schema: 'failsafe' }).description
    const result = parseFrontmatter(`---\n${block}\n---\n`)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.description).toBe(expected)
  })

  it('unterminated and absent fences', () => {
    expect(splitFrontmatter('---\nname: pilot')).toMatchObject({ ok: false, reason: 'unterminated' })
    expect(splitFrontmatter('name: pilot')).toMatchObject({ ok: false, reason: 'absent' })
  })

  it('rejects non-regular files, oversized headers, and a failed close', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-reader-'))
    try {
      expect(readFrontmatterFile(root).reason).toBe('not-regular')
      const file = path.join(root, 'large.md')
      fs.writeFileSync(file, `---\nname: ${'x'.repeat(120)}\n---\n`)
      expect(readFrontmatterFile(file, { maxBytes: 30 }).reason).toBe('oversized')
      expect(readFrontmatterFile(file, { fs: { ...fs, closeSync: () => { throw Error('close failed') } } }).reason).toBe('io-error')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('reads the shipped agent and skill corpus', () => {
    const plugin = path.resolve(import.meta.dirname, '../../../../plugin')
    const inputs = ['agents', 'agent-templates', 'launch-agents', 'skills']
    for (const dir of inputs) {
      const root = path.join(plugin, dir)
      if (!fs.existsSync(root)) continue
      const visit = (folder: string) => {
        for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
          const file = path.join(folder, item.name)
          if (item.isDirectory()) visit(file)
          else if (dir === 'skills' ? item.name === 'SKILL.md' : item.name.endsWith('.md')) {
            const source = fs.readFileSync(file, 'utf8')
            if (!source.startsWith('---')) continue
            const actual = parseFrontmatter(source)
            expect(actual.ok, file).toBe(true)
            if (actual.ok) {
              const block = source.match(/^---\r?\n([\s\S]*?)^---[ \t]*\r?$/m)?.[1]
              expect(block, file).toBeDefined()
              const options = { schema: 'failsafe' as const, uniqueKeys: true, strict: true }
              const rejected = new Map<string, string>()
              const validLines = block!.split(/\r?\n/).filter((line) => {
                const field = /^([^\s#:'"\[\]{}][^:]*):[ \t]+(.*)$/.exec(line)
                if (!field) return true
                try { yamlParse(line, options); return true } catch {
                  rejected.set(field[1]!, field[2]!.replace(/[ \t]+#.*$/, '').trimEnd())
                  return false
                }
              })
              const expected = yamlParse(actual.extension ? validLines.join('\n') : block!, options) ?? {}
              for (const key of ['name', 'description', 'tools', 'observer']) {
                const value = actual.extension && rejected.has(key) ? rejected.get(key) : expected[key]
                expect(actual.data[key], `${file}: ${key}`).toEqual(value)
              }
            }
          }
        }
      }
      visit(root)
    }
  })
})
