// lean-routing.ts — apply the toolkit's minimal-ambient-context `lean` agentType
// as an agent() default for PURE-REASONING roles (classify / vote / judge /
// score / dedup / synthesize) whose entire task content arrives inline in the
// prompt and that never read a file, run a command, or call any tool.
//
// WHY THIS EXISTS: every agent a toolkit workflow spawns inherits the FULL
// ambient context of the launching session — every rule, the memory index, the
// whole skill/MCP tool listing — injected as text on every single spawn, paid
// as a cache-WRITE per agent (observed ~950k tokens on one demo run whose
// agents each did nothing more than score a candidate 1-5). A role that never
// needs a tool gains nothing from that injection; it only pays for it. Routing
// such a role through a registered agentType whose OWN `tools` allowlist is
// empty (`plugin/agents/lean.md`) strips the tool/skill/MCP text the harness
// would otherwise inject for that spawn.
//
// PURITY IS A PER-CALL-SITE JUDGMENT, NOT A PER-PATTERN ONE: the SAME pattern
// (e.g. adversarialVerification) can be pure in one composition and impure in
// another, because purity depends on what the CALLER's renderClaim/prompt asks
// the agent to do. pr-review's own verify stage instructs its verifiers to
// "open the actual diff and re-derive" (a fresh-evidence defence) — those
// calls need real tool access and must NOT be routed here. Only route a call
// whose prompt is provably self-contained (no "inspect the repo" / "read the
// diff" / "run git" instruction anywhere in it).
//
// WHY A WRAPPER, NOT A PATTERN-INTERNAL DEFAULT: identical reasoning to
// withLeafFence (see leaf-fence.ts) — every pattern already omits `agentType`
// unless the caller sets it, which is what lets an outer `withAgentDefaults`
// (a workflow author's blanket `perAgent.agentType`, or a per-role override)
// flow through untouched. Applying the lean default as the wrapper's OWN
// (innermost-of-its-scope) `withAgentDefaults` layer preserves that precedence
// with zero changes to any pattern's internal call sites.
//
// GRACEFUL BY CONSTRUCTION: probeAgentType() is the same probe/fallback
// convention withLeafFence and the cross-family bridges already use — a
// workflow running where the `workflow-toolbox` plugin isn't installed (so
// `workflow-toolbox:lean` isn't a registered agentType) degrades to the
// standard subagent instead of throwing.
//
// SELECTIVE, UNLIKE withLeafFence: the leaf fence is meant to apply to EVERY
// agent a workflow spawns (the SendMessage denial is a blanket safety
// property). Lean routing is NOT blanket — a workflow calls this once to get
// a lean-defaulting runtime, then uses THAT runtime only for the specific
// stages it has verified are pure, while impure stages keep using the
// leaf-fenced (or plain) runtime. See pr-review.workflow.ts's Synthesize stage
// for the reference wiring.

import type { AgentDefaults, WorkflowRuntime } from '@workflow-toolbox/runtime'
import { withAgentDefaults } from '@workflow-toolbox/runtime'
import { probeAgentType } from './probe-agent-type.js'
import type { AgentTypeProbeReport } from './probe-agent-type.js'

/** The toolkit's own minimal-ambient-context agentType (plugin-scoped name;
 *  ships as `plugin/agents/lean.md`, empty `tools` allowlist + `disallowedTools:
 *  SendMessage`). */
export const LEAN_AGENT_TYPE = 'workflow-toolbox:lean'

export interface WithLeanRoutingOptions {
  /** Phase label for the probe's own digest emission (see probeAgentType). Omit
   *  to use whatever phase is current when the probe runs. */
  phase?: string
  /** Override which agentType lean routing probes/applies. Default:
   *  LEAN_AGENT_TYPE. Escape hatch for a consumer that ships its OWN minimal
   *  agentType under a different name (e.g. a private plugin) instead of the
   *  toolkit's. */
  agentType?: string
  /** Opt OUT of lean routing entirely — returns `rt` unchanged, no probe spent.
   *  Default false — routing applies. A workflow that wants every one of its
   *  pure-reasoning calls to keep the ambient session context (e.g. while
   *  debugging what a leaf actually sees) sets this once at the call site. */
  disabled?: boolean
  /** A workflow's own blanket per-agent defaults (the SAME object you'd pass to
   *  an outer `withAgentDefaults(leanRt, config.perAgent)` afterward), applied
   *  to lean routing's OWN internal probe call ONLY — mirrors
   *  `WithLeafFenceOptions.perAgent` exactly; see leaf-fence.ts for the full
   *  rationale (without this the probe silently ran on the raw session
   *  model/effort even when the workflow declares a blanket override). */
  perAgent?: AgentDefaults
}

