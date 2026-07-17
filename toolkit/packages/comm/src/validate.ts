// validate.ts — the generic (but scoped) JSON-Schema-subset interpreter, plus the
// cross-field/cross-message rules plain JSON Schema can't express. NO ajv anywhere: this
// interpreter walks the `as const` schema literals in schemas.ts by hand, reading every
// bound/pattern FROM them (never a duplicated literal) — the single source of truth the
// README's "Reading" section requires.
//
// READER POSTURE (normative, see ../README.md "Reading"): every DECLARED property of the
// matching schema const is checked (type/bounds/pattern/enum/required); unknown keys are
// dropped from the returned value, never rejected — `additionalProperties: false` binds
// WRITERS (fs.ts's writeMessage re-derives the canonical on-disk JSON by running the
// caller's message back through this SAME interpreter, so excess fields can never reach
// disk; this module needs only ONE mode, not a separate strict-write variant).
//
// `inReplyTo` is the one exception to "unknown keys are silently dropped": it is a KNOWN
// envelope field whose presence is TYPE-CONDITIONAL (required on decision.response,
// forbidden elsewhere) — getting it wrong is a protocol violation, not a forward-compat
// additive field, so it is checked explicitly, ahead of the generic per-type walk.

import { isRecord } from '@workflow-toolbox/std'
import type { JsonSchema } from '@workflow-toolbox/runtime'
import {
  WT_COMM_SCHEMA_VERSION,
  WT_COMM_SCHEMAS,
  ACK_MARKER_SCHEMA,
  SETTLEMENT_MARKER_SCHEMA,
  type WtCommMessage,
  type WtCommMessageType,
  type QuestionMessage,
  type DecisionMessage,
  type AckMarker,
  type SettlementMarker,
} from './schemas.js'
import { decisionIdFor, isValidDecisionId } from './ids.js'

// ===========================================================================
// The generic interpreter — object/string/integer/number/boolean/array, reading every
// bound straight off the schema node. Scoped to what wt-comm's own consts use; not a
// general-purpose JSON Schema implementation.
// ===========================================================================

type NodeResult = { ok: true; value: unknown } | { ok: false }

function validateNode(schema: JsonSchema, value: unknown): NodeResult {
  // anyOf (v0.2, for the hint provenance union): first matching branch wins. Branches are
  // discriminated by their own `source` enums, so the match is deterministic; the winning
  // branch's canonical value (declared properties only) is what survives.
  const anyOf = schema['anyOf'] as readonly JsonSchema[] | undefined
  if (anyOf !== undefined) {
    for (const branch of anyOf) {
      const branchResult = validateNode(branch, value)
      if (branchResult.ok) return branchResult
    }
    return { ok: false }
  }

  const type = schema['type']

  if (type === 'object') {
    if (!isRecord(value)) return { ok: false }
    const properties = (schema['properties'] as Record<string, JsonSchema> | undefined) ?? {}
    const required = (schema['required'] as readonly string[] | undefined) ?? []
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return { ok: false }
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue
      const propSchema = properties[key]
      if (propSchema === undefined) continue
      const propResult = validateNode(propSchema, value[key])
      if (!propResult.ok) return { ok: false }
      out[key] = propResult.value
    }
    return { ok: true, value: out }
  }

  if (type === 'array') {
    if (!Array.isArray(value)) return { ok: false }
    const minItems = schema['minItems'] as number | undefined
    const maxItems = schema['maxItems'] as number | undefined
    if (minItems !== undefined && value.length < minItems) return { ok: false }
    if (maxItems !== undefined && value.length > maxItems) return { ok: false }
    const items = schema['items'] as JsonSchema | undefined
    const out: unknown[] = []
    for (const el of value) {
      if (items === undefined) {
        out.push(el)
        continue
      }
      const elResult = validateNode(items, el)
      if (!elResult.ok) return { ok: false }
      out.push(elResult.value)
    }
    return { ok: true, value: out }
  }

  if (type === 'string') {
    if (typeof value !== 'string') return { ok: false }
    const minLength = schema['minLength'] as number | undefined
    const maxLength = schema['maxLength'] as number | undefined
    const pattern = schema['pattern'] as string | undefined
    const enumValues = schema['enum'] as readonly string[] | undefined
    if (minLength !== undefined && value.length < minLength) return { ok: false }
    if (maxLength !== undefined && value.length > maxLength) return { ok: false }
    if (pattern !== undefined && !new RegExp(pattern).test(value)) return { ok: false }
    if (enumValues !== undefined && !enumValues.includes(value)) return { ok: false }
    return { ok: true, value }
  }

  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false }
    const minimum = schema['minimum'] as number | undefined
    const maximum = schema['maximum'] as number | undefined
    if (minimum !== undefined && value < minimum) return { ok: false }
    if (maximum !== undefined && value > maximum) return { ok: false }
    return { ok: true, value }
  }

  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false }
    return { ok: true, value }
  }

  if (type === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false }
    return { ok: true, value }
  }

  return { ok: false }
}

// ===========================================================================
// parseMessage — the full envelope+payload read path, per ../README.md "Reading".
// ===========================================================================

export type ParseFailureReason = 'malformed' | 'unsupported-version' | 'provenance'

export type ParseMessageResult = { ok: true; message: WtCommMessage } | { ok: false; reason: ParseFailureReason }

function isProvenanceLegal(role: string, type: WtCommMessageType): boolean {
  if (role === 'agent') return type === 'escalation.question' || type === 'status.digest'
  if (role === 'pilot') return type === 'decision.response'
  // v0.2: observers produce ONLY observer.* types — never decisions (observers don't
  // decide) and never escalations (an observer that wants the pilot's attention goes
  // through its own nudge channel, outside this tree). The agent/pilot branches above
  // stay closed enumerations, so neither can ever produce an observer.* type.
  if (role === 'observer') return type.startsWith('observer.')
  return false
}

