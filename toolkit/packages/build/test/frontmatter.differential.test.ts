import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error plugin runtime modules are untyped JavaScript.
import { parseFrontmatter } from '../../../../plugin/bin/lib/frontmatter.mjs'

describe('frontmatter differential', () => {
  it('R13 ships a runnable real-corpus differential tool', () => {
    expect(fs.existsSync(path.resolve(import.meta.dirname, '../../../scripts/frontmatter-corpus-diff.mjs'))).toBe(true)
  })
  it.each([
    'hooks:\n  Stop:\n    - hooks:\n        - type: prompt\n          prompt: "review"\n          timeout: 30',
    'allowed-tools:\n  [\n    "Read",\n    "Write"\n  ]',
    ...['\\0', '\\a', '\\b', '\\t', '\\n', '\\v', '\\f', '\\r', '\\e', '\\ ', '\\"', '\\/', '\\\\', '\\N', '\\_', '\\L', '\\P', '\\x00', '\\u2028', '\\U0001F600'].map((code) => `description: "before${code}after"`),
    'argument-hint: [system] [--source <path>]',
  ])('R13 corpus-shaped YAML %s', (block) => {
    const actual = parseFrontmatter(`---\nname: worker\n${block}\n---\n`)
    try {
      const expected = parse(`name: worker\n${block}`, { schema: 'failsafe', uniqueKeys: true, strict: true })
      expect(actual.ok).toBe(true)
      if (actual.ok) expect(actual.data).toEqual(expected)
    } catch (error) {
      if (error instanceof Error && error.name !== 'YAMLParseError') throw error
      expect(actual.ok).toBe(false)
    }
  })
  it('compares 2200 distinct seeded grammar documents with failsafe YAML in both directions', () => {
    const seed = 0x3fc129ab
    let state = seed
    const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0)
    const choices = [
      (n: number) => `description: words${n}\n  continued${n}`,
      (n: number) => `description: 'first${n}\n  second'`,
      (n: number) => `tools:\n- Read${n}\n- Grep`,
      (n: number) => `tools:\n  - Read${n}\n  - Grep`,
      (n: number) => `description: |+\n  text${n}\n\n`,
      (n: number) => `description: >-\n  text${n}\n  more`,
      (n: number) => `description: "first${n}\n  second"`,
      (n: number) => `"description": 'quoted # ${n}'`,
      (n: number) => `metadata:\n  inner:\n    label: label${n}`,
      (n: number) => `description: [one${n}, "two # more"]`,
      (n: number) => `description: words${n} # trailing comment`,
      (n: number) => `description: plain${n}\n  observer: impostor`,
      (n: number) => `description: @reserved${n}`,
      (n: number) => `description: &anchor${n}`,
      (n: number) => `description: name${n}\ndescription: repeated`,
      (n: number) => `description: line${n}\n\tbad: tab`,
      (n: number) => `description: text${n}\n---suffix`,
      (n: number) => `description: text${n}\n...`,
      (n: number) => `description: text${n}\n  # indented comment`,
      (n: number) => `description: Triggers include: item${n}`,
      (n: number) => `description: 'hash # ${n}'`,
      (n: number) => `description: |2- # header\n  text${n}`,
      (n: number) => `description:\n  inner: value${n}\n   shifted: hostile`,
      (n: number) => `'description': "double${n} # inside"`,
      (n: number) => `description: plain${n}\n...\n---\nname: second${n}`,
    ]
    const seen = new Set<string>()
    const counts = { subset: 0, accepted: 0, extension: 0, invalid: 0, anchors: 0, boundary: 0 }
    const defects: string[] = []
    for (let i = 0; i < 2200; i++) {
      const kind = (random() >>> 8) % choices.length
      const block = `name: worker${i}\n${choices[kind]!(i)}\n`
      seen.add(block)
      const actual = parseFrontmatter(`---\n${block}---\n`)
      const context = `seed=${seed} case=${i} kind=${kind} block=${JSON.stringify(block)}`
      const extension = kind === 19
      let expected: unknown
      let error: unknown
      try { expected = parse(block, { schema: 'failsafe', uniqueKeys: true, strict: true }) } catch (caught) { error = caught }
      if (kind === 24) {
        counts.boundary++
        // The second document starts after the first exact closing fence: it is body, not metadata.
        if (!actual.ok || !actual.body.startsWith(`name: second${i}`)) defects.push(`${context}: second document was parsed as metadata`)
      } else if (kind === 13) {
        counts.anchors++
        if (!actual.ok || JSON.stringify(actual.data) !== JSON.stringify(expected)) defects.push(`${context}: anchor mismatch`)
      } else if (extension) {
        counts.extension++
        if (error === undefined || !actual.ok || actual.data.description !== `Triggers include: item${i}`) defects.push(`${context}: colon extension mismatch`)
      } else if (error === undefined) {
        counts.subset++
        if (actual.ok) counts.accepted++
        if (!actual.ok || JSON.stringify(actual.data) !== JSON.stringify(expected)) defects.push(`${context}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
      } else {
        counts.invalid++
        if (actual.ok) defects.push(`${context}: invalid YAML accepted=${JSON.stringify(actual.data)}`)
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(2000)
    expect(counts.subset).toBeGreaterThan(1000)
    expect(defects.length, `${JSON.stringify(counts)}\n${defects.slice(0, 12).join('\n')}`).toBe(0)
    expect(counts.accepted / counts.subset, JSON.stringify(counts)).toBeGreaterThanOrEqual(0.9)
    expect(Object.values(counts).reduce((total, count, index) => index === 1 ? total : total + count, 0)).toBe(2200)
    expect(counts).toEqual({ subset: 1413, accepted: 1413, extension: 75, invalid: 522, anchors: 104, boundary: 86 })
  })
})
