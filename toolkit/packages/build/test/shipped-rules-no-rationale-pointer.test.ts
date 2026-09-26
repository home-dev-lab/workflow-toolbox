// shipped-rules-no-rationale-pointer.test.ts — inverse lock for the retired rationale docs.
//
// The shipped rules are orders only: no rule keeps a pointer line into a rationale file, and
// the plugin ships no rationale bundle for such a pointer to resolve into. The repository
// history is the record of a rule's earlier text. This lock replaces the former referential
// gate over plugin/docs/rules-rationale/ (which asserted the opposite: that every pointer
// resolved).

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const RULES_DIR = join(REPO_ROOT, 'plugin/rules')

// Every form a rationale pointer has taken in a shipped rule.
const POINTER_FORMS: ReadonlyArray<[string, RegExp]> = [
  ['"Rationale and field cases" lead-in', /rationale and field cases/i],
  ['a docs/wt/ path', /docs\/wt\//],
  ['a rules-rationale path', /rules-rationale/],
]

function ruleFiles(): string[] {
  return readdirSync(RULES_DIR).filter((f) => f.endsWith('.md')).sort()
}

describe('shipped rules carry no rationale pointer', () => {
  it('finds the shipped rule files it scans', () => {
    expect(ruleFiles().filter((f) => f.startsWith('wt-')).length).toBeGreaterThan(10)
  })

  for (const file of ruleFiles()) {
    it(`${file}: no line points into a rationale file`, () => {
      const lines = readFileSync(join(RULES_DIR, file), 'utf8').split('\n')
      const hits = lines.flatMap((line, i) =>
        POINTER_FORMS.filter(([, re]) => re.test(line)).map(([form]) => `${file}:${i + 1} (${form}): ${line.trim()}`),
      )
      expect(hits, `rationale pointer(s) found:\n${hits.join('\n')}`).toEqual([])
    })
  }

  it('the plugin ships no rationale bundle', () => {
    expect(existsSync(join(REPO_ROOT, 'plugin/docs/rules-rationale'))).toBe(false)
  })

  it('wt-memory-hygiene no longer prescribes a rationale note with a pointer beside a rule', () => {
    const text = readFileSync(join(RULES_DIR, 'wt-memory-hygiene.md'), 'utf8')
    expect(text).not.toMatch(/a note, short pointer/)
    expect(text).toMatch(/repository history is the record/)
  })
})
