// An agent that declares a watchdog (`observer:`) keeps it to itself: Claude Code otherwise pairs
// every sub-agent it spawns with its own copy of that watchdog (`observeSubagents` defaults to
// true), one extra observer per critic, reviewer or implementer. The property is asserted over
// every shipped agent definition that declares an observer, not over a list of known names, and
// likewise `omitClaudeMd: true` over every definition named as an observer.
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

function shippedDefinitions(): Array<{ file: string; front: string }> {
  const found: Array<{ file: string; front: string }> = []
  for (const dir of AGENT_DIRS) {
    for (const name of readdirSync(join(REPO_ROOT, dir)).filter((f) => f.endsWith('.md'))) {
      found.push({ file: `${dir}/${name}`, front: frontmatter(readFileSync(join(REPO_ROOT, dir, name), 'utf8')) })
    }
  }
  return found
}

function observedDefinitions(): Array<{ file: string; front: string }> {
  return shippedDefinitions().filter(({ front }) => /^observer:\s*\S/m.test(front))
}

// A watchdog is any shipped definition that another shipped definition names as its observer.
function watchdogDefinitions(): Array<{ file: string; front: string }> {
  const names = new Set(observedDefinitions().map(({ front }) => /^observer:\s*(\S+)/m.exec(front)![1]!))
  return shippedDefinitions().filter(({ front }) => names.has(/^name:\s*(\S+)/m.exec(front)?.[1] ?? ''))
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

// A watchdog judges digests from its own definition; the CLAUDE.md and rules prefix is a cost it
// does not need on every spawn.
describe('shipped watchdog definitions', () => {
  it('exist in the shipped set (the check below is not vacuous)', () => {
    expect(watchdogDefinitions().length).toBeGreaterThan(0)
  })

  it('run without the CLAUDE.md and rules prefix', () => {
    for (const { file, front } of watchdogDefinitions()) {
      expect(front, `${file} is a watchdog without omitClaudeMd: true`).toMatch(/^omitClaudeMd:\s*true\s*$/m)
    }
  })
})
