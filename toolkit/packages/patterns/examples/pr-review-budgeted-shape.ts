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
        '3 of 6 lenses dropped; the reduced form must name which 3 it kept and why (e.g. correctness, security, and the lens matching the diff\'s dominant file type)',
      ],
    },
    {
      name: 'finding verification',
      fullBudget: 12,
      reducedBudget: 1,
      lost: [
        'per-finding independent verification collapses to one verifier covering all findings; the single-vote-per-finding granularity is lost',
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
