import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { acceptanceSection, containsPlanShape, planTaskIds, PLAN_SHAPE_DESCRIPTION } from '../../../../plugin/bin/lib/lifecycle-plan-shape.mjs'

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

## Card terms: reading chosen
- none: every term has one reading

## Acceptance
- Parser behavior is locked.
  Proof: lifecycle-plan-shape.test.ts
`

describe('lifecycle plan shape parser', () => {
  it.each([
    ['numbered', '1. baseline. DoD: locked\n2. regression. DoD: red\n3. safety. DoD: green', ['1', '2', '3']],
    ['bullet ids', '- T1 baseline. DoD: locked\n- A2 regression. DoD: red', ['T1', 'A2']],
    ['task headings', '### Task 3 safety\nDoD: green\n### T4 regression\nDefinition of done: red', ['3', 'T4']],
    ['group heading', '### Task 9 group\n- T2 child. DoD: green', ['T2']],
    ['idless items', '- implement safety. DoD: green\n### Another task\nDoD: locked', []],
    ['duplicate ids', '1. first. DoD: green\n1. second. DoD: green\n### Task 1 third\nDoD: green', ['1']],
    ['indented ids', '- task. DoD: green\n  - T1 nested detail\n  - win32 policy detail', []],
    ['prose outside Tasks', '- task. DoD: green\n\n## Notes\n- win32 platform detail', []],
    ['token boundary', '- T3suffix is not an id. DoD: green\n### T4suffix is not an id\nDoD: green', []],
    ['punctuated ids', '### Task 3.1 rollback\nDoD: green\n- T3-extra rollback. DoD: green\n### T4-extra rollback\nDoD: green', []],
    ['hierarchical heading id', '### Task 3.1 rollback\nDoD: green', []],
    ['colon boundaries', '- T3: rollback. DoD: green\n### Task 4: rollback\nDoD: green', ['T3', '4']],
    ['oversized ids', `${'1'.repeat(2000)}. implement. DoD: green\n- ${'T'.repeat(32)}1 implement. DoD: green\n### Task ${'2'.repeat(33)}\nDoD: green`, []],
    ['maximum ids', `${'1'.repeat(32)}. implement. DoD: green`, ['1'.repeat(32)]],
    ['backtick fenced examples', '1. implement. DoD: green\n```text\n9. example, not a task. DoD: demonstration\n```', ['1']],
    ['tilde fenced examples', '### Task 1 implement\nDoD: green\n~~~text\n9. example, not a task\n### T8 example\n~~~', ['1']],
    ['CRLF', '1. first. DoD: green\r\n### T2 second\r\nDoD: green', ['1', 'T2']],
  ])('derives explicit task ids from the accepted %s shape', (_shape, tasks, ids) => {
    const content = validPlan.replace(/## Tasks[\s\S]*?(?=\n## Gates)/, `## Tasks\n${tasks}\n`)
    expect(containsPlanShape(content, true)).toBe(true)
    expect(planTaskIds(content)).toEqual(ids)
  })

  it('derives explicit task ids only when a Tasks section exists', () => {
    expect(planTaskIds('1. outside a plan. DoD: green')).toEqual([])
  })

  it.each(['```', '~~~'])('rejects a plan whose only tasks are %s fenced examples', (fence) => {
    const content = validPlan.replace(/## Tasks[\s\S]*?(?=\n## Gates)/, `## Tasks\n${fence}\n9. example. DoD: demonstration\n${fence}\n`)
    expect(containsPlanShape(content, true)).toBe(false)
    expect(planTaskIds(content)).toEqual([])
  })

  it('enforces the mandatory Card terms section', () => {
    expect(PLAN_SHAPE_DESCRIPTION).toContain('a mandatory `## Card terms: reading chosen` section with one `- <card term, verbatim>: <the reading this plan chose>` line for each card Definition-of-done term open to more than one reading')
    expect(containsPlanShape(validPlan, true)).toBe(true)
    expect(containsPlanShape(validPlan.replace(/\n## Card terms:[\s\S]*?(?=\n## Acceptance)/, ''), true)).toBe(false)
  })

  it('stops the ADR block at the next level-two heading', () => {
    const content = validPlan
      .replace('Rejected: exercising the parser only through lifecycle transitions.\n', '')
      .replace('## Tasks', '## Tasks\nRejected: this belongs to the Tasks section.')

    expect(containsPlanShape(content, true)).toBe(false)
  })

  it('accepts an ADR section through the end of the document', () => {
    const adr = `## ADR
Decision: expose the existing parser seams.
Rejected: exercising the parser only through lifecycle transitions.`
    const content = `${validPlan.replace(`${adr}\n\n`, '')}\n${adr}`

    expect(containsPlanShape(content, true)).toBe(true)
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

    expect(containsPlanShape(content, true)).toBe(true)
  })
})
