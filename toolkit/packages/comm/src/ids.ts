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

/** The shared `<foldedRunId>-<fnv1a32Hex>` run segment both mint functions build on —
 *  ONE derivation site (review lock F11), so the injectivity recipe (hash width, fold
 *  cap, placeholder) can never drift between question and digest ids. */
function runSegmentWithHash(runId: string): string {
  const runSegment = foldSegment(runId, RUN_SEGMENT_MAX, 'r')
  const hash = fnv1a32(runId).toString(16).padStart(8, '0')
  return `${runSegment}-${hash}`
}

/** `mintQuestionId(runId, stepKey) = q-<segment>-<stepKey>` where `<segment>` = the
 *  folded+truncated runId plus an 8-hex-char FNV-1a hash of the RAW runId (injectivity).
 *  Deterministic (a resumed run re-mints the SAME id) and always <=90 chars, matching
 *  BASE_ID_PATTERN — see README "Mint rule". */
export function mintQuestionId(runId: string, stepKey: string): string {
  const stepSegment = foldSegment(stepKey, STEP_SEGMENT_MAX, 's')
  return `q-${runSegmentWithHash(runId)}-${stepSegment}`
}

/** `mintDigestId(runId, seq) = d-<segment>-<seq>` — same segment recipe as
 *  mintQuestionId. `seq` is coerced to a non-negative integer (NaN/Infinity/negative all
 *  degrade to 0) so a degenerate caller value can never inject a leading '-' or a
 *  non-[a-z0-9] character into the id. */
export function mintDigestId(runId: string, seq: number): string {
  const safeSeq = Number.isFinite(seq) ? Math.max(0, Math.trunc(seq)) : 0
  return `d-${runSegmentWithHash(runId)}-${safeSeq}`
}

/** Tighter than the run/step caps: the hint id carries run segment + hash + observer
 *  segment + seq, and the <=90-char mint guarantee must hold even for a 16-digit seq
 *  (2 + 49 + 1 + 20 + 1 + 16 = 89). Observer definition names are short by their own
 *  grammar (`^[a-z0-9-]{1,64}$`), so 20 chars keeps them recognizable. */
const OBSERVER_SEGMENT_MAX = 20

/** `mintHintId(runId, observerName, seq) = h-<segment>-<observer>-<seq>` (v0.2) — same
 *  run-segment recipe as the other mints (ONE derivation site, review lock F11), plus
 *  the folded observer-definition name so two observers watching the same run can never
 *  collide on a seq. Deterministic, always grammar-valid and <=90 chars. */
export function mintHintId(runId: string, observerName: string, seq: number): string {
  const observerSegment = foldSegment(observerName, OBSERVER_SEGMENT_MAX, 'o')
  const safeSeq = Number.isFinite(seq) ? Math.max(0, Math.trunc(seq)) : 0
  return `h-${runSegmentWithHash(runId)}-${observerSegment}-${safeSeq}`
}
