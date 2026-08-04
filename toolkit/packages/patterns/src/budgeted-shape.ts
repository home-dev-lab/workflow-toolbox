// budgeted-shape.ts — explicit declarations of reduced execution budgets.

/** One named stage in a budgeted reduction relative to a fuller reference
 *  workflow. */
export interface BudgetedStage {
  readonly name: string
  readonly fullBudget: number
  readonly reducedBudget: number
  readonly lost: readonly string[]
}

/** A named reduced execution shape and the reference workflow it is reducing. */
export interface BudgetedShape {
  readonly name: string
  readonly referenceWorkflow: string
  readonly stages: readonly BudgetedStage[]
}

/** Build a validated `BudgetedShape`, throwing IMMEDIATELY (not deferred to
 *  the first `describeBudgetedShape`/`budgetTotals` call) when any stage
 *  reduces its budget without declaring what was lost. Plain TS interfaces
 *  have no constructor to hook into — a caller who builds a `BudgetedShape`
 *  object literal directly and never calls `describeBudgetedShape` or
 *  `budgetTotals` on it bypasses that validation entirely. This factory is
 *  the "construction-time" enforcement point; `describeBudgetedShape` and
 *  `budgetTotals` keep validating too, as defense in depth for a shape built
 *  by hand rather than through this factory. */
export function makeBudgetedShape(shape: BudgetedShape): BudgetedShape {
  validateBudgetedShape(shape)
  return shape
}

/** Render a budgeted shape as a markdown table describing what was preserved,
 *  reduced, and explicitly given up at each stage. */
export function describeBudgetedShape(shape: BudgetedShape): string {
  validateBudgetedShape(shape)
  const lines = [
    '| stage | full budget | reduced budget | lost |',
    '| --- | --- | --- | --- |',
  ]

  for (const stage of shape.stages) {
    lines.push(
      `| ${escapeCell(stage.name)} | ${stage.fullBudget} | ${formatReducedBudget(stage.reducedBudget)} | ${formatLost(stage.lost)} |`,
    )
  }

  return lines.join('\n')
}

/** Sum the full and reduced budgets across all stages of one shape. */
export function budgetTotals(shape: BudgetedShape): { full: number; reduced: number } {
  validateBudgetedShape(shape)
  return shape.stages.reduce(
    (totals, stage) => ({
      full: totals.full + stage.fullBudget,
      reduced: totals.reduced + stage.reducedBudget,
    }),
    { full: 0, reduced: 0 },
  )
}

function validateBudgetedShape(shape: BudgetedShape): void {
  for (const stage of shape.stages) {
    if (stage.reducedBudget < stage.fullBudget && stage.lost.length === 0) {
      throw new Error(
        `budgetedShape: stage ${JSON.stringify(stage.name)} reduces budget from ${stage.fullBudget} to ${stage.reducedBudget} but declares no lost trade-off — every reduction must name what was given up`,
      )
    }
  }
}

function formatReducedBudget(reducedBudget: number): string {
  return reducedBudget === 0 ? '0 (inline)' : String(reducedBudget)
}

function formatLost(lost: readonly string[]): string {
  return lost.length === 0 ? 'none' : lost.map(escapeCell).join('; ')
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|')
}
