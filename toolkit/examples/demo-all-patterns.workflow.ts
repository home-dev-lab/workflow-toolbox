// demo-all-patterns.workflow.ts — a RENDER DEMO for the observe-ui graph.
//
// Purpose: exercise EIGHT of the nine canonical patterns in one run so the observe-ui
// renderer (the Svelte Flow graph + the replay upfront-shape seed) can be checked
// against every distinctive DAG shape in a single launch — a wide fan
// (fanOutAndSynthesize), a per-claim verify fan (adversarialVerification), a
// multi-rank tournament with a synthesis funnel, a generate→filter funnel, a
// repeated-phase loop, a plan→execute expansion, a classify→act router, and a
// score→rank+cutoff triage. Each pattern gets its own phase, so the graph shows
// eight labelled columns joined by the phase spine. The all-nine showcase (adding
// chunkedAnalysis, plus three levels of nesting) now lives in two forms — the
// demo-showcase-v2 orchestrator PIPELINE (nested + gated) and the all-patterns-workflow
// single-run composition; this stays the minimal eight-of-nine one-phase-per-pattern
// render check.
//
// The agent prompts are deliberately TRIVIAL and self-contained (no repo access,
// no real work) so the run completes fast and cheap — only the SHAPE matters here,
// not the agents' answers. This is a demo/fixture, not a useful workflow; it is the
// runnable sibling of the scaffold all-patterns golden.
//
// Agents are pinned to the cheapest model that works — this is a render fixture, so agent
// OUTPUT quality is irrelevant (only the pattern shape + digest counts matter) and the goal is
// to keep the run off the scarce Opus quota. All phases run on 'haiku' EXCEPT Execute
// (planAndExecute), the one agentic phase, which runs on 'sonnet' for tighter adherence to the
// text-only GUARD (a haiku planner once created a file in the repo). The haiku pinning even
// overrides adversarialVerification's BEST_MODEL default: the "verifier stays strong" guard is
// about REAL verification, not a fixture whose claims are "the sky is blue".

import { defineWorkflow } from '@workflow-toolbox/build/define'
import { classifyAndAct, collectTrail, fanOutAndSynthesize, adversarialVerification, generateAndFilter, tournament, loopUntilDone, planAndExecute, scoreAndRank } from '@workflow-toolbox/patterns'

