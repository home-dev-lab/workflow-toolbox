import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { acceptanceSection, containsPlanShape, planSection } from '../../../../plugin/bin/lib/lifecycle-state-machine.mjs'

const validPlan = `# Parser plan

## ADR
Decision: expose the existing parser seams.
Rejected: exercising the parser only through lifecycle transitions.

## Tasks
- Export the parser functions
  DoD: The functions can be imported by focused tests.
- Lock their behavior
  Definition of done: Every documented plan shape is covered.

## Gates
- pnpm test

## Acceptance
- Parser behavior is locked.
  Proof: lifecycle-plan-shape.test.ts
`

describe('lifecycle plan shape parser', () => {
  it('extracts a well-formed ADR block and stops at the next level-two heading', () => {
    const section = planSection(validPlan, 'ADR')

    expect(section).toContain('Decision: expose the existing parser seams.')
    expect(section).toContain('Rejected: exercising the parser only through lifecycle transitions.')
    expect(section).not.toContain('## Tasks')
  })

  it('extracts an ADR section through the end of the document', () => {
    const content = `# Parser plan

## ADR
Decision: keep the parser small.
Rejected: adding a markdown dependency.`

    expect(planSection(content, 'ADR')).toBe(`\n## ADR
Decision: keep the parser small.
Rejected: adding a markdown dependency.`)
  })

  it('accepts column-zero bullet tasks with either DoD label', () => {
    expect(containsPlanShape(validPlan, true)).toBe(true)
  })

  it('accepts numbered tasks with definitions of done', () => {
    const content = validPlan.replace(
      `- Export the parser functions
  DoD: The functions can be imported by focused tests.
- Lock their behavior
  Definition of done: Every documented plan shape is covered.`,
      `1. Export the parser functions
   DoD: The functions can be imported by focused tests.
2. Lock their behavior
   Definition of done: Every documented plan shape is covered.`,
    )

    expect(containsPlanShape(content, true)).toBe(true)
  })

  it('counts a task subheading with no list item under it as a task', () => {
    const content = validPlan.replace(
      `- Export the parser functions
  DoD: The functions can be imported by focused tests.
- Lock their behavior
  Definition of done: Every documented plan shape is covered.`,
      `### Export the parser functions
DoD: The functions can be imported by focused tests.

An explanatory paragraph belongs to the task.`,
    )

    expect(containsPlanShape(content, true)).toBe(true)
  })

  it('extracts Acceptance only up to the next heading at any level', () => {
    const content = `${validPlan}
### Appendix
This is not acceptance evidence.`

    expect(acceptanceSection(content)).toContain('Proof: lifecycle-plan-shape.test.ts')
    expect(acceptanceSection(content)).not.toContain('Appendix')
  })

  it('returns an empty string when Acceptance is absent', () => {
    expect(acceptanceSection(validPlan.replace(/\n## Acceptance[\s\S]*$/, ''))).toBe('')
  })

  it('rejects a plan without Acceptance when Acceptance is required', () => {
    const content = validPlan.replace(/\n## Acceptance[\s\S]*$/, '')

    expect(containsPlanShape(content, true)).toBe(false)
  })

  it('accepts a plan without Acceptance when Acceptance is optional', () => {
    const content = validPlan.replace(/\n## Acceptance[\s\S]*$/, '')

    expect(containsPlanShape(content, false)).toBe(true)
  })

  it('rejects a plan when one task carries no definition of done', () => {
    // The refusal every real FULL run met: one task without a DoD line fails the whole plan.
    const content = validPlan.replace('  Definition of done: Every documented plan shape is covered.\n', '')
    expect(content).not.toContain('Every documented plan shape')
    expect(containsPlanShape(content, true)).toBe(false)
  })

  it('rejects an ADR missing the Rejected rationale', () => {
    const content = validPlan.replace('Rejected: exercising the parser only through lifecycle transitions.\n', '')

    expect(containsPlanShape(content, true)).toBe(false)
  })

  it('matches plan section headings case-insensitively', () => {
    const content = validPlan
      .replace('## ADR', '## adr')
      .replace('## Tasks', '## tasks')
      .replace('## Gates', '## gates')
      .replace('## Acceptance', '## acceptance')

    expect(planSection(content, 'ADR')).toContain('## adr')
    expect(containsPlanShape(content, true)).toBe(true)
  })
})
