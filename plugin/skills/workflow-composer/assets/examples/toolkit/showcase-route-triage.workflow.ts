// showcase-route-triage.workflow.ts — L1 ROOT stage of the demo-showcase-v2
// orchestrator pipeline: classifyAndAct (Route) + scoreAndRank (Triage). Its raw
// output is the artifact a REAL human gate surfaces before the nested stage runs.
//
// Every agent honors args.perAgent (model/effort/agentType), defaulting to haiku +
// low effort, so the pipeline (which cannot inject per-stage model args) stays
// trivially cheap while a standalone launch can still retune it. A render fixture,
// not real work. (The perAgent plumbing is a stable ~2-line idiom repeated across
// the showcase stages — deliberate coincidental duplication in independent fixture
// workflows, not worth a published helper.)

import { defineWorkflow, parseConfig } from '@workflow-toolbox/build/define'
import { withAgentDefaults } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, AgentDefaults, ModelAlias } from '@workflow-toolbox/runtime'
import { classifyAndAct, scoreAndRank, collectTrail } from '@workflow-toolbox/patterns'
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
  stage: 'route-triage'
  route: string | null
  triageKept: number
  envelope: { trail: TrailRecord[] }
}

async function run(rt0: WorkflowRuntime, input: StageInput): Promise<StageOutput> {
  const model: ModelAlias = input.perAgent?.model ?? 'haiku'
  const rt = withAgentDefaults(rt0, { effort: 'low', ...(input.perAgent ?? {}), model })

  rt.phase('Route')
  const route = await classifyAndAct(rt, {
    items: ['a new mascot'],
    categories: ['playful', 'serious'],
    classifyPrompt: (item) => `Render demo. Classify the tone for "${item}": playful or serious. Return {"category":"..."}.${GUARD}`,
    actions: {
      playful: { prompt: (item) => `Render demo. "${item}" is playful — give a one-line upbeat brief.${GUARD}` },
      serious: { prompt: (item) => `Render demo. "${item}" is serious — give a one-line measured brief.${GUARD}` },
    },
    phase: 'Route',
  })

  rt.phase('Triage')
  const triage = await scoreAndRank(rt, {
    items: ['social', 'email', 'billboard'],
    dimensions: [
      { name: 'reach', prompt: (item) => `Render demo. Score the reach of "${item}" 1-5. Return {"score":N,"reason":"..."}.${GUARD}` },
    ],
    cutoff: { type: 'topK', k: 2 },
    phase: 'Triage',
  })

  return {
    stage: 'route-triage',
    route: route.value[0]?.category ?? null,
    triageKept: triage.value.length,
    envelope: { trail: collectTrail(route, triage) },
  }
}

export default defineWorkflow({
  meta: {
    name: 'showcase-route-triage',
    description:
      'demo-showcase-v2 pipeline L1 root stage: classifyAndAct (Route) + scoreAndRank (Triage). Its output is the artifact a human gate approves. Every agent honors args.perAgent, defaulting to haiku + low. A render fixture, not real work.',
    whenToUse:
      'Runs as the first stage of the demo-showcase-v2 orchestrator pipeline (or standalone as a render fixture). Not a real task workflow — the result is meaningless by design.',
    phases: [
      { title: 'Route', detail: 'classifyAndAct — one router then one handler' },
      { title: 'Triage', detail: 'scoreAndRank — cheap per-dimension scoring + cutoff' },
    ],
  },
  parseInput,
  run,
})
