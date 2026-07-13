// leaf-fence.ts — apply the toolkit's fenced leaf agentType as the LOWEST-priority
// agent() default, so every toolkit-spawned leaf/worker agent loses SendMessage
// (and the harness's teammates-roster advertisement that follows it) UNLESS a
// workflow explicitly opts back in.
//
// WHY THIS EXISTS: a toolkit-spawned agent that runs under the default (unfenced)
// subagent type has always inherited the session's inter-agent messaging tool when
// launched from an interactive session — a fresh-context "leaf" worker was never
// meant to have an outbound channel to the launching conversation or its live
// teammates, and under-specified agents have been observed using it spontaneously
// (asking the main conversation for missing context instead of doing their best
// with what they were given). Ground-truthed control fact (2026-07-10 injection
// matrix): the advertisement FOLLOWS the capability — an agentType whose resolved
// tool set omits the messaging tool gets neither the tool nor the knowledge of who
// is addressable. `disallowedTools` is the officially documented denylist mechanism
// (Claude Code sub-agents reference): it inherits every other tool untouched, so a
// leaf keeps whatever capability its actual task needs — unlike a `tools:` allowlist,
// which would need to enumerate every tool a leaf might ever want.
//
// WHY A WRAPPER, NOT A PATTERN-INTERNAL DEFAULT: every @workflow-toolbox/patterns
// function already exposes a per-role `<role>Type` option that maps straight onto
// `agentType` and is OMITTED (not defaulted) when the caller doesn't set it — this
// is what lets an outer `withAgentDefaults(rt, config.perAgent)` blanket override
// flow through untouched. If a pattern instead set `agentType` unconditionally
// (explicit role type OR the fence), it would always win the `{...defaults, ...opts}`
// merge inside `rt.agent()`, silently clobbering a workflow author's OWN blanket
// `perAgent.agentType` override. Applying the fence as the INNERMOST `withAgentDefaults`
// layer (below any author-applied blanket, below any per-role override) preserves
// existing precedence with ZERO changes to the 8 patterns' internal call sites.
//
// GRACEFUL BY CONSTRUCTION: probeAgentType() is the same probe/fallback convention
// already used for opt-in cross-family routing (pr-review's `reviewerType`,
// independent-analysis's `verifierType`) — a workflow running where the
// `workflow-toolbox` plugin isn't installed (so `workflow-toolbox:leaf` isn't a
// registered agentType) degrades to the standard subagent instead of throwing.

import type { AgentDefaults, WorkflowRuntime } from '@workflow-toolbox/runtime'
import { withAgentDefaults } from '@workflow-toolbox/runtime'
import { probeAgentType, LOCAL_AGENT_PROBE_PROMPT } from './probe-agent-type.js'
import type { AgentTypeProbeReport } from './probe-agent-type.js'

/** The toolkit's own fenced leaf agentType (plugin-scoped name; ships as
 *  `plugin/agents/leaf.md`, `disallowedTools: SendMessage`). */
export const LEAF_AGENT_TYPE = 'workflow-toolbox:leaf'

export interface WithLeafFenceOptions {
  /** Phase label for the probe's own digest emission (see probeAgentType). Omit
   *  to use whatever phase is current when the probe runs. */
  phase?: string
  /** Override which agentType the fence probes/applies. Default: LEAF_AGENT_TYPE.
   *  Escape hatch for a consumer that ships its OWN fenced type under a different
   *  name (e.g. a private plugin) instead of the toolkit's. */
  agentType?: string
  /** Opt OUT of the fence entirely — returns `rt` unchanged, no probe spent. This is
   *  the resolved value of a workflow's `messaging: true` launch-time knob (parsed by
   *  parseConfig): a workflow that genuinely needs its leaves to coordinate (e.g. an
   *  agent that must notify a live teammate) sets this, once, at the top of run().
   *  Default false — the fence applies. */
  disabled?: boolean
  /** A workflow's own blanket per-agent defaults (the SAME object you'd pass to an
   *  outer `withAgentDefaults(fencedRt, config.perAgent)` afterward), applied to the
   *  fence's OWN internal probe call ONLY. Without this, the probe silently ran on
   *  the raw session model/effort even when the workflow declares a blanket
   *  `perAgent` override — contradicting perAgent's own "every agent in every
   *  pattern inherits" contract (review finding). Safe to pass the whole object
   *  including `agentType`: the probe call always sets its OWN explicit `agentType`
   *  (the type being probed), which wins over anything in `perAgent` per the normal
   *  `{...defaults, ...opts}` precedence — only `model`/`effort`/`isolation`/
   *  `stallMs` actually reach the probe. Does NOT change the fence's OWN precedence
   *  (still innermost — an outer `withAgentDefaults(fencedRt, perAgent)` applied by
   *  the caller AFTER this call still wins for every OTHER agent in the workflow). */
  perAgent?: AgentDefaults
}

