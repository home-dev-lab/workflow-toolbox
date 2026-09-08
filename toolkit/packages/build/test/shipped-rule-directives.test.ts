import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

function rule(name: string): string {
  return readFileSync(join(REPO_ROOT, 'plugin/rules', name), 'utf8')
}

describe('shipped rule directives', () => {
  it('requires report lessons in every hand-written executor-lane brief and prompt harvesting at integration', () => {
    const text = rule('wt-delegation-ladder.md')
    const briefing = text.slice(text.indexOf('## Briefing an executor'))

    expect(briefing).toContain('Every hand-written executor-lane brief requires `## Lessons for the memory`')
    expect(briefing).toContain('`None.` legitimate, alongside gate evidence')
    expect(briefing).toContain("At that lane's integration, harvest that one report")
  })

  it('requires the third review at a parallel-branch seam and gates on the merged tree', () => {
    const text = rule('wt-verify-by-ground-truth.md').replaceAll('\n', ' ')

    expect(text).toContain('Merging parallel branches requires THREE reviews: each branch, then their seam.')
    expect(text).toContain('Hold sibling branches and merge them together.')
    expect(text).toContain("the first mechanical checks that can judge the seam")
  })
})
