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

  it('still never lets a table row declare, even with decoration inside it', () => {
    expect(hasDependsOnLine('| **Depends-on:** #100010 |')).toBe(false)
    expect(parseDependsOn('| - **Depends-on:** none |')).toEqual({ ids: [], unparseable: [] })
  })
})

describe('triageCardDependencies — the one rule the gate and the what-next skill share', () => {
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

  it('what-next lists no-line cards in their own "not checked" section with their ids, never drops them', () => {
    const text = read('plugin/skills/what-next/SKILL.md')
    expect(text).toContain('not checked: add a Depends-on line')
    expect(text).toContain('Never drop a card that has no `Depends-on:` line')
    expect(text).toContain('with its card id')
    expect(text).toContain('never recommend a card with no `Depends-on:` line')
  })

  it('what-next has one satisfiable output when no bench card qualifies: no Option handles, then not-checked or blocked chains', () => {
    const text = read('plugin/skills/what-next/SKILL.md')
    expect(text).toContain('When no bench card qualifies, say plainly that no card is startable')
    expect(text).toContain('emit no `Option N` handle')
    expect(text).toContain('Then emit the "not checked: add a Depends-on line" section if it exists; otherwise list the blocked chains')
  })

  it('D2: every bench card blocked means no not-checked section, because the section exists if and only if a card lacks the line', () => {
    const text = read('plugin/skills/what-next/SKILL.md')
    expect(text).toContain('Emit this section if and only if at least one `Next`/`Backlog` card has no `Depends-on:` line')
    // The contradiction this removes: one sentence demanding the section first whenever nothing qualifies.
    expect(text).not.toContain('lead with the "not checked: add a Depends-on line" section')
    expect(text).not.toContain('Omit the section only when every candidate card has a `Depends-on:` line')
  })
})
