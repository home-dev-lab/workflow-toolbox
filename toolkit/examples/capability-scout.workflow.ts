// capability-scout.workflow.ts — the REFERENCE EXAMPLE for the per-role
// capability registry (design docs/internal/capability-registry-design.md; card I5).
//
// What it demonstrates
// --------------------
// A workflow whose one agent role, `code-scout`, needs `code-intelligence` but
// names NO concrete provider. The provider is resolved on the USER's machine at
// launch, from a companion HAND-WRITTEN sidecar next to the built artifact:
//
//     toolkit/workflows/capability-scout.capabilities.json
//
// The sidecar declares (machine-agnostic — no provider, no tool of any machine):
//   roles.scout  → agent 'code-scout', needs [{ need: 'code-intelligence' }]
//   agents.code-scout.tools → ['Read', '$cap:code-intelligence']   // a $cap placeholder
//
// The `agentType: 'code-scout'` below binds by NAME to that sidecar `agents` key:
// at launch, `wt-observe launch` resolves the need against the machine registry,
// expands `$cap:code-intelligence`, and the delegated server composes the result
// into the run's `agents` map. This script never learns which provider was used.
//
// The two profiles this example is built to exercise e2e (Path B / delegated only —
// there is no launcher hook in Path A, design §8):
//
//   RESOLVED   WT_CAPABILITY_REGISTRY points at a registry declaring a
//              `code-intelligence` provider (e.g. serena) whose probe passes →
//              tools expand to ['Read', 'mcp__serena__*'] and serena mounts.
//
//   DEGRADED   no registry (bare machine) → the need degrades to the toolkit's
//              named `degraded:grep-glob` fallback → tools ['Read', 'Grep', 'Glob'],
//              nothing mounted. The SAME artifact runs unchanged.
//
// The alternative (Grep/Glob) is deliberately NOT added when resolved — removing
// the alternative is the proven adoption lever (design §5.2), so the agent uses the
// symbolic provider rather than falling back to text search out of habit.
//
// Cheap by construction: one haiku agent, low effort, a trivial locate task —
// this is a reference + e2e fixture, not production work.

import { defineWorkflow } from '@workflow-toolbox/build/define'
import { makeRecord } from '@workflow-toolbox/patterns'

export default defineWorkflow({
  meta: {
    name: 'capability-scout',
    description:
      'Reference example for the per-role capability registry: one code-intelligence agent whose provider is resolved at launch from a hand-written sidecar — runs unchanged whether the machine resolves a symbolic code-intelligence provider or degrades to grep/glob.',
    whenToUse:
      'REQUIRES wt-observe launch capability-scout — its one agent (code-scout) is resolved ONLY from the launch-time capability sidecar and this script FAILS immediately (unknown agent type) under the Workflow tool or any other launch path. Study or e2e the capability sidecar/resolver path, with WT_CAPABILITY_REGISTRY set (resolved) or unset (degraded). Not production work — the locate task is a fixture.',
    phases: [
      {
        title: 'Scout',
        detail: 'one code-scout agent locates a symbol with whatever code-intelligence tooling launch resolved',
        model: 'haiku',
      },
    ],
  },
  run: async (rt) => {
    rt.phase('Scout')
    const scout = await rt.agent(
      [
        'This run demonstrates capability resolution for a code-intelligence role.',
        'Using ONLY the code-intelligence tooling named in your Capability resolution note,',
        'locate the definition of ANY ONE exported function, class, or type under the current',
        'working directory and report it on its own line as: LOCATED <relative-path>:<1-based-line>.',
        'Then, on a line starting "SKILLS=", report how many skills you currently have available',
        'as a bare integer. Finally, end your reply with exactly: SCOUT-DONE. Do not modify any files.',
      ].join(' '),
      { agentType: 'code-scout', label: 'scout:locate', phase: 'Scout', model: 'haiku', effort: 'low' },
    )

    // Standard envelope shape (envelope.trail) — the record the debugger report
    // builder and observe effort-ingest read; a plain rt.agent stage writes no
    // trail on its own, so hand-record it (label + stage match the call above).
    return {
      marker: 'CAPABILITY_SCOUT_OK',
      envelope: { trail: [makeRecord('scout:locate', scout !== null, { model: 'haiku', effort: 'low' })] },
      scout,
    }
  },
})
