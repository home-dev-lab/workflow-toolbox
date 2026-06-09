// hello.workflow.ts — minimal valid workflow fixture for Batch B tests.
//
// Imports defineWorkflow via relative path (the .js extension is required for
// ESM/bundler resolution — esbuild resolves .ts from the .js specifier).
import { defineWorkflow } from '../../src/define-workflow.js'

export default defineWorkflow({
  meta: {
    name: 'dwt-fixture-hello',
    description: 'Minimal fixture workflow for @dwt/build Batch B tests',
    phases: [{ title: 'Run' }],
  },
  parseInput: (raw: unknown): string => {
    if (typeof raw === 'string') return raw
    if (raw === undefined || raw === null) return 'world'
    return String(raw)
  },
  run: async (rt, input) => {
    rt.phase('Run')
    const r = await rt.agent('say hello to ' + input, { label: 'hello' })
    rt.log('agent said: ' + String(r))
    return { greeting: r }
  },
})