export default defineWorkflow({
  meta: {
    name: 'demo-all-patterns',
    description: 'Render demo: exercises eight of the nine patterns in one run, one phase each (the full all-nine showcase is the demo-showcase-v2 orchestrator pipeline / the all-patterns-workflow single-run composition), for observe-ui graph verification.',
    whenToUse: 'Use only to populate the observe-ui graph with every pattern shape (a rendering fixture) — not a real task workflow.',
    phases: [
      { title: 'Route', detail: 'classifyAndAct — one router agent then one action agent' },
      { title: 'Analyze', detail: 'fanOutAndSynthesize — a wide fan of workers then a synthesis' },
      { title: 'Verify', detail: 'adversarialVerification — a refute-first verifier fan per claim' },
      { title: 'Generate', detail: 'generateAndFilter — candidate generation then a filter' },
      { title: 'Compete', detail: 'tournament — attempts, judges, and a synthesis funnel' },
      { title: 'Refine', detail: 'loopUntilDone — a repeated-phase refinement loop' },
      { title: 'Execute', detail: 'planAndExecute — a planner then dynamic workers' },
      { title: 'Triage', detail: 'scoreAndRank — cheap per-dimension scoring then a rank + cutoff' },
    ],
  },
  run: async (rt) => {
    // Universal text-only guard. Every demo agent has repo tool access, and a Haiku planner once
    // took "break into subtasks" literally and CREATED a workflow file in the repo. There is no
    // uniform per-agent tool-restriction across the patterns (only adversarialVerification exposes
    // agentType), so each prompt explicitly forbids tools/file writes — a soft guard. The Execute
    // (planAndExecute) phase is the only agentic one and was the offender, so it ALSO runs on sonnet
    // for tighter guard adherence; the other seven phases stay on haiku (their prompts are trivial).
    const GUARD =
      ' IMPORTANT: this is a render demo — reply with text only. Do NOT use any tools, and do NOT create, modify, or delete any files.'

    // Every stage below is ALSO pinned to 'low' reasoning effort, for the same reason the
    // models are pinned cheap: this is a shape/cost fixture, not real work, and every silent
    // session-effort inheritance would waste quota on trivial one-line replies. Verify (step3)
    // deliberately overrides adversarialVerification's normal 'high' effort floor too — same
    // rationale as its BEST_MODEL override above (fake verification on "the sky is blue").
    const step1 = await classifyAndAct(rt, {
      classifyModel: 'haiku',
      classifyEffort: 'low',
      items: ['a short note'],
      categories: ['greeting', 'question'],
      classifyPrompt: (item) => `Render demo. Classify "${item}" into greeting or question. Return {"category":"..."}.${GUARD}`,
      actions: {
        greeting: { model: 'haiku', effort: 'low', prompt: (item) => `Render demo. The item "${item}" is a greeting — reply in one short line.${GUARD}` },
        question: { model: 'haiku', effort: 'low', prompt: (item) => `Render demo. The item "${item}" is a question — reply in one short line.${GUARD}` },
      },
      phase: 'Route',
    })

    const step2 = await fanOutAndSynthesize(rt, {
      taskModel: 'haiku',
      taskEffort: 'low',
      synthesisModel: 'haiku',
      synthesisEffort: 'low',
      tasks: ['alpha', 'beta', 'gamma', 'delta'],
      taskPrompt: (task, index) => `Render demo, worker ${index}. Reply with one short line about "${task}".${GUARD}`,
      synthesisPrompt: (parts) => `Render demo. Combine these ${parts.length} short notes into one line.${GUARD}`,
      phase: 'Analyze',
    })

    const step3 = await adversarialVerification(rt, {
      model: 'haiku',
      effort: 'low',
      claims: ['the sky is blue', 'water is dry'],
      renderClaim: (claim) => `Render demo. Decide if this claim is true, refuting if uncertain: "${claim}".${GUARD}`,
      phase: 'Verify',
    })

    const step4 = await generateAndFilter(rt, {
      generateModel: 'haiku',
      generateEffort: 'low',
      filterModel: 'haiku',
      filterEffort: 'low',
      count: 3,
      generatePrompt: (index) => `Render demo. Generate short candidate idea number ${index} (one line).${GUARD}`,
      filterPrompt: (candidate) => `Render demo. Keep this candidate? Answer yes or no: "${candidate}".${GUARD}`,
      phase: 'Generate',
    })

    const step5 = await tournament(rt, {
      attemptModel: 'haiku',
      attemptEffort: 'low',
      judgeModel: 'haiku',
      judgeEffort: 'low',
      synthesisModel: 'haiku',
      synthesisEffort: 'low',
      angles: ['concise', 'playful'],
      attemptPrompt: (angle, index) => `Render demo, attempt ${index}. Write one short slogan in a ${angle} style.${GUARD}`,
      judgePrompt: (attempt) => `Render demo. Score this slogan 1-10: "${attempt}".${GUARD}`,
      synthesisPrompt: (ranked) => `Render demo. From the best of ${ranked.length} slogans, write the final one line.${GUARD}`,
      phase: 'Compete',
    })

    rt.phase('Refine')
    const step6 = await loopUntilDone(rt, {
      initial: { rounds: 0 },
      maxIterations: 2,
      body: async (rt, state, iteration) => {
        await rt.agent(`Render demo, refinement iteration ${iteration}. Reply with one short improved line.${GUARD}`, { model: 'haiku', effort: 'low' })
        return { state: { rounds: state.rounds + 1 }, done: iteration >= 1 }
      },
    })

    // Execute is the only agentic phase (a planner that decomposes a goal) and was the one that
    // wrote a file — so it runs on sonnet AND its plan prompt explicitly forbids implementing.
    // Effort stays 'low' regardless: the sonnet upgrade was for INSTRUCTION adherence, not
    // reasoning depth — this fixture's subtasks are still trivial one-liners.
    const step7 = await planAndExecute(rt, {
      planModel: 'sonnet',
      planEffort: 'low',
      workerModel: 'sonnet',
      workerEffort: 'low',
      synthesisModel: 'sonnet',
      synthesisEffort: 'low',
      planPrompt: `Render demo. Return a 3-item plan that breaks "say hello in three languages" into 3 independent subtasks — as a PLAN ONLY. Do NOT implement it.${GUARD}`,
      workerPrompt: (subtask, index) => `Render demo, subtask ${index}: ${subtask.description}. Reply in one short line.${GUARD}`,
      synthesisPrompt: () => `Render demo. Combine the 3 worker lines into one greeting.${GUARD}`,
      phase: 'Execute',
    })

    const step8 = await scoreAndRank(rt, {
      items: ['module-a', 'module-b', 'module-c'],
      scoreModel: 'haiku',
      scoreEffort: 'low',
      dimensions: [
        { name: 'impact', prompt: (item) => `Render demo. Score the impact of "${item}" from 1 to 5. Return {"score":N,"reason":"..."}.${GUARD}` },
        { name: 'opportunity', prompt: (item) => `Render demo. Score the opportunity in "${item}" from 1 to 5. Return {"score":N,"reason":"..."}.${GUARD}` },
      ],
      cutoff: { type: 'topK', k: 2 },
      phase: 'Triage',
    })

    return {
      step1: step1.value, step2: step2.value, step3: step3.value, step4: step4.value,
      step5: step5.value, step6: step6.value, step7: step7.value, step8: step8.value,
      envelope: { trail: collectTrail(step1, step2, step3, step4, step5, step6, step7, step8) },
    }
  },
})