export function parseMessage(text: string): ParseMessageResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'malformed' }

  // schemaVersion: exactly 1 accepted; >1 -> unsupported-version; anything else
  // (non-integer, absent, or < 1) -> malformed (README "Versioning" + design invariant #13).
  const schemaVersionRaw = parsed['schemaVersion']
  if (typeof schemaVersionRaw !== 'number' || !Number.isInteger(schemaVersionRaw)) {
    return { ok: false, reason: 'malformed' }
  }
  if (schemaVersionRaw > WT_COMM_SCHEMA_VERSION) return { ok: false, reason: 'unsupported-version' }
  if (schemaVersionRaw < WT_COMM_SCHEMA_VERSION) return { ok: false, reason: 'malformed' }

  const typeRaw = parsed['type']
  if (typeof typeRaw !== 'string' || !(typeRaw in WT_COMM_SCHEMAS)) {
    return { ok: false, reason: 'malformed' }
  }
  const type = typeRaw as WtCommMessageType

  // inReplyTo: envelope-level, type-conditional — required+shaped on decision.response,
  // explicitly FORBIDDEN elsewhere. Checked ahead of the generic walk (see module doc).
  const hasInReplyTo = Object.prototype.hasOwnProperty.call(parsed, 'inReplyTo')
  if (type === 'decision.response') {
    if (!hasInReplyTo) return { ok: false, reason: 'malformed' }
  } else if (hasInReplyTo) {
    return { ok: false, reason: 'malformed' }
  }

  const schema = WT_COMM_SCHEMAS[type]
  const result = validateNode(schema, parsed)
  if (!result.ok) return { ok: false, reason: 'malformed' }
  const message = result.value as WtCommMessage

  if (message.type === 'escalation.question') {
    const optionIds = message.payload.options.map((o) => o.id)
    if (!optionIds.includes(message.payload.defaultOptionId)) return { ok: false, reason: 'malformed' }
  }

  if (message.type === 'decision.response' && !isValidDecisionId(message.id)) {
    return { ok: false, reason: 'malformed' }
  }

  // Cross-field (v0.2): a transcript provenance window is half-open [fromOffset,
  // toOffset) and must be non-empty — an empty citation grounds nothing (design S1).
  if (message.type === 'observer.hint') {
    for (const p of message.payload.provenance) {
      if (p.source === 'transcript' && p.toOffset <= p.fromOffset) {
        return { ok: false, reason: 'malformed' }
      }
    }
  }

  if (!isProvenanceLegal(message.from.role, message.type)) return { ok: false, reason: 'provenance' }

  return { ok: true, message }
}

// ===========================================================================
// validateDecisionAgainstQuestion — cross-message rule (README point 10).
// ===========================================================================

export function validateDecisionAgainstQuestion(question: QuestionMessage, decision: DecisionMessage): boolean {
  if (decision.from.role !== 'pilot') return false
  if (decision.inReplyTo !== question.id) return false
  if (decision.id !== decisionIdFor(question.id)) return false
  return question.payload.options.some((o) => o.id === decision.payload.decision)
}

// ===========================================================================
// Settlement coherence — shared by claimSettlement's PRE-write check (fs.ts) and
// validateSettlement's POST-write re-check (README point 9: "the same rules are
// re-checked at read, for markers written by non-library writers").
// ===========================================================================

/** Everything a settlement marker needs EXCEPT the `id` (fs.ts derives that from the
 *  message being settled) — a claimSettlement caller supplies this; the persisted marker
 *  is this plus `id`. */
export type SettlementClaim = Omit<SettlementMarker, 'id'>

export function validateSettlement(message: WtCommMessage, claim: SettlementClaim): boolean {
  if (claim.mode === 'decision') {
    if (message.type !== 'escalation.question') return false
    if (claim.by.role !== 'pilot') return false
    if (claim.outcome === undefined) return false
    return message.payload.options.some((o) => o.id === claim.outcome)
  }
  if (claim.mode === 'default-timeout') {
    if (message.type !== 'escalation.question') return false
    if (claim.by.role !== 'agent') return false
    return claim.outcome === message.payload.defaultOptionId
  }
  // mode === 'read'
  return claim.by.role === message.to.role
}

// ===========================================================================
// Ack / settlement marker parsers — tolerant, own schema consts (README point 5).
// ===========================================================================

export function parseAckMarker(text: string): AckMarker | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const result = validateNode(ACK_MARKER_SCHEMA, parsed)
  return result.ok ? (result.value as AckMarker) : null
}

export function parseSettlementMarker(text: string): SettlementMarker | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const result = validateNode(SETTLEMENT_MARKER_SCHEMA, parsed)
  return result.ok ? (result.value as SettlementMarker) : null
}

/** Exposed for writeMessage/writeAck/claimSettlement (fs.ts): re-derives the CANONICAL
 *  on-disk form of an already-typed value (only declared properties survive), so a
 *  caller-injected excess field can never reach disk without a second, duplicated
 *  "strict write" code path — see module doc. Returns null if `value` fails its own
 *  declared bounds/patterns (a runtime safety net; TS types don't check string length or
 *  regex shape at compile time).
 *
 *  NOTE: only used internally by writeAck/claimSettlement for the two marker schemas —
 *  writeMessage instead round-trips through parseMessage itself (fs.ts) so the
 *  cross-field rules (inReplyTo, defaultOptionId membership, provenance) apply on write
 *  too, not just the generic shape/bounds this helper covers. */
export function canonicalize<T>(schema: JsonSchema, value: unknown): T | null {
  const result = validateNode(schema, value)
  return result.ok ? (result.value as T) : null
}
