import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = new URL('../../../../', import.meta.url)
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, root)), 'utf8')

describe('lane waiter outcome guidance', () => {
  it.each(['plugin/agent-templates/pilot.md', 'plugin/launch-agents/agents/pilot.md'])('explains abandonment causes and decision state in %s', (file) => {
    const text = read(file)
    expect(text).toContain('LANE DONE exit=126 cause=timeout')
    for (const cause of ['idle', 'owner', 'grace-error']) expect(text).toContain(`cause=${cause}`)
    for (const field of ['state=decision-needed', 'state=terminating', 'timeoutAt', 'decisionDueAt']) expect(text).toContain(field)
    expect(text).not.toContain('no dedicated terminal timeout record exists')
  })

  it('documents bounded exit pass-through and recorded abandonment in the skill', () => {
    const text = read('plugin/skills/external-lane/SKILL.md')
    expect(text).toContain('0–255')
    expect(text).toContain('outside that range return 1')
    expect(text).toContain('cause=timeout')
    expect(text).toContain('decisionSource')
  })

  it('announces the parser break and coordinated re-adoption', () => {
    // Find the section by the entry it must carry: the heading holding it is `## [Unreleased]` before the release and
    // `## [<version>]` after it, and the entry itself does not move.
    const sections = read('plugin/CHANGELOG.md').split('\n## ')
    const text = sections.find((section) => section.includes('`LANE TIMEOUT exit=124` is removed')) ?? ''
    expect(text).toContain('Breaking')
    expect(text).toContain('`LANE TIMEOUT exit=124` is removed')
    expect(text).toMatch(/`LANE DIED`[\s\S]{0,100}125/)
    expect(text).toMatch(/re-adopt the scripts and the pilot template together/i)
  })
})
