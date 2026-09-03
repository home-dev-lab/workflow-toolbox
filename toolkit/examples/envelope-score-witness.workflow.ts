import { defineWorkflow } from '@workflow-toolbox/build/define'
import { collectTrail, scoreAndRank } from '@workflow-toolbox/patterns'

// Matrix row 4 of the thin-envelope ladder (card 1850837979812070670): scoreAndRank with the
// score role routed to workflow-toolbox:opencode-envelope, ONE item, ONE dimension, one phase.
// The schema wrapper asks the envelope for a JSON answer and parses its script-owned ANSWER line
// without injecting StructuredOutput into the envelope.
const WORKDIR = '/home/doublefx/projects/wt-suite/workflow-observatory'
const PLUGIN_ROOT = '/home/doublefx/projects/wt-suite/worktrees/card-1844561823-envelope-reap/plugin'
const HEAD = [`OPENCODE_WORKDIR: ${WORKDIR}`, `OPENCODE_PLUGIN_ROOT: ${PLUGIN_ROOT}`, ''].join('\n')

export default defineWorkflow({
  meta: {
    name: 'envelope-score-witness',
    description: 'Witness run — scoreAndRank with the score role on the thin envelope, one item, one dimension, one phase',
    whenToUse: 'Only to measure the thin envelope inside scoreAndRank (envelope ladder, matrix row 4). Not a task workflow.',
    phases: [{ title: 'Triage', detail: 'scoreAndRank — one envelope scorer then the rank + cutoff' }],
  },
  run: async (rt) => {
    const step = await scoreAndRank(rt, {
      items: ['Paris is the capital of France.'],
      scoreType: 'workflow-toolbox:opencode-envelope',
      dimensions: [
        {
          name: 'confidence',
          prompt: (item) =>
            HEAD +
            [
              'Your prompt carries ONE task, id "score", whose prompt is:',
              `"Score from 1 to 5 how confident you are that this statement is true: ${item}. Reply with ONLY a JSON object {\\"score\\": N, \\"reason\\": \\"...\\"}."`,
              'Run the script on it. Report every line the script prints verbatim.',
            ].join('\n'),
        },
      ],
      cutoff: { type: 'topK', k: 1 },
      phase: 'Triage',
    })
    return { value: step.value, stats: step.stats, warnings: step.warnings, envelope: { trail: collectTrail(step) } }
  },
})
