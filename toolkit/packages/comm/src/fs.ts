// fs.ts — the one narrow fs boundary: writeMessage, writeOrReadMessage, writeAck,
// claimSettlement, readSettlement, readMessage, listMessages, respondToQuestion. Every
// write is the no-clobber `wx` primitive (README "Write primitive"); no file is ever
// edited in place, moved, or deleted. No Date.now/env/timers here — `dir` and `at` are
// always explicit caller arguments (design invariant #4).

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { messagePath, ackPath, consumedPath, MSG_PREFIX } from './paths.js'
import { assertSafeMessageId, decisionIdFor } from './ids.js'
import {
  parseMessage,
  parseAckMarker,
  parseSettlementMarker,
  validateSettlement,
  type SettlementClaim,
} from './validate.js'
import { WT_COMM_SCHEMA_VERSION, type WtCommMessage, type WtCommMessageType, type AckMarker, type SettlementMarker, type QuestionMessage, type DecisionMessage } from './schemas.js'

function isEexist(e: unknown): boolean {
  return (e as NodeJS.ErrnoException | undefined)?.code === 'EEXIST'
}

// ===========================================================================
// writeMessage — create. "validate fully first, then no-clobber write" (README "create").
// ===========================================================================

export type WriteMessageResult = { outcome: 'written'; message: WtCommMessage } | { outcome: 'duplicate-id' }

/** Re-validates `message` through the SAME reader path (parseMessage) before writing —
 *  the canonical, schema-rebuilt form (only declared properties) is what actually reaches
 *  disk, so a caller-injected excess field can never survive (the writer-strictness this
 *  package's `additionalProperties: false` schemas call for, achieved without a second,
 *  duplicated strict-validation code path — see validate.ts's module doc). An invalid
 *  outgoing message is a programmer error: throws, rather than a named outcome — the
 *  README's outcome vocabulary is about id contention, not shape bugs. */
export function writeMessage(dir: string, message: WtCommMessage): WriteMessageResult {
  const check = parseMessage(JSON.stringify(message))
  if (!check.ok) {
    throw new Error(`wt-comm: refusing to write an invalid ${message.type} message ${JSON.stringify(message.id)} (${check.reason})`)
  }
  assertSafeMessageId(message.id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(messagePath(dir, message.id), JSON.stringify(check.message), { flag: 'wx', mode: 0o600 })
    return { outcome: 'written', message: check.message }
  } catch (e) {
    if (isEexist(e)) return { outcome: 'duplicate-id' }
    throw e
  }
}

// ===========================================================================
// writeOrReadMessage — get-or-create, for a RESUMED step (README point 8).
// ===========================================================================

export type WriteOrReadMessageResult =
  | { outcome: 'written'; message: WtCommMessage }
  | { outcome: 'resumed-adopt-existing'; message: WtCommMessage }
  | { outcome: 'id-collision' }
  | { outcome: 'torn-existing' }

export function writeOrReadMessage(dir: string, message: WtCommMessage): WriteOrReadMessageResult {
  const written = writeMessage(dir, message)
  if (written.outcome === 'written') return written

  // duplicate-id: read the existing file and apply the adopt/collision/torn rule.
  let text: string
  try {
    text = readFileSync(messagePath(dir, message.id), 'utf8')
  } catch {
    return { outcome: 'torn-existing' }
  }
  const existing = parseMessage(text)
  if (!existing.ok) return { outcome: 'torn-existing' }

  const sameType = existing.message.type === message.type
  const sameRunId = message.runId === undefined || existing.message.runId === undefined || message.runId === existing.message.runId
  const messageInReplyTo = 'inReplyTo' in message ? message.inReplyTo : undefined
  const existingInReplyTo = 'inReplyTo' in existing.message ? existing.message.inReplyTo : undefined
  const sameInReplyTo = messageInReplyTo === existingInReplyTo

  if (sameType && sameRunId && sameInReplyTo) {
    return { outcome: 'resumed-adopt-existing', message: existing.message }
  }
  return { outcome: 'id-collision' }
}

// ===========================================================================
// writeAck — the optional receipt marker (README "ack").
// ===========================================================================

export type WriteAckResult = { outcome: 'written' } | { outcome: 'already-acked' }

export function writeAck(dir: string, ack: AckMarker): WriteAckResult {
  const canonical = parseAckMarker(JSON.stringify(ack))
  if (canonical === null) {
    throw new Error(`wt-comm: refusing to write an invalid ack marker ${JSON.stringify(ack.id)}`)
  }
  assertSafeMessageId(canonical.id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(ackPath(dir, canonical.id), JSON.stringify(canonical), { flag: 'wx', mode: 0o600 })
    return { outcome: 'written' }
  } catch (e) {
    if (isEexist(e)) return { outcome: 'already-acked' }
    throw e
  }
}

