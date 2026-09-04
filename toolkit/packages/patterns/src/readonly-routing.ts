// DELIBERATE DUPLICATION of lean-routing.ts — do not factor the two together.
// They have DIFFERENT REASONS TO CHANGE: lean routing strips ambient context so a
// pure-reasoning call stops paying for tools it never uses; read-only routing denies
// MUTATION so a call whose output is knowledge cannot write, execute or message. A shared
// abstraction would couple two concepts that will evolve apart, which costs more to undo
// than the duplication costs to keep. Same shape, different subject.

import type { AgentDefaults, WorkflowRuntime } from '@workflow-toolbox/runtime'
import { withAgentDefaults } from '@workflow-toolbox/runtime'
import { probeAgentType, LOCAL_AGENT_PROBE_PROMPT } from './probe-agent-type.js'
import type { AgentTypeProbeReport } from './probe-agent-type.js'

/** The toolkit's read-only agentType, limited to Read, Grep, and Glob. */
export const READONLY_AGENT_TYPE = 'workflow-toolbox:leaf-readonly'

export interface WithReadOnlyRoutingOptions {
  /** Phase label for the probe's own digest emission (see probeAgentType). */
  phase?: string
  /** Override which read-only agentType routing probes and applies. */
  agentType?: string
  /** Opt out of read-only routing entirely, returning rt unchanged without probing. */
  disabled?: boolean
  /** Workflow blanket defaults applied to the internal probe call only. */
  perAgent?: AgentDefaults
}

export interface ReadOnlyRoutingReport {
  /** The agentType applied as the default, or null when disabled or unavailable. */
  resolvedAgentType: string | null
  /** Null when routing was disabled and no probe was spent. */
  probe: AgentTypeProbeReport | null
}

const ROUTING_UNAVAILABLE_MESSAGE =
  'routing UNAVAILABLE — calls through this runtime keep their existing agentType default this run (no read-only protection)'

/**
 * Wrap `rt` so agent() calls made through the returned runtime default to the
 * read-only agentType. This is selective: route only call sites that produce
 * knowledge and can operate with Read, Grep, and Glob; mutation-capable stages
 * keep using the original runtime.
 */
export async function withReadOnlyRouting(
  rt: WorkflowRuntime,
  options: WithReadOnlyRoutingOptions = {},
): Promise<{ rt: WorkflowRuntime; report: ReadOnlyRoutingReport }> {
  const { phase, agentType = READONLY_AGENT_TYPE, disabled = false, perAgent } = options

  if (disabled) {
    return { rt, report: { resolvedAgentType: null, probe: null } }
  }

  const probeRt = perAgent !== undefined ? withAgentDefaults(rt, perAgent) : rt
  const probe = await probeAgentType(probeRt, agentType, {
    probePrompt: LOCAL_AGENT_PROBE_PROMPT,
    ...(phase !== undefined ? { phase } : {}),
  })
  const defaults: AgentDefaults = probe.agentType !== undefined ? { agentType: probe.agentType } : {}

  if (probe.agentType === undefined) {
    rt.log(`[readonly-routing] ⚠ ${ROUTING_UNAVAILABLE_MESSAGE} (requested: ${agentType}; reason: ${probe.reason ?? 'unknown'})`)
  }

  return {
    rt: withAgentDefaults(rt, defaults),
    report: {
      resolvedAgentType: probe.agentType ?? null,
      probe: { requested: agentType, available: probe.available, reason: probe.reason },
    },
  }
}
