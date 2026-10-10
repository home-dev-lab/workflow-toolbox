// An agent that declares a watchdog (`observer:`) keeps it to itself: Claude Code otherwise pairs
// every sub-agent it spawns with its own copy of that watchdog (`observeSubagents` defaults to
// true), one extra observer per critic, reviewer or implementer. The property is asserted over
// every shipped agent definition that declares an observer, not over a list of known names.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const AGENT_DIRS = ['plugin/agent-templates', 'plugin/launch-agents/agents']

function frontmatter(source: string): string {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source)
  return match ? match[1]! : ''
}

function observedDefinitions(): Array<{ file: string; front: string }> {
  const found: Array<{ file: string; front: string }> = []
  for (const dir of AGENT_DIRS) {
    for (const name of readdirSync(join(REPO_ROOT, dir)).filter((f) => f.endsWith('.md'))) {
      const front = frontmatter(readFileSync(join(REPO_ROOT, dir, name), 'utf8'))
      if (/^observer:\s*\S/m.test(front)) found.push({ file: `${dir}/${name}`, front })
    }
  }
  return found
}

describe('observed agent definitions', () => {
  it('exist in the shipped set (the check below is not vacuous)', () => {
    expect(observedDefinitions().length).toBeGreaterThan(0)
  })

  it('never hand their watchdog down to the sub-agents they spawn', () => {
    for (const { file, front } of observedDefinitions()) {
      expect(front, `${file} declares an observer without observeSubagents: false`).toMatch(/^observeSubagents:\s*false\s*$/m)
    }
  })
})
