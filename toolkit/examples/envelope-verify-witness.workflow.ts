import { defineWorkflow } from '@workflow-toolbox/build/define'
import { adversarialVerification, collectTrail } from '@workflow-toolbox/patterns'

// Matrix row 5 of the thin-envelope ladder (card 1850837979812070670): adversarialVerification
// with verifierType routed to workflow-toolbox:opencode-envelope, ONE claim, ONE vote, one phase.
// The pattern owns the verifier prompt; the envelope directives travel inside renderClaim's text.
// The schema wrapper asks the envelope for a JSON answer and parses its script-owned ANSWER line
// without injecting StructuredOutput into the envelope.
const WORKDIR = '/home/doublefx/projects/wt-suite/workflow-observatory'
const PLUGIN_ROOT = '/home/doublefx/projects/wt-suite/worktrees/card-1844561823-envelope-reap/plugin'
const HEAD = [`OPENCODE_WORKDIR: ${WORKDIR}`, `OPENCODE_PLUGIN_ROOT: ${PLUGIN_ROOT}`, ''].join('\n')

export default defineWorkflow({
  meta: {
    name: 'envelope-verify-witness',
    description: 'Witness run — adversarialVerification with the verifier role on the thin envelope, one claim, one vote, one phase',
    whenToUse: 'Only to measure the thin envelope inside adversarialVerification (envelope ladder, matrix row 5). Not a task workflow.',
    phases: [{ title: 'Verify', detail: 'adversarialVerification — one envelope verifier, one vote' }],
  },
  run: async (rt) => {
    const step = await adversarialVerification(rt, {
      claims: ['Paris is the capital of France.'],
      votes: 1,
      refuteThreshold: 1,
      verifierType: 'workflow-toolbox:opencode-envelope',
      renderClaim: (claim) =>
        HEAD +
        [
          'Your prompt carries ONE task, id "verify", whose prompt is:',
          `"Refute-first: try to refute this claim, then give a verdict among confirmed, partially-confirmed, refuted, unverifiable. Claim: ${claim}. Reply with ONLY a JSON object {\\"verdict\\": \\"...\\", \\"reason\\": \\"...\\"}."`,
          'Run the script on it. Report every line the script prints verbatim.',
        ].join('\n'),
      phase: 'Verify',
    })
    return { value: step.value, stats: step.stats, warnings: step.warnings, envelope: { trail: collectTrail(step) } }
  },
})
