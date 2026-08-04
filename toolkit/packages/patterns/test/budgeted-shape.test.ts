import { describe, expect, it } from 'vitest'
import { budgetTotals, describeBudgetedShape, makeBudgetedShape } from '../src/budgeted-shape.js'
import { PR_REVIEW_BUDGETED_SHAPE } from '../examples/pr-review-budgeted-shape.js'

describe('budgetedShape', () => {
  it('renders the worked example as a markdown table containing all stages and budgets', () => {
    const rendered = describeBudgetedShape(PR_REVIEW_BUDGETED_SHAPE)

    expect(rendered).toContain('diff classification')
    expect(rendered).toContain('review lenses')
    expect(rendered).toContain('finding verification')
    expect(rendered).toContain('synthesis')
    expect(rendered).toContain('| 1 | 0 (inline) |')
    expect(rendered).toContain('| 6 | 3 |')
    expect(rendered).toContain('| 12 | 1 |')
  })

  it('sums the worked example budgets', () => {
    expect(budgetTotals(PR_REVIEW_BUDGETED_SHAPE)).toEqual({ full: 20, reduced: 4 })
  })

  it('throws when a reduced stage declares no lost trade-off', () => {
    expect(() =>
      describeBudgetedShape({
        name: 'invalid',
        referenceWorkflow: 'ref',
        stages: [
          { name: 'reduced', fullBudget: 2, reducedBudget: 1, lost: [] },
        ],
      }),
    ).toThrow(/declares no lost trade-off/i)
  })

  it('makeBudgetedShape validates IMMEDIATELY at construction, not deferred to first use', () => {
    expect(() =>
      makeBudgetedShape({
        name: 'invalid',
        referenceWorkflow: 'ref',
        stages: [{ name: 'reduced', fullBudget: 2, reducedBudget: 1, lost: [] }],
      }),
    ).toThrow(/declares no lost trade-off/i)

    // A valid shape passes through unchanged.
    expect(makeBudgetedShape(PR_REVIEW_BUDGETED_SHAPE)).toEqual(PR_REVIEW_BUDGETED_SHAPE)
  })

  it('escapes a pipe character inside a lost entry so it cannot corrupt the table', () => {
    const rendered = describeBudgetedShape({
      name: 'x',
      referenceWorkflow: 'ref',
      stages: [{ name: 'reduced', fullBudget: 2, reducedBudget: 1, lost: ['coverage | security'] }],
    })
    // The pipe is ESCAPED (backslash-pipe), not a real column separator — the
    // row still has exactly 4 data cells (name, full, reduced, lost).
    expect(rendered.split('\n')[2]).toBe('| reduced | 2 | 1 | coverage \\| security |')
  })
})
