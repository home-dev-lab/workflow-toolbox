import { makeBudgetedShape } from '../src/budgeted-shape.js'

/** Worked example from the card's reframing comment: a named reduced PR-review
 *  shape that states exactly what was folded, dropped, or merged. */
export const PR_REVIEW_BUDGETED_SHAPE = makeBudgetedShape({
  name: 'pr-review-budgeted-shape',
  referenceWorkflow: 'pr-review',
  stages: [
    {
      name: 'diff classification',
      fullBudget: 1,
      reducedBudget: 0,
      lost: ['folded into the calling loop\'s own reasoning'],
    },
    {
      name: 'review lenses',
      fullBudget: 6,
      reducedBudget: 3,
      lost: [
        'reduced to the first 3 lenses of the diff\'s category; because `maintainability` is last in every four-lens category, the reduced form drops exactly the maintainability lens and nothing else (`docs` has only 3 lenses and is unchanged)',
      ],
    },
    {
      name: 'finding verification',
      fullBudget: 12,
      reducedBudget: 1,
      lost: [
        'independence from the FINDING\'S AUTHOR is preserved — the single verifier produced none of the findings',
        'independence BETWEEN verifications is lost: N verifier contexts collapse to 1, so one systematic misreading by that verifier now affects every verdict instead of one',
      ],
    },
    {
      name: 'synthesis',
      fullBudget: 1,
      reducedBudget: 0,
      lost: ['folded into the calling loop\'s own reasoning'],
    },
  ],
})
