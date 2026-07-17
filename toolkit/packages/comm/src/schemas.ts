// schemas.ts — the wt-comm v0 JSON Schema consts (single source of truth for every bound
// and pattern the library enforces) plus the FromSchema-derived TS types. See
// ../README.md for the normative spec these consts encode.
//
// Zero runtime schema library: NO ajv anywhere. json-schema-to-ts's `FromSchema` is a
// type-only import (erased at compile time) — the RUNTIME validator (validate.ts) walks
// these same consts by hand, reading every bound/pattern FROM them (never duplicating a
// literal), per the README's "Reading" reader posture.

import type { FromSchema } from 'json-schema-to-ts'
import type { JsonSchema } from '@workflow-toolbox/runtime'

export const WT_COMM_SCHEMA_VERSION = 1 as const

// ===========================================================================
// Id + timestamp patterns — the SINGLE source; every schema const below embeds
// `.source`, and ids.ts imports these RegExp objects directly for its own guards.
// ===========================================================================

/** Base ids (`escalation.question`, `status.digest`): 1-96 chars, lowercase
 *  alphanumerics and dashes, and NEVER "--" (reserved as the decision-derivation
 *  separator) — the negative lookahead rejects "--" ANYWHERE in the id. */
export const BASE_ID_PATTERN = /^(?!.*--)[a-z0-9][a-z0-9-]{0,95}$/

/** Derived decision ids: `decisionIdFor(qid) = qid + '--decision'`, <=106 chars.
 *  This regex alone accepts a base containing an EXTRA "--" before the suffix
 *  (e.g. "ab--cd--decision") — `isValidDecisionId` (ids.ts) additionally enforces
 *  the "exactly one '--' occurrence" invariant the regex can't express. */
export const DECISION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,95}--decision$/

/** Option ids inside an `escalation.question`'s `options[]` and every settlement
 *  `outcome` (always one of those option ids). */
export const OPTION_ID_PATTERN = /^[a-z0-9-]{1,32}$/

/** Strict UTC Zulu timestamp, optional milliseconds. Shared by every envelope's
 *  `at` and by ack/settlement markers' own `at`. */
export const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

/** v0.2: 'observer' joins the envelope role union — for BOTH `from` and `to`. No v0.2
 *  message type is ADDRESSED to an observer (hints go to agents), but the envelope
 *  grammar admits it: forbidding it would buy nothing (write legality is the from-role
 *  x type matrix, not the address) and would cost an asymmetric grammar. */
const ROLE_ENUM = ['agent', 'pilot', 'observer'] as const

// ===========================================================================
// Shared envelope fragments
// ===========================================================================

const FROM_SCHEMA = {
  type: 'object',
  properties: {
    role: { type: 'string', enum: ROLE_ENUM },
    id: { type: 'string', minLength: 1, maxLength: 128 },
  },
  required: ['role', 'id'],
  additionalProperties: false,
} as const satisfies JsonSchema

const TO_SCHEMA = {
  type: 'object',
  properties: {
    role: { type: 'string', enum: ROLE_ENUM },
    id: { type: 'string', minLength: 1, maxLength: 128 },
  },
  required: ['role'],
  additionalProperties: false,
} as const satisfies JsonSchema

const AT_SCHEMA = {
  type: 'string',
  pattern: AT_PATTERN.source,
  minLength: 20,
  maxLength: 24,
} as const satisfies JsonSchema

const RUN_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
} as const satisfies JsonSchema

const OPTION_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: OPTION_ID_PATTERN.source, minLength: 1, maxLength: 32 },
    label: { type: 'string', minLength: 3, maxLength: 200 },
    meaning: { type: 'string', minLength: 1, maxLength: 400 },
  },
  required: ['id', 'label'],
  additionalProperties: false,
} as const satisfies JsonSchema

// ===========================================================================
// escalation.question (agent -> pilot)
// ===========================================================================