/** The leaf-fence probe story, for a workflow that wants to surface it in its own
 *  result (mirrors the `probe`/`reviewerType` fields pr-review and
 *  independent-analysis already return for their opt-in agentType routing). */
export interface LeafFenceReport {
  /** The agentType actually applied as the default; null = no fence (disabled, or
   *  the requested type could not answer and the run degraded to the standard
   *  subagent — see `probe`). */
  resolvedAgentType: string | null
  /** Null when the fence was disabled (no probe was spent). */
  probe: AgentTypeProbeReport | null
}

// Fail-open must be LOUD (review finding): the probe/fallback convention is
// deliberately graceful (never abort a run over a missing agentType), but a SILENT
// degradation here means every leaf in the run keeps SendMessage without anyone
// noticing short of inspecting the returned report. This line is unconditional and
// UNMISSABLE in the journal — never gated behind opt-in report inspection. It is
// leaf-fence's OWN log call, distinct from probeAgentType's generic "falling back to
// the standard subagent" line, because that generic line never says WHAT capability
// silently came back (SendMessage) or that it applies to the WHOLE run's leaves.
const FENCE_UNAVAILABLE_MESSAGE =
  'fence UNAVAILABLE — leaves run with SendMessage enabled this run'

/**
 * Wrap `rt` so every agent() call defaults to the fenced leaf agentType — UNLESS
 * that call (or an outer `withAgentDefaults`/per-role `<role>Type` override)
 * already sets its own `agentType`, which always wins.
 *
 * Call this ONCE, at the very top of a workflow's `run()`, BEFORE any other
 * `withAgentDefaults` wrap (e.g. for `config.perAgent`) — composition order is
 * "outer wins" (see withAgentDefaults), so applying the fence first keeps it the
 * lowest-priority default and lets a workflow's own blanket override win cleanly.
 * Pass the SAME `perAgent` object as `options.perAgent` too, so the fence's own
 * probe call inherits its model/effort instead of silently running on the session
 * default (see `WithLeafFenceOptions.perAgent`).
 *
 * @example
 * ```ts
 * async function run(rt0: WorkflowRuntime, input: MyInput) {
 *   const { rt: fenced, report } = await withLeafFence(rt0, {
 *     disabled: input.messaging === true,
 *     ...(input.perAgent !== null ? { perAgent: input.perAgent } : {}),
 *   })
 *   const rt = input.perAgent !== null ? withAgentDefaults(fenced, input.perAgent) : fenced
 *   // ...
 *   return { ...., leafFence: report }
 * }
 * ```
 */
export async function withLeafFence(
  rt: WorkflowRuntime,
  options: WithLeafFenceOptions = {},
): Promise<{ rt: WorkflowRuntime; report: LeafFenceReport }> {
  const { phase, agentType = LEAF_AGENT_TYPE, disabled = false, perAgent } = options

  if (disabled) {
    return { rt, report: { resolvedAgentType: null, probe: null } }
  }

  // The probe call inherits perAgent's model/effort/isolation/stallMs (NOT
  // agentType — probeAgentType always sets its OWN explicit agentType, which wins
  // regardless of what perAgent carries). Without this, the probe silently ran on
  // the raw session model even when the workflow declares a blanket override.
  const probeRt = perAgent !== undefined ? withAgentDefaults(rt, perAgent) : rt
  // LOCAL probe prompt, not the bridge default: the leaf is a locally-registered
  // type with no CLI chain to exercise — under the bridge prompt it passed only
  // by charitable interpretation (see the lean regression, run wf_19cdcdcb-4b7).
  const probe = await probeAgentType(probeRt, agentType, {
    probePrompt: LOCAL_AGENT_PROBE_PROMPT,
    ...(phase !== undefined ? { phase } : {}),
  })
  const defaults: AgentDefaults = probe.agentType !== undefined ? { agentType: probe.agentType } : {}

  if (probe.agentType === undefined) {
    rt.log(`[leaf-fence] ⚠ ${FENCE_UNAVAILABLE_MESSAGE} (requested: ${agentType}; reason: ${probe.reason ?? 'unknown'})`)
  }

  return {
    rt: withAgentDefaults(rt, defaults),
    report: {
      resolvedAgentType: probe.agentType ?? null,
      probe: { requested: agentType, available: probe.available, reason: probe.reason },
    },
  }
}
