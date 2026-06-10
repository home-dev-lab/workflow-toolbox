// smoke.workflow.ts — the dedicated minimal round-trip workflow for the P3.6
// upgrade canary.
//
// Intentionally tiny: generateAndFilter(count=1) spawns one generator + one
// filter agent and returns a real PatternResult envelope. Launching its built
// artifact through the live Workflow runtime proves an end-to-end @workflow-toolbox
// round-trip survives unchanged after a Claude Code upgrade:
//   agent() → pattern → envelope (value / stats / warnings / trail) → result.
//
// This is NOT a teaching example. It lives under packages/smoke/, is built to
// packages/smoke/wt-smoke.js (NEVER toolkit/workflows/, so it stays invisible
// to the plugin-twin / artifact-count assertions), and is launched only by the
// smoke harness (src/run.ts).

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

// The marker the harness asserts on. Kept in sync with src/run.ts SMOKE_MARKER.
const MARKER = 'wt-smoke-ok'

export default defineWorkflow({
  meta: {
    name: 'wt-smoke',
    description: 'Minimal round-trip smoke: generateAndFilter(count=1) returns a PatternResult envelope.',
    phases: [{ title: 'Smoke' }],
  },
  run: async (rt: WorkflowRuntime) => {
    const envelope = await generateAndFilter<Token>(rt, {
      count: 1,
      phase: 'Smoke',
      generatePrompt: () =>
        `Return exactly this JSON object and nothing else: {"token":"${MARKER}"}`,
      generateSchema: TOKEN_SCHEMA,
      filterPrompt: (candidate) =>
        `Reply pass=true if this object's token equals the non-empty string "${MARKER}", otherwise pass=false. Object: ${JSON.stringify(candidate)}`,
    })
    return { marker: MARKER, envelope }
  },
})
