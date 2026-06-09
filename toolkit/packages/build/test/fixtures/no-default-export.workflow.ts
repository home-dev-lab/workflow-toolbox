// no-default-export.workflow.ts — negative fixture: no default export.
//
// bundleWorkflow should reject this with an actionable error telling the
// developer the entry file must `export default defineWorkflow({...})`.
import { defineWorkflow } from '../../src/define-workflow.js'

// Named export only — intentionally missing `export default`
export const myWorkflow = defineWorkflow({
  meta: {
    name: 'dwt-fixture-no-default',
    description: 'Negative fixture — named export only, no default export',
  },
  run: async () => ({ ok: true }),
})
