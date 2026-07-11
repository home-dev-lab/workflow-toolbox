// wt-shape-e2e.workflow.ts — the STANDARD CHEAP VEHICLE for observe-side e2e runs.
//
// Purpose: any e2e that needs a real multi-phase run (live shape, SSE, reload, attach,
// per-agent chips) launches THIS, never a real workflow. Every agent is pinned to
// model 'haiku' + effort 'low' IN THE SOURCE — not knobs someone can forget: a run
// launched only to exercise the observe side does trivial agent work, and without
// explicit pins it inherits the SESSION model + effort (observed 2026-07-10: one
// loop-demo e2e run ≈ 950k tokens on a top-tier session, ×4 in a morning, for agents
// whose whole job was scoring a placeholder 1-5). See the project rule
// `how-to-launch-workflows.md` § "E2E/DEMO runs".
//
// Shape (deliberate): three phases exercising the surfaces the observe e2e checks —
// a fan-out pattern column (Gen), a second pattern column with a gate (Rank), and a
// plain single-agent column (Wrap). Every stage passes an EXPLICIT effort, so a
// completed run's envelope trail carries `effort` on every record — this doubles as
// the fixture for the per-agent effort chip (agent panel) and the effort tiering demo.
// Prompts are one-liners with no repo access: target < 30 s wall, near-zero cost.
//
// This is a fixture, not a useful workflow — its RESULT is meaningless by design.

import { defineWorkflow } from '@workflow-toolbox/build/define'
import { collectTrail, generateAndFilter, makeRecord, scoreAndRank } from '@workflow-toolbox/patterns'

export default defineWorkflow({
  meta: {
    name: 'wt-shape-e2e',
    description:
      'Cheap e2e vehicle for the observe side: three phases (fan-out, gated ranking, plain agent), every agent pinned to haiku + low effort in the source — never inherits the session model. A rendering/data fixture, not a real workflow.',
    whenToUse:
      'Launch for observe-ui / audit e2e that needs a real multi-phase run (live shape, chips, replay). Never for real work — the result is meaningless by design.',
    phases: [
      { title: 'Gen', detail: 'generateAndFilter fan-out — 2 trivial candidates, filtered', model: 'haiku' },
      { title: 'Rank', detail: 'scoreAndRank over 2 placeholders — exercises a gate column', model: 'haiku' },
      { title: 'Wrap', detail: 'one plain agent — the single-agent column case', model: 'haiku' },
    ],
  },
  run: async (rt) => {
    rt.phase('Gen')
    const gen = await generateAndFilter(rt, {
      count: 2,
      generateModel: 'haiku',
      generateEffort: 'low',
      filterModel: 'haiku',
      filterEffort: 'low',
      generatePrompt: (i) =>
        `E2E fixture — no real task. Reply with exactly: CANDIDATE-${i}. Nothing else.`,
      filterPrompt: (c) => `E2E fixture. Answer exactly "yes" for this candidate: "${c}".`,
      phase: 'Gen',
    })

    rt.phase('Rank')
    const rank = await scoreAndRank(rt, {
      items: ['alpha', 'beta'],
      scoreModel: 'haiku',
      scoreEffort: 'low',
      dimensions: [
        {
          name: 'fixture',
          prompt: (item) =>
            `E2E fixture — "${item}" is a placeholder with no meaning. Return exactly {"score":3,"reason":"fixture"}.`,
        },
      ],
      cutoff: { type: 'topK', k: 1 },
      phase: 'Rank',
    })

    rt.phase('Wrap')
    // A PLAIN rt.agent stage writes NO trail record (only patterns do), so its explicit
    // model/effort would be applied at runtime yet invisible to every audit surface
    // (user finding 2026-07-10: the Wrap agent had no ⚡ chip). The fixture is exemplary:
    // hand-record plain stages with makeRecord — label and stage MUST match exactly.
    const wrap = await rt.agent('E2E fixture. Reply with exactly: WRAP-OK. Nothing else.', {
      label: 'wrap:final',
      phase: 'Wrap',
      model: 'haiku',
      effort: 'low',
    })
    const wrapTrail = { trail: [makeRecord('wrap:final', wrap !== null, { model: 'haiku', effort: 'low' })] }

    // The fixture returns the STANDARD envelope shape (`envelope.trail`) — the contract the
    // debugger report builder and the observe effort-ingest read. Ground truth 2026-07-10:
    // NO composition produced it before this one (trails stayed buried in per-pattern
    // results), so this fixture doubles as the format's first producer and its e2e proof.
    return {
      marker: 'WT_SHAPE_E2E_OK',
      envelope: { trail: collectTrail(gen, rank, wrapTrail) },
      gen,
      rank,
    }
  },
})
