// top-level-throw.workflow.ts — negative fixture: module top level throws.
//
// bundleWorkflow evaluates the bundled IIFE in node:vm to extract meta; a
// top-level throw must surface as the actionable "failed to evaluate bundled
// IIFE" error, not as an unhandled crash.
import { defineWorkflow } from '../../src/define-workflow.js'

throw new Error('boom — deliberate top-level side effect')

// Unreachable, but keeps the file a structurally plausible workflow entry.
export default defineWorkflow({
  meta: {
    name: 'dwt-fixture-top-level-throw',
    description: 'Negative fixture — module top level throws',
  },
  run: async () => ({ ok: true }),
})
