// loop-demo.workflow.ts — a RENDER DEMO for the observe-ui loop-edge rendering.
//
// Purpose: show loopUntilDone the TWO ways the graph renderer draws it, in one run:
//
//   1. an INTRA-phase loop ('Tighten') — the whole body loops within ONE phase, so the
//      "not yet" return is drawn as an arc INSIDE the container (gate {stop?} → round 1).
//      The body agent is UNLABELLED, so loopUntilDone auto-tags it `loopUntilDone:iter:<n>`
//      and every round sits in the single 'Tighten' column. (The legitimate "plain agent
//      loop body" case — e.g. an evaluator-optimizer refining one artifact.)
//
//   2. a CROSS-phase loop ('Generate' → 'Rank') — each iteration runs a REAL two-phase
//      PIPELINE: generateAndFilter (in 'Generate') then scoreAndRank (in 'Rank'). This is
//      the representative cross-phase case: an actual multi-phase unit of work repeated, not
//      bare placeholder agents. loopUntilDone appends ` ⟲<n>` to EACH nested pattern agent's
//      structured label (e.g. `generateAndFilter:generate:0 ⟲1`), so both columns read as
//      loop columns AND keep their pattern identity → the renderer draws ONE container-level
//      back-edge (Rank → Generate) arcing OUTSIDE the boxes; the forward spine through the
//      span IS the repeated pipeline.
//
// A non-loop 'Note' phase sits BETWEEN the two loops on purpose: the cross-phase detector
// groups MAXIMAL runs of consecutive loop columns, so without a non-loop separator the
// intra 'Tighten' loop would merge into the cross span. The seam keeps them distinct.
//
// Agent prompts are deliberately TRIVIAL (no repo access, no real work) so the run is fast
// and cheap — only the loop SHAPES matter. This is a demo/fixture, not a useful workflow.

import { defineWorkflow } from '@workflow-toolbox/build/define'
import { collectTrail, loopUntilDone, generateAndFilter, scoreAndRank } from '@workflow-toolbox/patterns'

export default defineWorkflow({
  meta: {
    name: 'loop-demo',
    description: 'Render demo: loopUntilDone drawn two ways — an intra-phase loop and a cross-phase loop over a real generateAndFilter→scoreAndRank pipeline — for observe-ui loop-edge verification.',
    whenToUse: 'Use only to populate the observe-ui graph with both loopUntilDone shapes (a rendering fixture) — not a real task workflow.',
    phases: [
      { title: 'Tighten', detail: 'loopUntilDone — INTRA-phase loop: body refines within one phase (gate→round1 arc inside the box)' },
      { title: 'Note', detail: 'a single plain agent — a non-loop seam separating the two loops' },
      { title: 'Generate', detail: 'cross-phase loop body, part 1: generateAndFilter (a real pattern, looped)' },
      { title: 'Rank', detail: 'cross-phase loop body, part 2: scoreAndRank — the loop spans Generate→Rank, back-edge outside the boxes' },
    ],
  },
  run: async (rt) => {
    // Every agent below is pinned to 'low' reasoning effort: this is a shape/rendering
    // fixture (only the loop SHAPES matter, not the answers), so silently inheriting the
    // session effort would waste quota on trivial one-line replies.
    // 1) INTRA-phase loop — one phase, body loops in place (unlabelled → loopUntilDone:iter:<n>).
    rt.phase('Tighten')
    const intra = await loopUntilDone<{ rounds: number }>(rt, {
      initial: { rounds: 0 },
      maxIterations: 4,
      body: async (rtBody, state, iteration) => {
        await rtBody.agent(`Loop demo (intra), iteration ${iteration}. Reply with one short tightened line.`, { effort: 'low' })
        return { state: { rounds: state.rounds + 1 }, done: iteration >= 3 }
      },
    })

    // 2) Non-loop seam — breaks the consecutive-loop-column run so 'Tighten' stays intra.
    rt.phase('Note')
    await rt.agent('Loop demo. Reply with one short line noting the seam between the two loops.', { phase: 'Note', effort: 'low' })

    // 3) CROSS-phase loop — each iteration runs a REAL pipeline across two phases:
    //    generateAndFilter (Generate) → scoreAndRank (Rank). loopUntilDone appends ` ⟲<n>` to
    //    every nested agent's label, so both phases are loop columns → cross-phase back-edge.
    const cross = await loopUntilDone<{ ok: boolean }>(rt, {
      initial: { ok: false },
      maxIterations: 3,
      body: async (rtBody, state, iteration) => {
        await generateAndFilter(rtBody, {
          count: 2,
          generateEffort: 'low',
          filterEffort: 'low',
          generatePrompt: (i) => `Loop demo (cross), round ${iteration}: generate candidate ${i} (one short line).`,
          filterPrompt: (c) => `Loop demo: keep this candidate? Answer yes or no: "${c}".`,
          phase: 'Generate',
        })
        await scoreAndRank(rtBody, {
          items: ['candidate A', 'candidate B'],
          scoreModel: 'haiku',
          scoreEffort: 'low',
          dimensions: [
            { name: 'impact', prompt: (item) => `Loop demo: score the impact of "${item}" from 1 to 5. Return {"score":N,"reason":"..."}.` },
          ],
          cutoff: { type: 'topK', k: 1 },
          phase: 'Rank',
        })
        return { state: { ok: true }, done: iteration >= 2 }
      },
    })

    return { intra: intra.value, cross: cross.value, envelope: { trail: collectTrail(intra, cross) } }
  },
})