export const QUESTION_MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer' },
    id: { type: 'string', pattern: BASE_ID_PATTERN.source, minLength: 1, maxLength: 96 },
    type: { type: 'string', enum: ['escalation.question'] },
    from: FROM_SCHEMA,
    to: TO_SCHEMA,
    runId: RUN_ID_SCHEMA,
    at: AT_SCHEMA,
    payload: {
      type: 'object',
      properties: {
        kind: { type: 'string', minLength: 1, maxLength: 64 },
        options: { type: 'array', minItems: 2, maxItems: 8, items: OPTION_SCHEMA },
        defaultOptionId: { type: 'string', pattern: OPTION_ID_PATTERN.source, minLength: 1, maxLength: 32 },
        question: { type: 'string', minLength: 20, maxLength: 2000 },
        evidence: { type: 'string', minLength: 1, maxLength: 2000 },
        context: { type: 'string', minLength: 1, maxLength: 1000 },
      },
      required: ['kind', 'options', 'defaultOptionId', 'question'],
      additionalProperties: false,
    },
  },
  required: ['schemaVersion', 'id', 'type', 'from', 'to', 'at', 'payload'],
  additionalProperties: false,
} as const satisfies JsonSchema

export type QuestionMessage = FromSchema<typeof QUESTION_MESSAGE_SCHEMA>

// ===========================================================================
// decision.response (pilot -> agent)
// ===========================================================================

export const DECISION_MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer' },
    id: { type: 'string', pattern: DECISION_ID_PATTERN.source, minLength: 1, maxLength: 106 },
    type: { type: 'string', enum: ['decision.response'] },
    from: FROM_SCHEMA,
    to: TO_SCHEMA,
    runId: RUN_ID_SCHEMA,
    at: AT_SCHEMA,
    inReplyTo: { type: 'string', pattern: BASE_ID_PATTERN.source, minLength: 1, maxLength: 96 },
    payload: {
      type: 'object',
      properties: {
        decision: { type: 'string', pattern: OPTION_ID_PATTERN.source, minLength: 1, maxLength: 32 },
        reason: { type: 'string', minLength: 1, maxLength: 1000 },
      },
      required: ['decision'],
      additionalProperties: false,
    },
  },
  required: ['schemaVersion', 'id', 'type', 'from', 'to', 'at', 'inReplyTo', 'payload'],
  additionalProperties: false,
} as const satisfies JsonSchema

export type DecisionMessage = FromSchema<typeof DECISION_MESSAGE_SCHEMA>

// ===========================================================================
// status.digest (agent -> pilot)
// ===========================================================================

export const DIGEST_MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer' },
    id: { type: 'string', pattern: BASE_ID_PATTERN.source, minLength: 1, maxLength: 96 },
    type: { type: 'string', enum: ['status.digest'] },
    from: FROM_SCHEMA,
    to: TO_SCHEMA,
    runId: RUN_ID_SCHEMA,
    at: AT_SCHEMA,
    payload: {
      type: 'object',
      properties: {
        seq: { type: 'integer', minimum: 0 },
        state: { type: 'string', minLength: 1, maxLength: 32 },
        summary: { type: 'string', minLength: 10, maxLength: 1500 },
      },
      required: ['seq', 'state', 'summary'],
      additionalProperties: false,
    },
  },
  required: ['schemaVersion', 'id', 'type', 'from', 'to', 'at', 'payload'],
  additionalProperties: false,
} as const satisfies JsonSchema

export type DigestMessage = FromSchema<typeof DIGEST_MESSAGE_SCHEMA>

// ===========================================================================
// observer.hint (observer -> agent) — v0.2. Proactive, SOURCED help toward an
// observed agent. `provenance` is REQUIRED (minItems 1): a hint without provenance
// does not validate, writer-side or reader-side (design boundary S1 — hint content
// is auditable DATA, never instruction). Payload property order follows the
// package's generation-template convention: short structured fields first, the
// long prose (`hint`) last.
// ===========================================================================

const PROVENANCE_TRANSCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    source: { type: 'string', enum: ['transcript'] },
    file: { type: 'string', minLength: 1, maxLength: 512 },
    fromOffset: { type: 'integer', minimum: 0 },
    // The cited byte window is [fromOffset, toOffset) and must be NON-EMPTY: an empty
    // window grounds nothing. minimum 1 here; the strict toOffset > fromOffset
    // cross-field rule lives in parseMessage (plain JSON Schema can't express it).
    toOffset: { type: 'integer', minimum: 1 },
  },
  required: ['source', 'file', 'fromOffset', 'toOffset'],
  additionalProperties: false,
} as const satisfies JsonSchema

