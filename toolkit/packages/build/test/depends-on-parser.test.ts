import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hasDependsOnLine, parseDependsOn, triageCardDependencies } from '../../../../plugin/bin/lib/depends-on-parser.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

describe('shipped dependency convention (T4)', () => {
  it('parses none, multiple ids, decoration and declarations with no usable id', () => {
    expect(parseDependsOn('Depends-on: none')).toEqual({ ids: [], unparseable: [] })
    expect(parseDependsOn('**Depends-on: #100010, card 100020**')).toEqual({ ids: ['100010', '100020'], unparseable: [] })
    expect(parseDependsOn('> Depends-on: unresolved')).toEqual({ ids: [], unparseable: ['> Depends-on: unresolved'] })
    expect(hasDependsOnLine('`Depends-on: none')).toBe(true)
  })

  it('ignores table rows and empty descriptions', () => {
    expect(parseDependsOn('| Depends-on: #100010 |')).toEqual({ ids: [], unparseable: [] })
    expect(hasDependsOnLine('| Depends-on: #100010 |')).toBe(false)
    expect(parseDependsOn(undefined)).toEqual({ ids: [], unparseable: [] })
    expect(hasDependsOnLine('')).toBe(false)
  })

  it('strips a repeated leading decoration run, so a bulleted bold label declares', () => {
    expect(hasDependsOnLine('- **Depends-on:** #100010')).toBe(true)
    expect(parseDependsOn('- **Depends-on:** #100010')).toEqual({ ids: ['100010'], unparseable: [] })
    expect(parseDependsOn('> - `Depends-on:` #100010, #100020')).toEqual({ ids: ['100010', '100020'], unparseable: [] })
  })

  it('reads a bold-wrapped none as none, not as an unparseable declaration', () => {
    expect(parseDependsOn('**Depends-on:** none')).toEqual({ ids: [], unparseable: [] })
    expect(parseDependsOn('__Depends-on:__ none')).toEqual({ ids: [], unparseable: [] })
    expect(hasDependsOnLine('**Depends-on:** none')).toBe(true)
  })

  it('I2: accepts none only as the whole value, with trailing punctuation or a parenthesised note', () => {
    for (const line of ['Depends-on: none', '**Depends-on:** none', 'Depends-on: none.', 'Depends-on: none (standalone)', 'Depends-on: **none**', 'Depends-on: None (standalone).']) {
      expect(parseDependsOn(line), line).toEqual({ ids: [], unparseable: [] })
    }
    expect(parseDependsOn('Depends-on: none until #1875344230742754904 lands')).toEqual({ ids: [], unparseable: ['Depends-on: none until #1875344230742754904 lands'] })
    expect(parseDependsOn('Depends-on: none, #1875344230742754904')).toEqual({ ids: [], unparseable: ['Depends-on: none, #1875344230742754904'] })
    expect(parseDependsOn('Depends-on: none yet')).toEqual({ ids: [], unparseable: ['Depends-on: none yet'] })
    expect(triageCardDependencies([{ id: '100090', description: 'Depends-on: none until #100010 lands' }], new Set(['100010'])).blocked.map((c: { id: string }) => c.id)).toEqual(['100090'])
  })

  it('keeps the first 4+-digit run per comma segment, so a number in a title is not an id', () => {
    expect(parseDependsOn('Depends-on: #100010 (fix 2026 regression)')).toEqual({ ids: ['100010'], unparseable: [] })
  })

  it('C7: takes every #id in a segment, ignores ids inside parentheses, and accepts a bare id', () => {
    expect(parseDependsOn('Depends-on: #111111 #222222')).toEqual({ ids: ['111111', '222222'], unparseable: [] })
    expect(parseDependsOn('Depends-on: #1111 (fix #2222 regression)')).toEqual({ ids: ['1111'], unparseable: [] })
    expect(parseDependsOn('Depends-on: 1875344230742754904 (title 2024)')).toEqual({ ids: ['1875344230742754904'], unparseable: [] })
  })

  it('D1: a comma inside a parenthesised title never splits it, so an id mentioned there is not a dependency', () => {
    expect(parseDependsOn('Depends-on: #111111 (a title, #222222 is mentioned)')).toEqual({ ids: ['111111'], unparseable: [] })
    expect(parseDependsOn('Depends-on: #111111 (title, x), #333333')).toEqual({ ids: ['111111', '333333'], unparseable: [] })
  })

  it('an unclosed parenthesis holds the line as unparseable, never hides the ids after it', () => {
    for (const line of [
      'Depends-on: #111111 (unfinished title, #222222',
      'Depends-on: #111111 (fix :( regression), #222222 (t)',
      'Depends-on: #111111 (a title) (unfinished, 222222',
      'Depends-on: (#111111',
    ]) expect(parseDependsOn(line), line).toEqual({ ids: [], unparseable: [line] })
    expect(parseDependsOn('Depends-on: #111111 title) more')).toEqual({ ids: ['111111'], unparseable: [] })
  })

  it('still never lets a table row declare, even with decoration inside it', () => {
    expect(hasDependsOnLine('| **Depends-on:** #100010 |')).toBe(false)
    expect(parseDependsOn('| - **Depends-on:** none |')).toEqual({ ids: [], unparseable: [] })
  })
})

describe('triageCardDependencies — the one rule the actionability gate relies on', () => {
  const done = new Set(['100010'])
  const card = (id: string, description?: string) => ({ id, name: `card ${id}`, description })

  it('puts a card with no Depends-on line in notChecked and never in recommendable', () => {
    const result = triageCardDependencies([card('100020', 'Just some text')], done)
    expect(result.notChecked.map((c: { id: string }) => c.id)).toEqual(['100020'])
    expect(result.recommendable).toEqual([])
    expect(result.blocked).toEqual([])
  })

  it('recommends a Depends-on: none card and a card whose dependencies are all Done', () => {
    const result = triageCardDependencies([card('100030', 'Depends-on: none'), card('100040', 'Depends-on: #100010')], done)
    expect(result.recommendable.map((c: { id: string }) => c.id)).toEqual(['100030', '100040'])
    expect(result.notChecked).toEqual([])
  })

  it('blocks an unfinished dependency and an unparseable declaration', () => {
    const result = triageCardDependencies([card('100050', 'Depends-on: #100099'), card('100060', 'Depends-on: later')], done)
    expect(result.blocked.map((c: { id: string }) => c.id)).toEqual(['100050', '100060'])
    expect(result.recommendable).toEqual([])
  })

  it('uses the resolver it is given (a project parser) for ids, the shipped rule for the declaring line', () => {
    const resolveDeps = () => ({ ids: ['999999'], unparseable: [] })
    const result = triageCardDependencies([card('100070', 'Depends-on: none'), card('100080')], done, resolveDeps)
    expect(result.blocked.map((c: { id: string }) => c.id)).toEqual(['100070'])
    expect(result.notChecked.map((c: { id: string }) => c.id)).toEqual(['100080'])
  })
})

describe('text contract (locks the SKILL.md wording, not any model behaviour)', () => {
  // Whitespace-normalized, so re-wrapping a paragraph never breaks the contract.
  const read = (path: string) => readFileSync(`${REPO_ROOT}${path}`, 'utf8').replace(/\s+/g, ' ')

  it('planka-tracking writes Depends-on: none only when independence is known, never by default', () => {
    const text = read('plugin/skills/planka-tracking/SKILL.md')
    expect(text).toContain('Write `Depends-on: none` ONLY when you know the card is independent')
    expect(text).toContain('leave the line out and flag the card for the arbiter')
    expect(text).toContain('Never stamp `none` by default')
  })
})
