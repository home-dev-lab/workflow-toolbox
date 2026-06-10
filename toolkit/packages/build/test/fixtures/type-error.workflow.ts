// type-error.workflow.ts — fixture with a DELIBERATE type error, used by the
// `workflow-toolbox build --typecheck` tests. esbuild strips types without checking, so a
// plain build succeeds on this file; --typecheck must reject it.
import { defineWorkflow } from '../../src/define-workflow.js'

export default defineWorkflow({
  meta: {
    name: 'wt-fixture-type-error',
    description: 'Fixture with a deliberate type error for --typecheck tests',
  },
  run: async (rt) => {
    // DELIBERATE: agent() options have no `generatorPrompt` field — the exact
    // plausible-but-wrong shape the typecheck flag exists to catch.
    const r = await rt.agent('hi', { generatorPrompt: 'nope' })
    return { r }
  },
})
