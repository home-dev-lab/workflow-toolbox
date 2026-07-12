// showcase-plan.workflow.ts — L2 NESTED-pipeline stage of demo-showcase-v2:
// planAndExecute (planner → dynamic workers → synthesis). Every agent honors
// args.perAgent, defaulting to haiku + low. A render fixture, not real work.

import { defineWorkflow, parseConfig } from '@workflow-toolbox/build/define'
import { withAgentDefaults } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, AgentDefaults, ModelAlias } from '@workflow-toolbox/runtime'
import { planAndExecute, collectTrail } from '@workflow-toolbox/patterns'
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
  stage: 'plan'
  rollout: string | null
  envelope: { trail: TrailRecord[] }
}

async function run(rt0: WorkflowRuntime, input: StageInput): Promise<StageOutput> {
  const model: ModelAlias = input.perAgent?.model ?? 'haiku'
  const rt = withAgentDefaults(rt0, { effort: 'low', ...(input.perAgent ?? {}), model })

  rt.phase('Plan')
  const plan = await planAndExecute(rt, {
    planPrompt: `Render demo. Return a 3-item PLAN (do NOT implement) that splits "introduce the mascot" into 3 independent one-line steps.${GUARD}`,
    workerPrompt: (subtask, i) => `Render demo, step ${i}: ${subtask.description}. Reply in one short line.${GUARD}`,
    synthesisPrompt: (results) => `Render demo. Combine these ${results.length} step lines into one rollout summary.${GUARD}`,
    phase: 'Plan',
  })

  return {
    stage: 'plan',
    rollout: plan.value,
    envelope: { trail: collectTrail(plan) },
  }
}

export default defineWorkflow({
  meta: {
    name: 'showcase-plan',
    description:
      'demo-showcase-v2 pipeline L2 nested stage: planAndExecute (planner then dynamic workers then synthesis). Every agent honors args.perAgent, defaulting to haiku + low. A render fixture, not real work.',
    whenToUse:
      'Runs as a stage of the nested L2 pipeline of demo-showcase-v2 (or standalone as a render fixture). Not a real task workflow.',
    phases: [
      { title: 'Plan', detail: 'planAndExecute — planner then dynamic workers then synthesis' },
    ],
  },
  parseInput,
  run,
})
