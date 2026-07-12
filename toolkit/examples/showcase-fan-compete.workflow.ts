// showcase-fan-compete.workflow.ts — L2 NESTED-pipeline stage of demo-showcase-v2:
// fanOutAndSynthesize (scatter-gather) + tournament (judge panel). Every agent
// honors args.perAgent, defaulting to haiku + low. A render fixture, not real work.

import { defineWorkflow, parseConfig } from '@workflow-toolbox/build/define'
import { withAgentDefaults } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, AgentDefaults, ModelAlias } from '@workflow-toolbox/runtime'
import { fanOutAndSynthesize, tournament, collectTrail } from '@workflow-toolbox/patterns'
import type { TrailRecord } from '@workflow-toolbox/patterns'

const GUARD =
  ' IMPORTANT: render demo — reply with a short line of TEXT ONLY. Do NOT use any tools, and do NOT create, modify, or delete any files.'

export interface StageInput {
  perAgent: AgentDefaults | null
}

function parseInput(raw: unknown): StageInput {
  const obj = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return { perAgent: parseConfig(obj).perAgent ?? null }
}

interface StageOutput {
  stage: 'fan-compete'
  brief: string | null
  tagline: string | null
  envelope: { trail: TrailRecord[] }
}

async function run(rt0: WorkflowRuntime, input: StageInput): Promise<StageOutput> {
  const model: ModelAlias = input.perAgent?.model ?? 'haiku'
  const rt = withAgentDefaults(rt0, { effort: 'low', ...(input.perAgent ?? {}), model })

  rt.phase('Fan')
  const fan = await fanOutAndSynthesize(rt, {
    tasks: ['colors', 'personality', 'catchphrase'],
    taskPrompt: (task, i) => `Render demo, angle ${i}. One short idea about the mascot's ${task}.${GUARD}`,
    synthesisPrompt: (parts) => `Render demo. Fuse these ${parts.length} angle notes into one mascot brief line.${GUARD}`,
    phase: 'Fan',
  })

  rt.phase('Compete')
  const compete = await tournament(rt, {
    angles: ['bold', 'whimsical'],
    attemptPrompt: (angle, i) => `Render demo, attempt ${i}. Write a ${angle} mascot tagline (one short line).${GUARD}`,
    judgePrompt: (attempt) => `Render demo. Score this tagline 1-10: "${attempt}".${GUARD}`,
    synthesisPrompt: (ranked) => `Render demo. From the best of ${ranked.length} taglines, write the final one line.${GUARD}`,
    phase: 'Compete',
  })

  return {
    stage: 'fan-compete',
    brief: fan.value,
    tagline: compete.value,
    envelope: { trail: collectTrail(fan, compete) },
  }
}

export default defineWorkflow({
  meta: {
    name: 'showcase-fan-compete',
    description:
      'demo-showcase-v2 pipeline L2 nested stage: fanOutAndSynthesize (scatter-gather) + tournament (judge panel). Every agent honors args.perAgent, defaulting to haiku + low. A render fixture, not real work.',
    whenToUse:
      'Runs inside the nested L2 pipeline of demo-showcase-v2 (or standalone as a render fixture). Not a real task workflow.',
    phases: [
      { title: 'Fan', detail: 'fanOutAndSynthesize — scatter angle workers, gather one brief' },
      { title: 'Compete', detail: 'tournament — attempts, judges, synthesis funnel' },
    ],
  },
  parseInput,
  run,
})