const PROVENANCE_CAPABILITY_SCHEMA = {
  type: 'object',
  properties: {
    source: { type: 'string', enum: ['capability'] },
    need: { type: 'string', minLength: 1, maxLength: 64 },
    provider: { type: 'string', minLength: 1, maxLength: 128 },
    /** URL / document identifier at the provider — auditable, not re-executable. */
    ref: { type: 'string', minLength: 1, maxLength: 2048 },
    retrievedAt: AT_SCHEMA,
  },
  required: ['source', 'need', 'provider', 'ref', 'retrievedAt'],
  additionalProperties: false,
} as const satisfies JsonSchema

/** Discriminated by `source` — the interpreter's scoped anyOf support tries each
 *  branch; the `source` enums make the match deterministic. */
export const HINT_PROVENANCE_SCHEMA = {
  anyOf: [PROVENANCE_TRANSCRIPT_SCHEMA, PROVENANCE_CAPABILITY_SCHEMA],
} as const satisfies JsonSchema

export const HINT_MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer' },
    id: { type: 'string', pattern: BASE_ID_PATTERN.source, minLength: 1, maxLength: 96 },
    type: { type: 'string', enum: ['observer.hint'] },
    from: FROM_SCHEMA,
    to: TO_SCHEMA,
    runId: RUN_ID_SCHEMA,
    at: AT_SCHEMA,
    payload: {
      type: 'object',
      properties: {
        kind: { type: 'string', minLength: 1, maxLength: 64 },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        provenance: { type: 'array', minItems: 1, maxItems: 8, items: HINT_PROVENANCE_SCHEMA },
        hint: { type: 'string', minLength: 20, maxLength: 2000 },
      },
      required: ['kind', 'provenance', 'hint'],
      additionalProperties: false,
    },
  },
  required: ['schemaVersion', 'id', 'type', 'from', 'to', 'at', 'payload'],
  additionalProperties: false,
} as const satisfies JsonSchema

export type HintMessage = FromSchema<typeof HINT_MESSAGE_SCHEMA>
export type HintProvenance = HintMessage['payload']['provenance'][number]

export type WtCommMessage = QuestionMessage | DecisionMessage | DigestMessage | HintMessage
export type WtCommMessageType = WtCommMessage['type']

/** Keyed by envelope `type` — the generic interpreter (validate.ts) selects the schema to
 *  walk from this single map rather than a hand-written switch duplicating the type strings.
 *  ⚠ Version coupling (normative, README "Versioning"): this union is CLOSED — adding a
 *  type is a CODE change, and a reader built BEFORE a type classifies its messages as
 *  `malformed` and silently skips them in listings. Producer and consumers of a type must
 *  both run a package version that knows it. */
export const WT_COMM_SCHEMAS = {
  'escalation.question': QUESTION_MESSAGE_SCHEMA,
  'decision.response': DECISION_MESSAGE_SCHEMA,
  'status.digest': DIGEST_MESSAGE_SCHEMA,
  'observer.hint': HINT_MESSAGE_SCHEMA,
} as const

// ===========================================================================
// Ack marker — `ack-<id>.json`
// ===========================================================================

export const ACK_MARKER_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 106 },
    by: FROM_SCHEMA,
    at: AT_SCHEMA,
  },
  required: ['id', 'by', 'at'],
  additionalProperties: false,
} as const satisfies JsonSchema

export type AckMarker = FromSchema<typeof ACK_MARKER_SCHEMA>

// ===========================================================================
// Settlement marker — `consumed-<id>.json`
// ===========================================================================

export const SETTLEMENT_MARKER_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 106 },
    by: FROM_SCHEMA,
    at: AT_SCHEMA,
    mode: { type: 'string', enum: ['decision', 'default-timeout', 'read'] },
    outcome: { type: 'string', pattern: OPTION_ID_PATTERN.source, minLength: 1, maxLength: 32 },
  },
  required: ['id', 'by', 'at', 'mode'],
  additionalProperties: false,
} as const satisfies JsonSchema

export type SettlementMarker = FromSchema<typeof SETTLEMENT_MARKER_SCHEMA>
