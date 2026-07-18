// ids.ts — id guards, the fold/hash mint recipe, and the decision/retry id derivations.
// No Date.now/env/timers here (design invariant): every input is an explicit argument.
// See ../README.md "Message ids" for the normative grammar this module implements.

import { DECISION_ID_PATTERN } from './schemas.js'

/** The filesystem safety guard applied to ANY id before it becomes part of a path
 *  (messagePath/ackPath/consumedPath all call this) — deliberately LOOSER than the
 *  schema id patterns (128 vs 96/106) since it must also admit retry ids
 *  (`<base>-r<k>`). Distinct concern from BASE_ID_PATTERN/DECISION_ID_PATTERN: this is
 *  the last line of defense against path traversal, not the protocol grammar. */
export function assertSafeMessageId(id: string): void {
  if (id.length === 0 || id.length > 128) {
    throw new Error(`wt-comm: unsafe message id ${JSON.stringify(id)} (empty or over 128 chars)`)
  }
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(`wt-comm: unsafe message id ${JSON.stringify(id)} (path separator or "..")`)
  }
}

/** `decisionIdFor(qid) = qid + '--decision'`, verbatim — the pilot writes exactly one
 *  path and everyone else derives it mechanically (never rewritten, only compared). */
export function decisionIdFor(questionId: string): string {
  return `${questionId}--decision`
}

/** The deterministic recovery id for a torn prior write: `<base>-r<k>` (k = 1, 2, …). */
export function retryIdFor(base: string, k: number): string {
  return `${base}-r${k}`
}

/** A decision id is well-formed iff it matches DECISION_ID_PATTERN AND carries EXACTLY
 *  one "--" occurrence (the pattern alone accepts e.g. "ab--cd--decision", which embeds
 *  a base containing its own "--" before the suffix — impossible from `decisionIdFor` on
 *  a valid BASE_ID_PATTERN qid, since that pattern already forbids "--" in the base, but
 *  not impossible for a foreign/hand-written id). Splitting on "--" is exactly the
 *  "how many times does the separator occur" check: a well-formed id splits into
 *  precisely `[qid, 'decision']`. */
export function isValidDecisionId(id: string): boolean {
  if (!DECISION_ID_PATTERN.test(id)) return false
  const parts = id.split('--')
  return parts.length === 2 && parts[1] === 'decision'
}

/** Lowercase, fold every run of non-[a-z0-9] characters to a single '-', trim edge
 *  dashes. Pure string shaping — used both for the runId segment of a minted id and for
 *  the teaching pack's shell-level recipe (see README "Mint rule"). */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** FNV-1a, 32-bit. Deterministic, tiny, dependency-free — used ONLY to keep the
 *  runId->segment map injective (fold() alone collapses e.g. 'wf_ab-cd' and 'wf-ab.cd'
 *  to the same folded string; hashing the RAW, unfolded input disambiguates them). */
export function fnv1a32(s: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Folds+truncates `s` to at most `maxLen` chars, trims any dash truncation could have
 *  re-exposed at the cut edge, and substitutes a fixed non-empty placeholder when folding
 *  collapses the whole input to nothing (e.g. a runId/stepKey that is ALL punctuation) —
 *  guarantees a non-empty, non-dash-edged segment so concatenating segments with '-'
 *  separators can never produce "--" or a leading/trailing dash. */
function foldSegment(s: string, maxLen: number, emptyPlaceholder: string): string {
  let f = fold(s)
  if (f.length > maxLen) f = f.slice(0, maxLen)
  f = f.replace(/-+$/, '')
  return f.length > 0 ? f : emptyPlaceholder
}

const RUN_SEGMENT_MAX = 40
const STEP_SEGMENT_MAX = 32

/** `<foldedInput>-<fnv1a32Hex>`: fold+truncate the input, then append an 8-hex-char
 *  FNV-1a hash of the RAW input — the hash keeps the input→segment map INJECTIVE
 *  (folding/truncation alone collapses distinct inputs). ONE derivation site for every
 *  minted-id segment that must stay collision-free (review locks F11 and v0.2 F0: the
 *  hint id's observer segment initially shipped as a bare fold+truncate, letting two
 *  distinct observer names sharing a prefix mint the SAME id — silent hint loss). */
function segmentWithHash(s: string, maxLen: number, emptyPlaceholder: string): string {
  return `${foldSegment(s, maxLen, emptyPlaceholder)}-${fnv1a32(s).toString(16).padStart(8, '0')}`
}

/** The shared run segment both v0 mint functions build on. */
function runSegmentWithHash(runId: string): string {
  return segmentWithHash(runId, RUN_SEGMENT_MAX, 'r')
}

/** `mintQuestionId(runId, stepKey) = q-<segment>-<stepKey>` where `<segment>` = the
 *  folded+truncated runId plus an 8-hex-char FNV-1a hash of the RAW runId (injectivity).
 *  Deterministic (a resumed run re-mints the SAME id) and always <=90 chars, matching
 *  BASE_ID_PATTERN — see README "Mint rule". */
export function mintQuestionId(runId: string, stepKey: string): string {
  const stepSegment = foldSegment(stepKey, STEP_SEGMENT_MAX, 's')
  return `q-${runSegmentWithHash(runId)}-${stepSegment}`
}

/** Coerce a caller-supplied `seq` to a grammar-safe, deterministic segment value —
 *  the ONE derivation site shared by mintDigestId and mintHintId. NaN/Infinity/negative
 *  degrade to 0 and fractions truncate (so a degenerate value can never inject a leading
 *  '-' or a non-[a-z0-9] char), and the upper bound is CLAMPED to Number.MAX_SAFE_INTEGER.
 *  The upper clamp matters twice over: a seq >= 1e21 stringifies in EXPONENTIAL notation
 *  ("1e+21" — a '+' that breaks the id grammar, and one assertSafeMessageId does NOT
 *  catch), and past MAX_SAFE_INTEGER integer precision is lost (distinct seqs could
 *  truncate to one value, breaking seq injectivity). MAX_SAFE_INTEGER is 16 plain digits,
 *  matching the mint length budgets; the clamp is a no-op for any in-range seq, so ids
 *  stay byte-identical (crash-rewind determinism: same input -> same id). */
function safeSeq(seq: number): number {
  return Number.isFinite(seq) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(seq))) : 0
}

