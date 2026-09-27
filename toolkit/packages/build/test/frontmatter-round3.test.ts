import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { parseFrontmatter, splitFrontmatter } from '../../../../plugin/bin/lib/frontmatter.mjs'

const options = { schema: 'failsafe' as const, uniqueKeys: true, strict: true, maxAliasCount: 100, prettyErrors: false }
describe('YAML-equivalent frontmatter', () => {
  it('ships deterministic licensed yaml matching the declared dependency', () => {
    const repo = path.resolve(import.meta.dirname, '../../../..')
    const version = JSON.parse(fs.readFileSync(path.join(repo, 'toolkit/packages/build/package.json'), 'utf8')).devDependencies.yaml
    const vendor = fs.readFileSync(path.join(repo, 'plugin/bin/lib/vendor/yaml.mjs'), 'utf8')
    expect(vendor).toContain(`// generated from yaml@${version} by toolkit/scripts/vendor-yaml.mjs`)
    expect(vendor).toContain('Permission to use, copy, modify')
    expect(() => execFileSync('node', ['scripts/vendor-yaml.mjs', '--check'], { cwd: path.join(repo, 'toolkit') })).not.toThrow()
  })
  it.each([
    'name: pilot\t# worker', 'name: "pi\\\n  lot"',
    'description: >-\n  first\n\n  second', 'description: |2-\n    indented',
    'description: | # -\n  text', 'description: "first\n\n  second"',
    'description: first\n  second # comment', 'tools: [Read: Write]',
    'tools: [, Read]', 'hooks:\n  - type: prompt\n    type: command',
    'tools: [Read,\n  # comment\n  Write]', 'tools: [Read] # comment',
    '"name": pilot\ndescription: worker', '> Index hook detail ...: value',
    'metadata: &meta x',
  ])('matches failsafe YAML on %s', (block) => {
    const actual = parseFrontmatter(`---\n${block}\n---\n`)
    let expected: unknown
    let rejected = false
    try { expected = parse(block, options) } catch { rejected = true }
    expect(actual.ok).toBe(!rejected)
    if (actual.ok) expect(actual.data).toEqual(expected)
  })
  it('bounds the direct API before scanning a long unterminated block', () => {
    expect(parseFrontmatter(`---\n${'x'.repeat(70000)}`).reason).toBe('oversized')
    expect(splitFrontmatter(`---\n${'x'.repeat(70000)}`).reason).toBe('oversized')
  })
  it('does not drop a non-string tool when parsing succeeds', () => {
    const result = parseFrontmatter('---\ntools: [Read, null]\n---\n')
    expect(result).toMatchObject({ ok: true, data: { tools: ['Read', 'null'] } })
  })
  it('recognizes the documented colon extension and strips its trailing comment', () => {
    expect(parseFrontmatter('---\ndescription: Triggers include: X, Y # note\n---\n')).toMatchObject({ ok: true, extension: true, data: { description: 'Triggers include: X, Y' } })
  })
})
