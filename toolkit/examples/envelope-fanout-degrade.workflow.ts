import { defineWorkflow } from '@workflow-toolbox/build/define'
import { collectTrail, fanOutAndSynthesize } from '@workflow-toolbox/patterns'

// Rung 2, question 3 (degradation): same shape as envelope-fanout-witness but the synthesis
// task names a model that does not exist. Expected: the synthesis manifest records the task as
// failed with a reason; the pattern's own stats CANNOT see it (the envelope still returns its
// manifest line) — that asymmetry is the finding to record on the card.
// Original header of the witness follows.
// Rung 2 of the thin-envelope ladder (card 1850837979812070670): the REAL fanOutAndSynthesize
// pattern, one phase, both roles routed to workflow-toolbox:opencode-envelope. The task role
// receives ONE item (the source file) and the SCRIPT generates the ten external calls from it;
// the synthesis role receives the task's manifest line and asks the lane, in ONE inline task,
// to read the ten answer files and combine them. Claude agents: 2 (one Bash call each).
// External calls: 10 + 1. Witness = the two manifests on disk, never the run's green status.
const WORKDIR = '/home/doublefx/projects/wt-suite/workflow-observatory'
const SOURCE = `${WORKDIR}/.oc-each-witness.json`
const PLUGIN_ROOT = '/home/doublefx/projects/wt-suite/worktrees/card-1844561823-envelope-reap/plugin'

export default defineWorkflow({
  meta: {
    name: 'envelope-fanout-degrade',
    description: 'Degradation witness — fanOutAndSynthesize with both roles on the thin envelope: one script-generated batch of ten external calls, then one external synthesis over the answer files',
    whenToUse: 'Only to measure the thin envelope inside a real pattern (envelope ladder, rung 2). Not a task workflow.',
    phases: [
      { title: 'Batch', detail: 'fanOutAndSynthesize — one envelope task (ten script-generated calls) then one envelope synthesis' },
    ],
  },
  run: async (rt) => {
    const step = await fanOutAndSynthesize<string, string, string>(rt, {
      tasks: [SOURCE],
      taskType: 'workflow-toolbox:opencode-envelope',
      synthesisType: 'workflow-toolbox:opencode-envelope',
      taskPrompt: (source) =>
        [
          `OPENCODE_WORKDIR: ${WORKDIR}`,
          `OPENCODE_EACH_JSON: ${source}`,
          'OPENCODE_PROMPT_TEMPLATE: Reply with exactly one word: the capital city of {{item}}.',
          'OPENCODE_ID_TEMPLATE: capital-{{item}}',
          'OPENCODE_CONCURRENCY: 8',
          `OPENCODE_PLUGIN_ROOT: ${PLUGIN_ROOT}`,
          '',
          'Run the envelope once against that source. Do not open the source file, do not count its',
          'items, and do not write a tasks file — the script generates the tasks itself.',
          'Report the manifest path only — one line: MANIFEST: <path>. Do not open the manifest.',
        ].join('\n'),
      synthesisPrompt: (parts) =>
        [
          `OPENCODE_WORKDIR: ${WORKDIR}`,
          `OPENCODE_PLUGIN_ROOT: ${PLUGIN_ROOT}`,
          'OPENCODE_MODEL: openai/no-such-model-degrade-witness',
          '',
          'Your prompt carries ONE task. The line(s) below are manifest paths reported by the batch step:',
          ...parts.map((p) => `  ${p}`),
          '',
          'Write a tasks file with exactly one task, id "synthesis", whose prompt is:',
          '"Read the JSON manifest at <the manifest path above>. For each entry of its tasks array, read',
          'the file named by answerFile. Reply with exactly one line: the ten capitals, comma-separated,',
          'in the manifest order. No other text."',
          'Then run the script on it. Report the manifest path only — one line: MANIFEST: <path>.',
          'Do not read the batch manifest or any answer file yourself.',
        ].join('\n'),
      phase: 'Batch',
    })
    return { synthesis: step.value, stats: step.stats, envelope: { trail: collectTrail(step) } }
  },
})
