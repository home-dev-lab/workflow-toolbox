// probe-agent-type.ts — run-time availability probe for an EXTERNAL agentType,
// with graceful fallback to the standard (Claude) subagent.
//
// Why this exists: cross-family bridge agents (workflow-toolbox:opencode-verifier,
// codex:codex-rescue, …) depend on a local CLI + credential the consumer may not
// have. The opencode bridge contract is to return the plain string
// `OPENCODE_UNAVAILABLE: <reason>` when its gate fails — but patterns force a
// JSON schema on verifier calls, so that marker would land in the
// StructuredOutput retry loop and either get coerced into junk or throw.
// probeAgentType() runs ONE schema-less probe task through the requested type
// BEFORE any routed role spawns, and resolves to `undefined` (the standard
// subagent) on any non-affirmative outcome — so downstream `<role>Type` options
// receive an agentType that is known to answer.
//
// Conventions:
// - Config errors throw synchronously at entry.
// - The probe NEVER forces a schema (the marker must stay a plain string).
// - Fallback is NEVER silent: both outcomes are rt.log()ed + emitted as a
//   phase digest (stage `probeAgentType`).
// - Give the probe its OWN phase (e.g. { phase: 'Probe' }) when the routed
//   pattern emits its own digest in the same phase — two digests resolving to
//   one phase are both dropped by observe (see envelope.ts ATTRIBUTION note).
// - Label: probeAgentType:probe.

import type { WorkflowRuntime } from '@workflow-toolbox/runtime'
import { emitDigest, assertAgentTypeOption } from './envelope.js'

const STAGE = 'probeAgentType'

// The wording is load-bearing: an early draft said "no verification needed"
// and a haiku bridge SHORTCUT it — replied OK itself without running its
// availability gate or the external CLI (observed live 2026-07-09, zero
// tool_use in the transcript), turning the probe into a false positive.
// The probe must demand the FULL procedure so the reply exercises the real
// gate + CLI chain.
// PROBE_OK (not a natural word): review finding — an end-anchored match on a
// natural token like 'OK' reads "not OK" as available; a negation ending
// exactly with an artificial token is implausible.
const DEFAULT_PROBE_PROMPT =
  'Availability probe. This is a REAL task: execute your normal procedure end-to-end ' +
  '(availability gate, then run the task through your external CLI — do NOT answer ' +
  'from your own knowledge). Task: reply with exactly: PROBE_OK'
const DEFAULT_EXPECTED_TOKEN = 'PROBE_OK'

/** Probe prompt for LOCALLY-REGISTERED agentTypes (`workflow-toolbox:lean`,
 *  `workflow-toolbox:leaf`, a consumer's own fenced type): there is no
 *  availability gate or CLI chain to exercise — the only question is "is the
 *  type registered and does it answer?", so self-answering IS the correct
 *  procedure and the prompt says so. The bridge DEFAULT above is WRONG for
 *  these: its external-CLI demand is exactly what a tool-less lean agent must
 *  honestly refuse (observed live 2026-07-13, run wf_19cdcdcb-4b7 — the
 *  refusal was classified unavailable and the run silently kept the full
 *  ambient context lean exists to strip). Pass via `{ probePrompt }` from any
 *  local-type wrapper (withLeanRouting / withLeafFence do). */
export const LOCAL_AGENT_PROBE_PROMPT =
  'Availability probe. This task is fully self-contained: it needs no tools and no ' +
  'lookup — answering directly from this prompt is the correct procedure. ' +
  'Task: reply with exactly: PROBE_OK'

/** Cap unavailability reasons to a headline excerpt (never dump a full CLI error). */
const REASON_HEAD_CHARS = 200

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentTypeProbe {
  /** The resolved routing value: the requested type when available, `undefined`
   *  (standard subagent) when not — feed it straight into a `<role>Type` option. */
  agentType: string | undefined
  available: boolean
  /** Head excerpt of the unavailability marker / error text; null when available. */
  reason: string | null
}

/** The probe story a WORKFLOW surfaces in its own result (`probe` field):
 *  what was requested + whether it answered + why not. Derive from this type
 *  instead of re-inlining the shape — one shared point of enforcement for
 *  every workflow's probe report. */
export interface AgentTypeProbeReport {
  /** The agentType the caller requested (e.g. via `args.agentTypes.<role>`). */
  requested: string
  available: boolean
  reason: string | null
}

export interface ProbeAgentTypeOptions {
  phase?: string
  /** Override the trivial probe task sent through the bridge. Pair with
   *  `expectedToken` when the custom prompt asks for a different reply. */
  probePrompt?: string
  /** The affirmative token the probe reply must END with (after ANSI/banner
   *  stripping). Default 'PROBE_OK'. */
  expectedToken?: string
  /** When true, an UNAVAILABLE probe THROWS an actionable error instead of
   *  degrading to the standard subagent. For an agentType the USER explicitly
   *  configured (e.g. agentTypes.verify) where the cross-family semantics ARE
   *  the step's meaning — silently degrading betrays that intent and burns the
   *  run's tokens on verdicts a downstream gate then voids. Default false =
   *  graceful degrade (library default-routing / optional optimisation). */
  required?: boolean
}

// ---------------------------------------------------------------------------
// Reply classification helpers
// ---------------------------------------------------------------------------

