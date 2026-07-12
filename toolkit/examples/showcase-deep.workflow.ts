// showcase-deep.workflow.ts — L3 DEEP-pipeline stage of demo-showcase-v2, the
// deepest, most varied level: generateAndFilter (Generate) + chunkedAnalysis
// (Chunk) + adversarialVerification (Verify) + loopUntilDone INNER (Refine-Inner).
//
// Every agent honors args.perAgent, defaulting to haiku + low. adversarialVerification
// pins its verifiers to BEST_MODEL internally, so the resolved model is passed to it
// EXPLICITLY (the same trick as all-patterns-workflow) — otherwise the knob would not
// reach that one pattern. A render fixture, not real work.

import { defineWorkflow, parseConfig } from '@workflow-toolbox/build/define'
import { withAgentDefaults } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, AgentDefaults, ModelAlias } from '@workflow-toolbox/runtime'
import {
  generateAndFilter,
  chunkedAnalysis,
  adversarialVerification,
  loopUntilDone,
  collectTrail,
} from '@workflow-toolbox/patterns'
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
  stage: 'deep'
  clusters: string | null
  envelope: { trail: TrailRecord[] }
}

async function run(rt0: WorkflowRuntime, input: StageInput): Promise<StageOutput> {
  const model: ModelAlias = input.perAgent?.model ?? 'haiku'
  const rt = withAgentDefaults(rt0, { effort: 'low', ...(input.perAgent ?? {}), model })

  rt.phase('Generate')
  const gen = await generateAndFilter(rt, {
    count: 2,
    generatePrompt: (i) => `Render demo. Write playful mascot tagline candidate #${i} (one short line).${GUARD}`,
    filterPrompt: (c) => `Render demo. Keep this tagline? Answer yes or no: "${c}".${GUARD}`,
    phase: 'Generate',
  })

  rt.phase('Chunk')
  const chunk = await chunkedAnalysis(rt, {
    input: 'LOVE the colors\nfont too small\nLOVE the mascot\nfont too small\nmascot is scary',
    maxChars: 24,
    analyzePrompt: (c, i, total) => `Render demo. Chunk ${i + 1}/${total}. Summarize the feedback themes in one short line:\n${c}${GUARD}`,
    synthesizePrompt: (parts) => `Render demo. Merge these ${parts.length} theme notes into one short "top clusters" line.${GUARD}`,
    phase: 'Chunk',
  })

  // adversarialVerification defaults its verifiers to BEST_MODEL; pass the resolved
  // model + low effort EXPLICITLY so the knob reaches it and the fixture stays cheap.
  rt.phase('Verify')
  const verify = await adversarialVerification(rt, {
    model,
    effort: 'low',
    claims: ['mascots boost recall', 'small fonts help reading'],
    renderClaim: (claim) => `Render demo. Decide if this claim is true, refuting if uncertain: "${claim}".${GUARD}`,
    phase: 'Verify',
  })

  rt.phase('Refine-Inner')
  const inner = await loopUntilDone<{ rounds: number }>(rt, {
    initial: { rounds: 0 },
    maxIterations: 2,
    body: async (rtBody, state, iteration) => {
      await rtBody.agent(`Render demo (inner polish), pass ${iteration}. Tighten the tagline into one snappier line.${GUARD}`, {
        label: `refine-inner:pass:${iteration}`,
      })
      return { state: { rounds: state.rounds + 1 }, done: iteration >= 1 }
    },
  })

  return {
    stage: 'deep',
    clusters: chunk.value,
    envelope: { trail: collectTrail(gen, chunk, verify, inner) },
  }
}

export default defineWorkflow({
  meta: {
    name: 'showcase-deep',
    description:
      'demo-showcase-v2 pipeline L3 deep stage: generateAndFilter + chunkedAnalysis + adversarialVerification + loopUntilDone (inner loop). Every agent honors args.perAgent, defaulting to haiku + low (passed explicitly to adversarialVerification). A render fixture, not real work.',
    whenToUse:
      'Runs as the single stage of the deepest (L3) nested pipeline of demo-showcase-v2 (or standalone as a render fixture). Not a real task workflow.',
    phases: [
      { title: 'Generate', detail: 'generateAndFilter — candidate taglines, filtered' },
      { title: 'Chunk', detail: 'chunkedAnalysis — map-reduce a feedback log into clusters' },
      { title: 'Verify', detail: 'adversarialVerification — refute-first verifier fan' },
      { title: 'Refine-Inner', detail: 'loopUntilDone INNER — intra-phase polish loop' },
    ],
  },
  parseInput,
  run,
})