/** `mintDigestId(runId, seq) = d-<segment>-<seq>` — same segment recipe as
 *  mintQuestionId. `seq` passes through `safeSeq` (degenerate values degrade to 0; an
 *  extreme seq clamps to Number.MAX_SAFE_INTEGER) so the id is always grammar-valid. */
export function mintDigestId(runId: string, seq: number): string {
  return `d-${runSegmentWithHash(runId)}-${safeSeq(seq)}`
}

/** Tighter than the run/step caps: the hint id carries run segment + hash + observer
 *  segment + ITS hash + seq, and the <=90-char mint guarantee (3-arg form) must hold even
 *  for a 16-digit seq (2 + 49 + 1 + (11+1+8) + 1 + 16 = 89). Observer definition names are
 *  short by their own grammar (`^[a-z0-9-]{1,64}$`); the 11-char fold keeps a
 *  recognizable prefix and the hash carries the injectivity. */
const OBSERVER_SEGMENT_MAX = 11

/** The OPTIONAL agent segment's fold cap (mintHintId's 4-arg form). Budget: the 3-arg 89
 *  plus `<agentSegment>-` = 89 + (16 + 1 + 8) + 1 = 115 — past the 96-char base-id cap but
 *  within the widened hint grammar (HINT_ID_PATTERN, <=128, schemas.ts) and assertSafeMessageId's
 *  128-char guard. 16 keeps a recognizable agent prefix; the hash carries the injectivity. */
const AGENT_SEGMENT_MAX = 16

/** `mintHintId(runId, observerName, seq, agentId?)`:
 *   - WITHOUT agentId → `h-<runSegment>-<observerSegment>-<seq>` (v0.2), BYTE-IDENTICAL to
 *     the 3-arg form: existing callers and the crash-rewind/adopt determinism are unchanged
 *     (same input → same id).
 *   - WITH a non-empty agentId → `h-<runSegment>-<observerSegment>-<agentSegment>-<seq>`
 *     (v0.3): the agent segment disambiguates SIBLING transcripts of ONE multi-transcript
 *     target and makes the target agent VISIBLE in the id (card #1821537133433718298).
 *  EVERY variable segment uses the shared fold+hash recipe (segmentWithHash, ONE derivation
 *  site), so distinct runs / observers / agents can never collide on a seq even when their
 *  names share a fold/truncation prefix (review lock F0 — now extended to the agent segment).
 *  Deterministic and always grammar-valid: <=90 chars without an agent, <=115 with one —
 *  within the observer.hint grammar (HINT_ID_PATTERN, <=128) and self-verified against
 *  assertSafeMessageId's 128-char filesystem guard. */
export function mintHintId(runId: string, observerName: string, seq: number, agentId?: string): string {
  const observerSegment = segmentWithHash(observerName, OBSERVER_SEGMENT_MAX, 'o')
  // Optional + ADDITIVE: absent/empty agentId reproduces the 3-arg id byte-for-byte; a
  // non-empty agentId inserts <agentSegment> (fold + injectivity hash — never a bare
  // fold+truncate, which would let two agent ids sharing a prefix mint the SAME id) before
  // the seq.
  const agentSegment = agentId !== undefined && agentId !== '' ? `${segmentWithHash(agentId, AGENT_SEGMENT_MAX, 'a')}-` : ''
  const id = `h-${runSegmentWithHash(runId)}-${observerSegment}-${agentSegment}${safeSeq(seq)}`
  // The agent form can reach ~115 chars — past the 96-char base-id cap but within the
  // widened hint grammar; self-verify so a future segment-max regression fails loud here.
  assertSafeMessageId(id)
  return id
}