/** Strip ANSI SGR sequences — both real ESC-prefixed codes and the bare `[0m`
 *  artifacts that survive shell capture of CLI banners. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b?\[[0-9;]*m/g, '')
}

function head(text: string): string {
  const t = text.trim()
  return t.length > REASON_HEAD_CHARS ? `${t.slice(0, REASON_HEAD_CHARS)}…` : t
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Probe an external agentType ONCE (schema-less trivial task) and resolve the
 * routing value for downstream `<role>Type` options: the requested type when
 * the bridge answered affirmatively, `undefined` (standard subagent) otherwise.
 *
 * Unavailable outcomes (all degrade, never throw): a reply containing
 * `UNAVAILABLE` (the `OPENCODE_UNAVAILABLE: <reason>`-style bridge contract),
 * a null return (opaque agent failure), or any reply that does not end with
 * the expected token (e.g. a verbatim CLI error). Config errors (blank
 * agentType / expectedToken) throw synchronously at entry.
 *
 * @example
 * ```ts
 * import { probeAgentType, adversarialVerification } from '@workflow-toolbox/patterns'
 *
 * // input.verifierType e.g. 'workflow-toolbox:opencode-verifier' (user opt-in)
 * const probe = input.verifierType !== undefined
 *   ? await probeAgentType(rt, input.verifierType, { phase: 'Probe' })
 *   : { agentType: undefined, available: false, reason: null }
 *
 * const result = await adversarialVerification(rt, {
 *   claims,
 *   renderClaim,
 *   // resolved: the external type when it answered, standard subagent otherwise
 *   ...(probe.agentType !== undefined ? { verifierType: probe.agentType } : {}),
 * })
 * ```
 */
export async function probeAgentType(
  rt: WorkflowRuntime,
  agentType: string,
  options: ProbeAgentTypeOptions = {},
): Promise<AgentTypeProbe> {
  const { phase, probePrompt, expectedToken, required } = options

  // -------------------------------------------------------------------------
  // Synchronous validation
  // -------------------------------------------------------------------------

  assertAgentTypeOption(STAGE, 'agentType', agentType)

  if (expectedToken !== undefined && expectedToken.trim().length === 0) {
    throw new Error(
      `${STAGE}: expectedToken must be a non-empty string — omit it for the default 'PROBE_OK'`,
    )
  }

  const token = expectedToken ?? DEFAULT_EXPECTED_TOKEN
  const prompt = probePrompt ?? DEFAULT_PROBE_PROMPT

  // -------------------------------------------------------------------------
  // The single schema-less probe call.
  //
  // try/catch is load-bearing: the runtime THROWS on an agentType that is not
  // in the session registry (observed live 2026-07-09 in a headless/server-
  // launched run, where plugin agents are not loaded) — the most common
  // unavailability mode for consumers without the bridge plugin installed.
  // A probe failure must degrade to the standard subagent, never abort the run.
  // -------------------------------------------------------------------------

  let reply: string | null
  let spawnError: string | null = null
  try {
    reply = await rt.agent<string>(prompt, {
      label: `${STAGE}:probe`,
      agentType,
      ...(phase !== undefined ? { phase } : {}),
    })
  } catch (e) {
    reply = null
    spawnError = head(e instanceof Error ? e.message : String(e))
  }

  // -------------------------------------------------------------------------
  // Classification — negative signals FIRST ('OK, but …UNAVAILABLE…' must
  // never read as available), then the affirmative ends-with check (bridge
  // CLIs concatenate banner + reply, so a word-boundary match is unreliable).
  // -------------------------------------------------------------------------

  let available = false
  let reason: string | null = null

  if (reply === null) {
    reason = spawnError ?? 'probe agent returned null'
  } else if (typeof reply !== 'string') {
    // Schema-less agent() returns a string on the real runtime; anything else
    // (possible with a test FakeRuntime handler) is a non-affirmative outcome.
    reason = 'non-string probe reply'
  } else {
    const stripped = stripAnsi(reply).trim()
    const endsWithToken = new RegExp(`${escapeRegExp(token)}\\s*[.!]?$`).test(stripped)

    if (stripped.includes('UNAVAILABLE')) {
      // Excerpt FROM the marker, not from the reply start — a long CLI banner
      // must never push the marker + its reason past the head cap (review finding).
      const marker = /\S*UNAVAILABLE[\s\S]*/.exec(stripped)
      reason = head(marker ? marker[0] : stripped)
    } else if (endsWithToken) {
      available = true
    } else {
      reason = `unexpected probe reply: ${head(stripped)}`
    }
  }

  // -------------------------------------------------------------------------
  // Never silent — log + digest for both outcomes
  // -------------------------------------------------------------------------

  if (!available && required === true) {
    rt.log(
      `${STAGE}: required '${agentType}' unavailable — refusing launch (${reason ?? 'unknown'})`,
    )
    emitDigest(rt, {
      stage: STAGE,
      ...(phase !== undefined ? { phase } : {}),
      output: `required-unavailable: ${agentType}`,
    })
    throw new Error(
      `${STAGE}: required agentType '${agentType}' is unavailable (${reason ?? 'unknown'}) — its explicit routing cannot be honored, so the run is refused at launch rather than silently degraded. Remedy: ensure the agentType is registered and its provider installed/authenticated, or remove the explicit routing (agentTypes.<role>) to allow the standard-subagent fallback.`,
    )
  }

  if (available) {
    rt.log(`${STAGE}: '${agentType}' available — routing externally`)
  } else {
    rt.log(
      `${STAGE}: '${agentType}' unavailable — falling back to the standard subagent (${reason ?? 'unknown'})`,
    )
  }

  emitDigest(rt, {
    stage: STAGE,
    ...(phase !== undefined ? { phase } : {}),
    output: available ? `available: ${agentType}` : 'fallback: standard subagent',
  })

  return {
    agentType: available ? agentType : undefined,
    available,
    reason,
  }
}
