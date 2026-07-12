// demo-showcase-v2.workflow.ts — the ALL-NINE-PATTERNS nested showcase fixture.
//
// Purpose: a single runnable workflow that exercises EVERY one of the nine
// @workflow-toolbox patterns across THREE levels of real in-run nesting, so the
// observe-ui reviewer can explore the full variety of DAG shapes — a router, a
// gate, a scatter-gather fan, a judge tournament, an orchestrator expansion, a
// chunked map-reduce, a refute-first verifier fan, a rank+cutoff triage, and
// loopUntilDone drawn BOTH as an inner (deep) loop and an outer (root) loop — in
// one launch. It supersedes demo-all-patterns (flat, eight patterns) as the
// showcase fixture; that older one stays as the minimal per-pattern render check.
//
// THREE NESTING LEVELS (real code nesting: run → runNestedPipeline → runDeepPipeline):
//   L1 root      : classifyAndAct (Route) · human gate (Gate) · loopUntilDone OUTER
//                  (Refine-Outer) · scoreAndRank (Triage)
//   L2 nested    : fanOutAndSynthesize (Fan) · tournament (Compete) · planAndExecute (Plan)
//   L3 deep      : generateAndFilter (Generate) · chunkedAnalysis (Chunk) ·
//                  adversarialVerification (Verify) · loopUntilDone INNER (Refine-Inner)
// Each level exercises DIFFERENT patterns so drilling into a level reveals variety.
//
// MODEL KNOB (mandatory, hard lesson): a demo with no model knob is unfit for
// repeated runs — it silently inherits the launching SESSION model + the full
// ambient context (see the project rule how-to-launch-workflows.md). So EVERY
// agent() here honors `args.perAgent = { model }`: the whole perAgent envelope is
// applied via withAgentDefaults at the top of run(), and the ONE pattern that pins
// its own model internally (adversarialVerification defaults its verifiers to
// BEST_MODEL='opus') is passed the resolved model EXPLICITLY so the knob wins
// there too. With no knob the fixture defaults to 'haiku' + 'low' effort — the
// capture run pins haiku, keeping the whole run trivially cheap.
//
// Prompts are short but produce readable, visually-interesting one-liners (a fun
// mascot brief) so the captured transcripts are pleasant to read. This is a
// fixture — the RESULT is meaningless by design; only the SHAPE + cost matter.

import { defineWorkflow, parseConfig } from '@workflow-toolbox/build/define'
import { withAgentDefaults } from '@workflow-toolbox/runtime'
import type { WorkflowRuntime, AgentDefaults, ModelAlias, JsonSchema } from '@workflow-toolbox/runtime'
import {
  classifyAndAct,
  fanOutAndSynthesize,
  tournament,
  planAndExecute,
  generateAndFilter,
  chunkedAnalysis,
  adversarialVerification,
  loopUntilDone,
  scoreAndRank,
  collectTrail,
  makeRecord,
} from '@workflow-toolbox/patterns'
import type { TrailRecord } from '@workflow-toolbox/patterns'

// Every agent has repo tool access; a Haiku agent once took "break into
// subtasks" literally and CREATED a file. This is a render fixture — reply with
// text only, touch nothing.
const GUARD =
  ' IMPORTANT: render demo — reply with a short line of TEXT ONLY. Do NOT use any tools, and do NOT create, modify, or delete any files.'

// Auto-approvable gate decision shape.
const GATE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    approve: { type: 'boolean' },
    reason: { type: 'string', maxLength: 160 },
  },
  required: ['approve', 'reason'],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// Input contract — ONLY the launch-time tuning envelope (perAgent), so the model
// knob is honored. parseConfig reads the conventional `args.perAgent` slice.
// ---------------------------------------------------------------------------

export interface ShowcaseInput {
  /** Launch-time per-agent defaults (model / effort / agentType / …). The model
   *  knob every agent honors. null = none (fixture defaults to haiku + low). */
  perAgent: AgentDefaults | null
}

function parseInput(raw: unknown): ShowcaseInput {
  const obj = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const perAgent = parseConfig(obj).perAgent ?? null
  return { perAgent }
}

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

interface ShowcaseOutput {
  marker: 'DEMO_SHOWCASE_V2_OK'
  route: string | null
  approved: boolean
  tagline: string | null
  clusters: string | null
  triage: number
  envelope: { trail: TrailRecord[] }
}

// ---------------------------------------------------------------------------
// L3 — the DEEP pipeline: generateAndFilter → chunkedAnalysis →
// adversarialVerification → loopUntilDone (INNER). The deepest, most varied level.
// `resolvedModel` is threaded ONLY into adversarialVerification (the one pattern
// that pins its own model); every other agent inherits it from withAgentDefaults.
// ---------------------------------------------------------------------------

