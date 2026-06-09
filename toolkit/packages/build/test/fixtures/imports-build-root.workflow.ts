// imports-build-root.workflow.ts — NEGATIVE fixture: imports defineWorkflow
// from the package ROOT ('@workflow-toolbox/build') instead of the sandbox-pure
// '@workflow-toolbox/build/define' subpath. bundleWorkflow must reject this with an
// actionable error BEFORE esbuild dies on "Could not resolve node:vm".
import { defineWorkflow } from '@workflow-toolbox/build'

export default defineWorkflow({
  meta: {
    name: 'dwt-fixture-imports-build-root',
    description: 'Negative fixture proving the @workflow-toolbox/build root-import pre-flight check',
  },
  run: async () => ({ ok: true }),
})