// ===========================================================================
// claimSettlement — the no-clobber authoritative marker (README "consume / settle").
// Coherence is enforced BEFORE writing: an incoherent claim touches the filesystem
// NOT AT ALL (design invariant #9).
// ===========================================================================

export type ClaimSettlementResult =
  | { outcome: 'settled'; settlement: SettlementMarker }
  | { outcome: 'already-settled' }
  | { outcome: 'invalid-claim' }
  | { outcome: 'torn-settlement' }

export function claimSettlement(dir: string, message: WtCommMessage, claim: SettlementClaim): ClaimSettlementResult {
  if (!validateSettlement(message, claim)) return { outcome: 'invalid-claim' }

  const marker: SettlementMarker = { id: message.id, ...claim }
  const canonical = parseSettlementMarker(JSON.stringify(marker))
  if (canonical === null) {
    throw new Error(`wt-comm: refusing to write an invalid settlement marker ${JSON.stringify(message.id)}`)
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(consumedPath(dir, message.id), JSON.stringify(canonical), { flag: 'wx', mode: 0o600 })
    return { outcome: 'settled', settlement: canonical }
  } catch (e) {
    if (!isEexist(e)) throw e
  }
  // EEXIST: read the existing marker back before naming the outcome — an unparseable
  // existing file is a TORN prior write, and reporting it 'already-settled' would be a
  // lie no one could ever correct (review lock F6): the marker path is bound to the
  // message id (no retry-id space), so recovery is the documented pilot-housekeeping
  // manual step, and the caller must know it is needed.
  const existing = readSettlement(dir, message.id)
  if (!existing.ok) return { outcome: 'torn-settlement' }
  return { outcome: 'already-settled' }
}

// ===========================================================================
// readSettlement / readMessage — never throw on content (design invariant #3).
// ===========================================================================

export type ReadSettlementResult = { ok: true; settlement: SettlementMarker } | { ok: false; reason: 'not-found' | 'malformed' }