interface DeepResult {
  clusters: string | null
  trail: TrailRecord[]
}

async function runDeepPipeline(rt: WorkflowRuntime, resolvedModel: ModelAlias): Promise<DeepResult> {
  // generateAndFilter — a couple of candidate taglines, filtered.
  rt.phase('Generate')
  const gen = await generateAndFilter(rt, {
    count: 2,
    generatePrompt: (i) => `Render demo. Write playful mascot tagline candidate #${i} (one short line).${GUARD}`,
    filterPrompt: (c) => `Render demo. Keep this tagline? Answer yes or no: "${c}".${GUARD}`,
    phase: 'Generate',
  })

  // chunkedAnalysis — map-reduce a tiny "feedback log" into clusters.
  rt.phase('Chunk')
  const chunk = await chunkedAnalysis(rt, {
    input: 'LOVE the colors\nfont too small\nLOVE the mascot\nfont too small\nmascot is scary',
    maxChars: 24,
    analyzePrompt: (c, i, total) => `Render demo. Chunk ${i + 1}/${total}. Summarize the feedback themes in one short line:\n${c}${GUARD}`,
    synthesizePrompt: (parts) => `Render demo. Merge these ${parts.length} theme notes into one short "top clusters" line.${GUARD}`,
    phase: 'Chunk',
  })

  // adversarialVerification — refute-first check of two claims. This pattern pins
  // its verifiers to BEST_MODEL by default, so pass the resolved model + low
  // effort EXPLICITLY to honor the knob and keep the fixture cheap.
  rt.phase('Verify')
  const verify = await adversarialVerification(rt, {
    model: resolvedModel,
    effort: 'low',
    claims: ['mascots boost recall', 'small fonts help reading'],
    renderClaim: (claim) => `Render demo. Decide if this claim is true, refuting if uncertain: "${claim}".${GUARD}`,
    phase: 'Verify',
  })

  // loopUntilDone INNER — a small intra-phase polish loop inside the deep level.
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
    clusters: chunk.value,
    trail: collectTrail(gen, chunk, verify, inner),
  }
}

// ---------------------------------------------------------------------------
// L2 — the NESTED pipeline: fanOutAndSynthesize (scatter-gather) → tournament →
// (drill into L3) → planAndExecute. Mid-level variety; calls the deep level.
// ---------------------------------------------------------------------------

interface NestedResult {
  tagline: string | null
  clusters: string | null
  trail: TrailRecord[]
}

async function runNestedPipeline(rt: WorkflowRuntime, resolvedModel: ModelAlias): Promise<NestedResult> {
  // fanOutAndSynthesize — scatter angles to workers, gather into one brief.
  rt.phase('Fan')
  const fan = await fanOutAndSynthesize(rt, {
    tasks: ['colors', 'personality', 'catchphrase'],
    taskPrompt: (task, i) => `Render demo, angle ${i}. One short idea about the mascot's ${task}.${GUARD}`,
    synthesisPrompt: (parts) => `Render demo. Fuse these ${parts.length} angle notes into one mascot brief line.${GUARD}`,
    phase: 'Fan',
  })

  // tournament — a judge panel picks the best tagline angle.
  rt.phase('Compete')
  const compete = await tournament(rt, {
    angles: ['bold', 'whimsical'],
    attemptPrompt: (angle, i) => `Render demo, attempt ${i}. Write a ${angle} mascot tagline (one short line).${GUARD}`,
    judgePrompt: (attempt) => `Render demo. Score this tagline 1-10: "${attempt}".${GUARD}`,
    synthesisPrompt: (ranked) => `Render demo. From the best of ${ranked.length} taglines, write the final one line.${GUARD}`,
    phase: 'Compete',
  })

  // Drill into the DEEP level (L3).
  const deep = await runDeepPipeline(rt, resolvedModel)

  // planAndExecute — planner decomposes a rollout, workers do the pieces.
  rt.phase('Plan')
  const plan = await planAndExecute(rt, {
    planPrompt: `Render demo. Return a 3-item PLAN (do NOT implement) that splits "introduce the mascot" into 3 independent one-line steps.${GUARD}`,
    workerPrompt: (subtask, i) => `Render demo, step ${i}: ${subtask.description}. Reply in one short line.${GUARD}`,
    synthesisPrompt: (results) => `Render demo. Combine these ${results.length} step lines into one rollout summary.${GUARD}`,
    phase: 'Plan',
  })

  // The deep level already flattened its trail; wrap it back into the
  // { trail } shape collectTrail concatenates, keeping phase order.
  return {
    tagline: compete.value,
    clusters: deep.clusters,
    trail: collectTrail(fan, compete, { trail: deep.trail }, plan),
  }
}

