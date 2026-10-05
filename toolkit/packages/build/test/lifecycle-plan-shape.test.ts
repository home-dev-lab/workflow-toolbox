import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import * as planShape from '../../../../plugin/bin/lib/lifecycle-plan-shape.mjs'

const { acceptanceSection, containsPlanShape, planShapeProblem, PLAN_SHAPE_DESCRIPTION } = planShape

const validPlan = `# Parser plan

## ADR
Decision: expose the existing parser seams.
Rejected: exercising the parser only through lifecycle transitions.

## Tasks
- Export the parser functions
  DoD: The functions can be imported by focused tests.
- Lock their behavior
  Definition of done: Every documented plan shape is covered.

## Quality coverage
Changed artefacts: parser helpers; unit tests and lint.
Seams: none: pure string parsing.

## Gates
- pnpm test

## State and recovery
Ownership: the runner owns validation.
Writers: the pilot finishes the plan before the runner reads it.
Terminal paths: refusal preserves the plan and lifecycle state.
Published data: N/A: no published records are modified.

## Card terms: reading chosen
- none: every term has one reading

## Acceptance
- Parser behavior is locked.
  Proof: lifecycle-plan-shape.test.ts
`

describe('lifecycle plan shape parser', () => {
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

const checkedHeadings = ['Quality coverage', 'Gates', 'State and recovery', 'Card terms: reading chosen']
const checkedLabels = [
  ['Quality coverage', 'Changed artefacts'],
  ['Quality coverage', 'Seams'],
  ['State and recovery', 'Ownership'],
  ['State and recovery', 'Writers'],
  ['State and recovery', 'Terminal paths'],
  ['State and recovery', 'Published data'],
] as const

function replaceSection(heading: string, replacement: string) {
  return validPlan.replace(new RegExp(`## ${heading}\\n[\\s\\S]*?(?=\\n## |$)`), replacement)
}

function expectProblem(content: string, name: string) {
  expect(containsPlanShape(content, true), `refuse missing or empty ${name}`).toBe(false)
  expect(planShapeProblem, 'a diagnostic names the missing or empty section or label').toBeTypeOf('function')
  expect(planShapeProblem(content, true)).toContain(name)
  expect(planShapeProblem(content, true)).toContain('example:')
}

describe('mandatory plan section presence and content', () => {
  it.each(checkedHeadings)('refuses a missing ## %s with a named diagnostic', (heading) => {
    expectProblem(replaceSection(heading, ''), heading)
  })

  it.each(checkedHeadings.flatMap((heading) => ['LF', 'CRLF'].map((ending) => [heading, ending])))('refuses empty ## %s (%s), including a following section', (heading, ending) => {
    const content = replaceSection(heading!, `## ${heading}\n\n`)
    expectProblem(ending === 'CRLF' ? content.replaceAll('\n', '\r\n') : content, heading!)
  })

  it.each(checkedHeadings)('refuses a ###-only ## %s body', (heading) => {
    expectProblem(replaceSection(heading, `## ${heading}\n### Details\n#### Evidence\n`), heading)
  })

  it.each(checkedHeadings.flatMap((heading) => ['N/A', 'N/A:', 'N/A —', 'N/A -', '**N/A**:'].map((body) => [heading, body])))('refuses bare N/A in ## %s: %s', (heading, body) => {
    expectProblem(replaceSection(heading!, `## ${heading}\n${body}\n`), heading!)
  })

  it.each([
    ['Gates', 'Gates (exit codes)'],
    ['State and recovery', 'State and recovery notes'],
    ['Quality coverage', 'Quality coverage notes'],
    ['Card terms: reading chosen', 'Card terms: reading chosen notes'],
  ])('refuses the near-miss heading for ## %s', (heading, nearMiss) => {
    expectProblem(validPlan.replace(`## ${heading}`, `## ${nearMiss}`), heading)
  })

  it.each(['```', '~~~'])('refuses a State and recovery heading present only inside %s fences', (fence) => {
    const content = `${replaceSection('State and recovery', '')}\n${fence}md\n## State and recovery\nN/A: example only\n${fence}\n`
    expectProblem(content, 'State and recovery')
  })

  it.each(checkedLabels)('refuses absent %s label %s', (heading, label) => {
    expectProblem(validPlan.replace(new RegExp(`^${label}:.*\\n`, 'm'), ''), `${label}: in ## ${heading}`)
  })

  it.each(checkedLabels)('refuses empty %s label %s', (heading, label) => {
    expectProblem(validPlan.replace(new RegExp(`^${label}:.*$`, 'm'), `${label}:`), `${label}: in ## ${heading}`)
  })

  it.each(checkedLabels)('refuses bare N/A as %s label %s', (heading, label) => {
    expectProblem(validPlan.replace(new RegExp(`^${label}:.*$`, 'm'), `${label}: N/A`), `${label}: in ## ${heading}`)
  })

  it('requires a term-and-reading line rather than prose in Card terms', () => {
    expectProblem(replaceSection('Card terms: reading chosen', '## Card terms: reading chosen\nEvery term is clear.\n'), 'Card terms: reading chosen')
    expectProblem(replaceSection('Card terms: reading chosen', '## Card terms: reading chosen\n- term:\n'), 'Card terms: reading chosen')
  })

  it('requires Quality coverage and State and recovery even without Acceptance', () => {
    for (const heading of ['Quality coverage', 'State and recovery']) {
      expect(containsPlanShape(replaceSection(heading, ''), false), heading).toBe(false)
    }
  })

  it.each(['N/A: no state boundaries touched', 'N/A — no state boundaries touched', 'N/A - no state boundaries touched', '**N/A**: no state boundaries touched'])('accepts a reasoned whole-section exemption: %s', (body) => {
    expect(containsPlanShape(replaceSection('State and recovery', `## State and recovery\n${body}\n`), true)).toBe(true)
  })

  it('requires all state labels when N/A is not the only content line', () => {
    expectProblem(replaceSection('State and recovery', '## State and recovery\nN/A: no state boundaries touched\nAdditional claim.\n'), 'Ownership:')
  })

  it('accepts bullets and bold labels and reasoned Published data N/A', () => {
    const content = checkedLabels.reduce((plan, [, label]) => plan.replace(`${label}:`, `- **${label}:**`), validPlan)
    expect(containsPlanShape(content, true)).toBe(true)
    expect(planShapeProblem(content, true)).toBeNull()
  })

  it('accepts a CRLF baseline and case-insensitive exact headings with trailing colon/spaces', () => {
    const content = checkedHeadings.reduce((plan, heading) => plan.replace(`## ${heading}`, `## ${heading.toUpperCase()}:  `), validPlan)
    expect(containsPlanShape(content.replaceAll('\n', '\r\n'), true)).toBe(true)
    expect(planShapeProblem(content, true)).toBeNull()
  })

  it.each(['```', '~~~'])('a fenced ## line does not truncate a real section (%s)', (fence) => {
    const content = validPlan.replace('Ownership:', `${fence}md\n## Example heading\n${fence}\nOwnership:`)
    expect(containsPlanShape(content, true)).toBe(true)
    expect(planShapeProblem(content, true)).toBeNull()
  })

  it('a shorter or different fence does not close the fenced example', () => {
    const content = `${replaceSection('State and recovery', '')}\n\`\`\`\`md\n\`\`\`\n~~~\n## State and recovery\nN/A: still fenced\n\`\`\`\`\n`
    expectProblem(content, 'State and recovery')
  })

  it('does not count an example label inside a fence as required coverage', () => {
    expectProblem(validPlan.replace('Seams: none: pure string parsing.', '```md\nSeams: none: example only\n```'), 'Seams:')
  })

  it('a level-one heading ends the checked section', () => {
    expectProblem(validPlan.replace('Ownership:', '# Appendix\nOwnership:'), 'State and recovery')
  })

  it.each(['## **Card terms:reading chosen**:', '##Card terms: reading chosen', '  ## **Card terms: reading chosen**:  '])('matches the level-two disputed-term heading grammar: %s', (heading) => {
    expect(containsPlanShape(validPlan.replace('## Card terms: reading chosen', heading), true)).toBe(true)
  })

  it('an optional Card terms heading still delimits State and recovery', () => {
    const content = validPlan
      .replace(/^Ownership:.*\n/m, '')
      .replace('## Card terms: reading chosen', '##Card terms: reading chosen\nOwnership: this belongs to Card terms')
    expect(containsPlanShape(content, false)).toBe(false)
    expect(planShapeProblem, 'a diagnostic names the misplaced state label').toBeTypeOf('function')
    expect(planShapeProblem(content, false)).toContain('Ownership:')
  })
})

describe('independent-review counterexamples (Astra round 1)', () => {
  it('refuses a bold Card terms entry whose reading is empty', () => {
    expectProblem(replaceSection('Card terms: reading chosen', '## Card terms: reading chosen\n- **parser:**\n'), 'Card terms: reading chosen')
  })

  it('refuses a Card terms entry whose reading is bare N/A', () => {
    expectProblem(replaceSection('Card terms: reading chosen', '## Card terms: reading chosen\n- parser: N/A\n'), 'Card terms: reading chosen')
  })

  it.each(['```', '~~~'])('refuses a Gates body made only of empty %s fence delimiters', (fence) => {
    expectProblem(replaceSection('Gates', `## Gates\n${fence}\n${fence}\n`), 'Gates')
  })

  it('accepts a Gates body whose gate sits inside a fence', () => {
    expect(planShapeProblem(replaceSection('Gates', '## Gates\n```sh\npnpm test\n```\n'), true)).toBeNull()
  })

  it('an indented level-two heading ends the checked section', () => {
    const content = validPlan.replace(/^Published data:.*\n/m, '').replace('## Card terms', '  ## Appendix\nPublished data: N/A: borrowed.\n\n## Card terms')
    expectProblem(content, 'Published data:')
  })

  it('refuses a Gates body made only of an indented level-three heading', () => {
    expectProblem(replaceSection('Gates', '## Gates\n  ### Required checks\n'), 'Gates')
  })

  it('accepts labels bulleted with +', () => {
    const content = checkedLabels.reduce((plan, [, label]) => plan.replace(`${label}:`, `+ ${label}:`), validPlan)
    expect(planShapeProblem(content, true)).toBeNull()
  })
})