/** The lean-routing probe story, for a workflow that wants to surface it in
 *  its own result (mirrors `LeafFenceReport` and the `probe`/`verifierProbe`
 *  fields pr-review already returns for its other opt-in agentType routing). */
export interface LeanRoutingReport {
  /** The agentType actually applied as the default; null = no lean routing
   *  (disabled, or the requested type could not answer and the run degraded to
   *  whatever default the wrapped runtime already carried — see `probe`). */
  resolvedAgentType: string | null
  /** Null when lean routing was disabled (no probe was spent). */
  probe: AgentTypeProbeReport | null
}

// Fail-open must be LOUD, same rationale as withLeafFence: the probe/fallback
// convention is deliberately graceful (never abort a run over a missing
// agentType), but a SILENT degradation here means every call routed through
// the returned runtime keeps paying the full ambient-context cost lean exists
// to avoid, with nobody noticing short of inspecting the returned report.
const ROUTING_UNAVAILABLE_MESSAGE =
  'routing UNAVAILABLE — calls through this runtime keep the FULL ambient context this run (no lean savings)'

/**
 * Wrap `rt` so every agent() call made THROUGH THE RETURNED runtime defaults to
 * the lean agentType — UNLESS that call (or a further outer `withAgentDefaults`/
 * per-role override) already sets its own `agentType`, which always wins.
 *
 * Unlike `withLeafFence`, this is NOT meant to wrap the workflow's whole `rt`
 * once at the top of `run()` — call it to obtain a SEPARATE lean-defaulting
 * runtime, then route ONLY the call sites you have verified are pure (their
 * entire task content is inline in the prompt; no "read the file" / "inspect
 * the diff" / "run this command" instruction anywhere in it) through that
 * runtime. Every other call keeps using the workflow's normal runtime.
 *
 * Composition with withLeafFence: call this on the ALREADY-fenced runtime
 * (the same `rt` withLeafFence returned) so a lean call still carries the
 * fence's own SendMessage denial as its fallback default if the lean agentType
 * itself is unavailable — `lean.md` denies SendMessage too, so this is
 * belt-and-braces, not load-bearing.
 *
 * @example
 * ```ts
 * async function run(rt0: WorkflowRuntime, input: MyInput) {
 *   const { rt: fenced } = await withLeafFence(rt0)
 *   const { rt: leanRt, report: leanRouting } = await withLeanRouting(fenced, {
 *     ...(input.perAgent !== null ? { perAgent: input.perAgent } : {}),
 *   })
 *   // tool-needing stages: fenced.agent(...) / rt.agent(...)
 *   // provably pure stages (e.g. a synthesis over already-inline content):
 *   const verdict = await leanRt.agent(synthesisPrompt, { schema, label: '...' })
 *   return { ..., leanRouting }
 * }
 * ```
 */
export async function withLeanRouting(
  rt: WorkflowRuntime,
  options: WithLeanRoutingOptions = {},
): Promise<{ rt: WorkflowRuntime; report: LeanRoutingReport }> {
  const { phase, agentType = LEAN_AGENT_TYPE, disabled = false, perAgent } = options

  if (disabled) {
    return { rt, report: { resolvedAgentType: null, probe: null } }
  }

  // The probe call inherits perAgent's model/effort/isolation/stallMs (NOT
  // agentType — probeAgentType always sets its OWN explicit agentType, which
  // wins regardless of what perAgent carries). Without this, the probe
  // silently ran on the raw session model even when the workflow declares a
  // blanket override.
  const probeRt = perAgent !== undefined ? withAgentDefaults(rt, perAgent) : rt
  const probe = await probeAgentType(probeRt, agentType, phase !== undefined ? { phase } : {})
  const defaults: AgentDefaults = probe.agentType !== undefined ? { agentType: probe.agentType } : {}

  if (probe.agentType === undefined) {
    rt.log(`[lean-routing] ⚠ ${ROUTING_UNAVAILABLE_MESSAGE} (requested: ${agentType}; reason: ${probe.reason ?? 'unknown'})`)
  }

  return {
    rt: withAgentDefaults(rt, defaults),
    report: {
      resolvedAgentType: probe.agentType ?? null,
      probe: { requested: agentType, available: probe.available, reason: probe.reason },
    },
  }
}