// ---------------------------------------------------------------------------
// L1 — the ROOT pipeline: classifyAndAct (Route) → human gate (Gate) → drill into
// L2 → loopUntilDone OUTER (Refine-Outer) → scoreAndRank (Triage).
// ---------------------------------------------------------------------------

async function run(rt0: WorkflowRuntime, input: ShowcaseInput): Promise<ShowcaseOutput> {
  // Honor the model knob: apply the whole perAgent envelope as the agent
  // defaults, over a cheap 'low' effort floor, and force the model to the
  // resolved value (perAgent.model, else 'haiku'). Every agent that does not pin
  // its own model inherits this; adversarialVerification is passed it explicitly.
  const resolvedModel: ModelAlias = input.perAgent?.model ?? 'haiku'
  const rt = withAgentDefaults(rt0, { effort: 'low', ...(input.perAgent ?? {}), model: resolvedModel })

  // classifyAndAct — route the brief's tone to a matching handler.
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

  // Human gate (auto-approvable): a single approval agent at the phase boundary.
  // This is a DEMO gate — the decision is recorded and logged, but the run
  // proceeds regardless (auto-approve), standing in for a real HITL boundary.
  rt.phase('Gate')
  const gate = await rt.agent<{ approve: boolean; reason: string }>(
    `Render demo. Approve this mascot brief to proceed? Reply {"approve":true,"reason":"..."} (approve for the demo).${GUARD}`,
    { label: 'gate:approve', phase: 'Gate', schema: GATE_SCHEMA },
  )
  const approved = gate?.approve ?? true // auto-approvable: default-approve on a null/failed gate
  rt.log(`demo-showcase-v2 gate: ${approved ? 'approved' : 'reject vote overridden (auto-approve)'} — proceeding`)
  const gateTrail = { trail: [makeRecord('gate:approve', gate !== null, {})] }

  // Drill into the NESTED level (L2 → L3).
  const nested = await runNestedPipeline(rt, resolvedModel)

  // loopUntilDone OUTER — a root-level polish loop over the final brief.
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

  // scoreAndRank — cheap triage of launch channels, keep the top.
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
    marker: 'DEMO_SHOWCASE_V2_OK',
    route: route.value[0]?.category ?? null,
    approved,
    tagline: nested.tagline,
    clusters: nested.clusters,
    triage: triage.value.length,
    envelope: {
      trail: collectTrail(route, gateTrail, { trail: nested.trail }, outer, triage),
    },
  }
}

// ---------------------------------------------------------------------------
// Workflow definition — phases in execution order (the shape skeleton observe
// seeds from meta.phases): root → nested → deep → back to root.
// ---------------------------------------------------------------------------

export default defineWorkflow({
  meta: {
    name: 'demo-showcase-v2',
    description:
      'All-nine-patterns nested showcase: three levels of in-run nesting (root → nested → deep), each level exercising different patterns, with loopUntilDone drawn both inner and outer, an auto-approvable human gate, and every agent honoring args.perAgent.model (defaults to haiku). A render/cost fixture for observe-ui, not a real workflow.',
    whenToUse:
      'Launch only to populate the observe-ui graph with every pattern shape across three nesting levels (a rendering fixture) — never for real work; the result is meaningless by design. Pin args.perAgent={model:"haiku"} for a trivially cheap capture run.',
    phases: [
      { title: 'Route', detail: 'L1 root — classifyAndAct: one router then one handler' },
      { title: 'Gate', detail: 'L1 root — auto-approvable human gate at the phase boundary' },
      { title: 'Fan', detail: 'L2 nested — fanOutAndSynthesize (scatter-gather) of angle workers' },
      { title: 'Compete', detail: 'L2 nested — tournament: attempts, judges, synthesis funnel' },
      { title: 'Generate', detail: 'L3 deep — generateAndFilter: candidate taglines, filtered' },
      { title: 'Chunk', detail: 'L3 deep — chunkedAnalysis: map-reduce a feedback log into clusters' },
      { title: 'Verify', detail: 'L3 deep — adversarialVerification: refute-first verifier fan' },
      { title: 'Refine-Inner', detail: 'L3 deep — loopUntilDone INNER: intra-phase polish loop' },
      { title: 'Plan', detail: 'L2 nested — planAndExecute: planner then dynamic workers' },
      { title: 'Refine-Outer', detail: 'L1 root — loopUntilDone OUTER: root-level polish loop' },
      { title: 'Triage', detail: 'L1 root — scoreAndRank: cheap per-dimension scoring + cutoff' },
    ],
  },
  parseInput,
  run,
})