export function readSettlement(dir: string, id: string): ReadSettlementResult {
  let text: string
  try {
    text = readFileSync(consumedPath(dir, id), 'utf8')
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  const settlement = parseSettlementMarker(text)
  if (settlement === null) return { ok: false, reason: 'malformed' }
  return { ok: true, settlement }
}

export type ReadSettlementForResult =
  | { ok: true; settlement: SettlementMarker }
  | { ok: false; reason: 'not-found' | 'malformed' | 'incoherent' }

/** The read-time coherence recheck the README promises for markers written by
 *  NON-library writers (review locks F2/F5): shape-validates the marker (readSettlement)
 *  AND re-runs validateSettlement against the message being settled — a hand-written
 *  `consumed-<id>.json` that forges a pilot decision (wrong role for its mode, outcome
 *  outside the question's options, a default-timeout outcome differing from
 *  defaultOptionId) is `incoherent`, never silently authoritative. Consumers that hold
 *  the message should ALWAYS prefer this over raw readSettlement. */
export function readSettlementFor(dir: string, message: WtCommMessage): ReadSettlementForResult {
  const read = readSettlement(dir, message.id)
  if (!read.ok) return read
  const s = read.settlement
  const claim: SettlementClaim = { by: s.by, at: s.at, mode: s.mode, ...(s.outcome !== undefined ? { outcome: s.outcome } : {}) }
  if (!validateSettlement(message, claim)) return { ok: false, reason: 'incoherent' }
  return { ok: true, settlement: s }
}

export type ReadMessageResult =
  | { ok: true; message: WtCommMessage }
  | { ok: false; reason: 'not-found' | 'malformed' | 'unsupported-version' | 'provenance' }

export function readMessage(dir: string, id: string): ReadMessageResult {
  let text: string
  try {
    text = readFileSync(messagePath(dir, id), 'utf8')
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  const result = parseMessage(text)
  if (!result.ok) return { ok: false, reason: result.reason }
  return { ok: true, message: result.message }
}

// ===========================================================================
// listMessages — tolerantly skips garbage, dotfiles, and foreign files.
// ===========================================================================

export interface ListMessagesFilter {
  type?: WtCommMessageType
  to?: { role?: 'agent' | 'pilot' | 'observer'; id?: string }
}

export function listMessages(dir: string, filter: ListMessagesFilter = {}): WtCommMessage[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  names.sort()

  const out: WtCommMessage[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (!name.startsWith(MSG_PREFIX) || !name.endsWith('.json')) continue
    let text: string
    try {
      text = readFileSync(join(dir, name), 'utf8')
    } catch {
      continue
    }
    const result = parseMessage(text)
    if (!result.ok) continue
    const message = result.message

    if (filter.type !== undefined && message.type !== filter.type) continue
    if (filter.to?.role !== undefined && message.to.role !== filter.to.role) continue
    if (filter.to?.id !== undefined && message.to.id !== filter.to.id) continue

    out.push(message)
  }
  return out
}

// ===========================================================================
// respondToQuestion — the pilot flow (README "Pilot flow").
// ===========================================================================

export interface RespondToQuestionArgs {
  by: { role: 'pilot'; id: string }
  decision: string
  reason?: string
  at: string
}

export type RespondToQuestionResult =
  | { outcome: 'already-settled'; settlement: SettlementMarker }
  | { outcome: 'settled'; settlement: SettlementMarker }
  | { outcome: 'invalid-claim' }
  | { outcome: 'id-collision' }
  | { outcome: 'torn-existing' }
  | { outcome: 'torn-settlement' }
  | { outcome: 'incoherent-settlement'; settlement: SettlementMarker }

export function respondToQuestion(dir: string, question: QuestionMessage, args: RespondToQuestionArgs): RespondToQuestionResult {
  // Preconditions, BEFORE any write, as typed outcomes — the same invariants
  // claimSettlement enforces, surfaced consistently (review locks F7/F8: never a throw
  // for one path and a typed outcome for the other; never a caller-supplied role
  // silently overridden — a JS caller passing role 'agent' is refused outright, so no
  // pilot-authored-looking decision message can be forged past the runtime check).
  if ((args.by.role as string) !== 'pilot') return { outcome: 'invalid-claim' }
  if (!question.payload.options.some((o) => o.id === args.decision)) return { outcome: 'invalid-claim' }

  // 1. Read the marker first — with the COHERENCE recheck (review lock F2/F5): a forged
  //    or torn existing marker is surfaced as its own named outcome, never adopted as
  //    the authority.
  const existing = readSettlementFor(dir, question)
  if (existing.ok) return { outcome: 'already-settled', settlement: existing.settlement }
  if (existing.reason === 'malformed') return { outcome: 'torn-settlement' }
  if (existing.reason === 'incoherent') {
    const raw = readSettlement(dir, question.id)
    // raw.ok is guaranteed here (incoherent implies shape-valid), but stay total:
    if (raw.ok) return { outcome: 'incoherent-settlement', settlement: raw.settlement }
    return { outcome: 'torn-settlement' }
  }

  // 2. Write the decision.response at the deterministic id (get-or-create for its own
  //    re-run). If a decision message ALREADY exists (a prior call that crashed before
  //    claiming), the ADOPTED message is the durable authority: the settlement below
  //    must reflect ITS decision, never a differing in-memory args.decision (review
  //    lock F0 — the marker may not contradict the message it commits).
  const decisionMessage: DecisionMessage = {
    schemaVersion: WT_COMM_SCHEMA_VERSION,
    id: decisionIdFor(question.id),
    type: 'decision.response',
    from: { role: args.by.role, id: args.by.id },
    to: { role: 'agent', id: question.from.id },
    ...(question.runId !== undefined ? { runId: question.runId } : {}),
    at: args.at,
    inReplyTo: question.id,
    payload: { decision: args.decision, ...(args.reason !== undefined ? { reason: args.reason } : {}) },
  }
  const writeResult = writeOrReadMessage(dir, decisionMessage)
  if (writeResult.outcome === 'id-collision' || writeResult.outcome === 'torn-existing') {
    return { outcome: writeResult.outcome }
  }
  const operative = writeResult.message as DecisionMessage
  const effectiveDecision = operative.payload.decision

  // 3. Claim the settlement with mode 'decision', outcome = the OPERATIVE (possibly
  //    adopted) decision. A crash between step 2 and here leaves the decision
  //    advisory-only; a concurrent default-timeout may already have won — either way,
  //    the coherent re-read below reports the TRUE winner.
  claimSettlement(dir, question, { by: args.by, at: args.at, mode: 'decision', outcome: effectiveDecision })

  const final = readSettlementFor(dir, question)
  if (!final.ok) {
    if (final.reason === 'incoherent') {
      const raw = readSettlement(dir, question.id)
      if (raw.ok) return { outcome: 'incoherent-settlement', settlement: raw.settlement }
    }
    return { outcome: 'torn-settlement' }
  }
  return {
    outcome: final.settlement.mode === 'decision' && final.settlement.outcome === effectiveDecision ? 'settled' : 'already-settled',
    settlement: final.settlement,
  }
}
