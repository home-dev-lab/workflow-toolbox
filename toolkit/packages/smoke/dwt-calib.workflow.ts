// dwt-calib.workflow.ts — the dedicated budgetFloor-calibration probe.
//
// Like smoke.workflow.ts this is NOT a teaching example: it lives under
// packages/smoke/, builds to packages/smoke/dwt-calib.js (NEVER toolkit/workflows/,
// so it stays invisible to the plugin-twin / tier-1 smoke scan), and is launched
// only by the calibration runner (src/calibrate.ts).
//
// PURPOSE: a CONTROLLED data point linking a KNOWN agent count to real tokens. It
// runs generateAndFilter with `count` candidates → ~2×count agents (one generator
// per candidate + a filter), all on ONE model tier (haiku — so the per-agent number
// is not confounded by mixed tiers, plan-critic H1), and returns the authoritative
// rt.budget.spent() alongside the envelope. Driving it at two `count` values (the
// B1 scaling gate) reveals whether the token signals actually scale with sub-agents.
//
// It deliberately mirrors dwt-smoke's generateAndFilter shape (trivial echo agents)
// because that is the workflow proven to complete inside the headless SDK window
// (run.ts tier-2). The agents are CHEAP — so the derived tokens/agent is a lower
// bound for real verifier/reviewer agents; the calibration docs say so.

import { defineWorkflow } from '@workflow-toolbox/build/define'
import type { WorkflowRuntime, JsonSchema } from '@workflow-toolbox/runtime'
import { generateAndFilter } from '@workflow-toolbox/patterns'
import type { FromSchema } from 'json-schema-to-ts'

const TOKEN_SCHEMA = {
  type: 'object',
  properties: { token: { type: 'string' } },
  required: ['token'],
  additionalProperties: false,
} as const satisfies JsonSchema

type Token = FromSchema<typeof TOKEN_SCHEMA>

interface CalibInput {
  count: number
}

/** Coerce the launch args to a positive candidate count (default 2). Tolerates a
 *  bare number, a { count } / { claims } object, or nothing. */
function parseCalibInput(raw: unknown): CalibInput {
  const obj = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const candidate =
    typeof raw === 'number'
      ? raw
      : obj !== null && typeof obj['count'] === 'number'
        ? obj['count']
        : obj !== null && typeof obj['claims'] === 'number'
          ? obj['claims']
          : 2
  const count = Number.isFinite(candidate) && candidate >= 1 ? Math.floor(candidate) : 2
  return { count }
}

export default defineWorkflow<CalibInput, unknown>({
  meta: {
    name: 'dwt-calib',
    description:
      'budgetFloor calibration probe: generateAndFilter(count, single tier) + budget.spent().',
    phases: [{ title: 'Calibrate' }],
  },
  parseInput: parseCalibInput,
  run: async (rt: WorkflowRuntime, input: CalibInput) => {
    const envelope = await generateAndFilter<Token>(rt, {
      count: input.count,
      phase: 'Calibrate',
      generateModel: 'haiku',
      filterModel: 'haiku',
      generatePrompt: (index) =>
        `Return exactly this JSON object and nothing else: {"token":"calib-${index}"}`,
      generateSchema: TOKEN_SCHEMA,
      filterPrompt: (candidate) =>
        `Reply pass=true if this object has a non-empty "token" string, else pass=false. ` +
        `Object: ${JSON.stringify(candidate)}`,
    })
    // rt.budget.spent() is the runtime's authoritative cumulative output-token
    // count for this run (a real number even when no target was set).
    return { envelope, budgetSpent: rt.budget.spent(), count: input.count, model: 'haiku' }
  },
})
