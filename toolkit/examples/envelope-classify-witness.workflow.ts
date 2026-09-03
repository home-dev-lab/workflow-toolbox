import { defineWorkflow } from '@workflow-toolbox/build/define'
import { classifyAndAct, collectTrail } from '@workflow-toolbox/patterns'

// Matrix row 2 of the thin-envelope ladder (card 1850837979812070670): classifyAndAct with the
// classify role routed to workflow-toolbox:opencode-envelope, ONE item, one phase. The action
// role is routed to the envelope too so no Claude agent other than the envelope runs.
// Prediction written before the run: the classify role is a schema-enforced call; the envelope
// holds only Bash, answers with a MANIFEST line, so the native call exhausts to null, the
// salvage respawn (a second envelope) answers the same way, and the item is DROPPED with a
// salvage warning — agentTypes is the wrong vector for a structured role.
const WORKDIR = '/home/doublefx/projects/wt-suite/workflow-observatory'
const PLUGIN_ROOT = '/home/doublefx/projects/wt-suite/worktrees/card-1844561823-envelope-reap/plugin'
const HEAD = [`OPENCODE_WORKDIR: ${WORKDIR}`, `OPENCODE_PLUGIN_ROOT: ${PLUGIN_ROOT}`, ''].join('\n')

export default defineWorkflow({
  meta: {
    name: 'envelope-classify-witness',
    description: 'Witness run — classifyAndAct with the classify role (and the action role) on the thin envelope, one item, one phase',
    whenToUse: 'Only to measure the thin envelope inside classifyAndAct (envelope ladder, matrix row 2). Not a task workflow.',
    phases: [{ title: 'Route', detail: 'classifyAndAct — one envelope classifier then one envelope action' }],
  },
  run: async (rt) => {
    const step = await classifyAndAct(rt, {
      items: ['Paris is the capital of France.'],
      categories: ['fact', 'question'],
      classifyType: 'workflow-toolbox:opencode-envelope',
      classifyPrompt: (item) =>
        HEAD +
        [
          'Your prompt carries ONE task, id "classify", whose prompt is:',
          `"Classify this text as exactly one of: fact, question. Text: ${item}. Reply with ONLY a JSON object {\\"category\\":\\"fact\\"} or {\\"category\\":\\"question\\"}."`,
          'Run the script on it. Report the manifest path only — one line: MANIFEST: <path>.',
        ].join('\n'),
      actions: {
        fact: {
          agentType: 'workflow-toolbox:opencode-envelope',
          prompt: (item) => HEAD + `Your prompt carries ONE task, id "act-fact", whose prompt is: "Restate this fact in five words or fewer: ${item}". Run the script on it. Report the manifest path only — one line: MANIFEST: <path>.`,
        },
        question: {
          agentType: 'workflow-toolbox:opencode-envelope',
          prompt: (item) => HEAD + `Your prompt carries ONE task, id "act-question", whose prompt is: "Answer in five words or fewer: ${item}". Run the script on it. Report the manifest path only — one line: MANIFEST: <path>.`,
        },
      },
      phase: 'Route',
    })
    return { value: step.value, stats: step.stats, warnings: step.warnings, envelope: { trail: collectTrail(step) } }
  },
})
