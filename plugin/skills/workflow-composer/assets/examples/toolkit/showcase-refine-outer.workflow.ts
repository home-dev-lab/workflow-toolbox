// showcase-refine-outer.workflow.ts — L1 ROOT final stage of demo-showcase-v2:
// loopUntilDone OUTER (a root-level polish loop) + a final synthesis agent. Every
// agent honors args.perAgent, defaulting to haiku + low. A render fixture, not real work.

import { defineWorkflow, parseConfig } from '@workflow-toolbox/build/define'
import { withAgentDefaults } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, AgentDefaults, ModelAlias } from '@workflow-toolbox/runtime'
import { loopUntilDone, collectTrail, makeRecord } from '@workflow-toolbox/patterns'
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
  stage: 'refine-outer'
  marker: 'DEMO_SHOWCASE_V2_PIPELINE_OK'
  finalLine: string | null
  envelope: { trail: TrailRecord[] }
}

async function run(rt0: WorkflowRuntime, input: StageInput): Promise<StageOutput> {
  const model: ModelAlias = input.perAgent?.model ?? 'haiku'
  const rt = withAgentDefaults(rt0, { effort: 'low', ...(input.perAgent ?? {}), model })

  rt.phase('Refine-Outer')
  const outer = await loopUntilDone<{ rounds: number }>(rt, {
    initial: { rounds: 0 },
    maxIterations: 2,
    body: async (rtBody, state, iteration) => {
      await rtBody.agent(`Render demo (outer polish), round ${iteration}. Refine the overall mascot brief into one crisp line.${GUARD}`, {
        label: `refine-outer:round:${iteration}`,
      })
      return { state: { rounds: state.rounds + 1 }, done: iteration >= 1 }
    },
  })

  rt.phase('Synthesize')
  const finalLine = await rt.agent(`Render demo. Write the ONE final mascot tagline for the campaign.${GUARD}`, {
    label: 'synthesize:final',
    phase: 'Synthesize',
  })
  const synthTrail = { trail: [makeRecord('synthesize:final', finalLine !== null, {})] }

  return {
    stage: 'refine-outer',
    marker: 'DEMO_SHOWCASE_V2_PIPELINE_OK',
    finalLine,
    envelope: { trail: collectTrail(outer, synthTrail) },
  }
}

export default defineWorkflow({
  meta: {
    name: 'showcase-refine-outer',
    description:
      'demo-showcase-v2 pipeline L1 root final stage: loopUntilDone OUTER (root-level polish loop) + a final synthesis agent. Every agent honors args.perAgent, defaulting to haiku + low. A render fixture, not real work.',
    whenToUse:
      'Runs as the last root stage of the demo-showcase-v2 orchestrator pipeline (or standalone as a render fixture). Not a real task workflow.',
    phases: [
      { title: 'Refine-Outer', detail: 'loopUntilDone OUTER — root-level polish loop' },
      { title: 'Synthesize', detail: 'one plain agent — the final campaign tagline' },
    ],
  },
  parseInput,
  run,
})
