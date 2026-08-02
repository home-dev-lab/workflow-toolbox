// stop-correlation — a PURE function answering "does the outbound-guard journal already record
// THIS agent's CURRENT silence as a clean end-of-turn?", extracted so it can be unit-tested
// without the filesystem or the async polling loop that calls it.
//
// WHY THIS EXISTS. wt-arc-watch.mjs fires STALE purely from transcript mtime, with no knowledge
// of the outbound-guard journal wt-outbound-guard-hook.mjs already writes on every SubagentStop.
// Measured on 2026-08-02 across 422+ real spawn records (three independent audits — two on
// existing journals, one on a disposable headless bench that produced an ACCIDENTAL real kill:
// an agent terminated mid-generation by a content-filter API error, host process alive, zero
// stop/nudged records — contrasted against a control agent in the same launch mode that produced
// two clean stop records seconds apart): the dominant cause of a stale-but-alive transcript is
// either (a) the agent is legitimately idle between turns — proven live (agent a1f5eb82662eb4d75,
// repeated stop/resume cycles all evening, a STALE alert landing inside one of its idle gaps) or
// (b) a NAME correlation miss — a stop record exists but under a different key than the
// transcript's own name (the s-fence-125 incident: the stop record's `name` carries the
// underlying subagent_type, not the spawn's explicit name).
//
// ⚠⚠ CORRECTION 1 — WHY THIS TAKES A TIMESTAMP, NOT JUST A NAME MATCH — the correction that
// matters most here. A first version of this file matched on "does ANY stop record exist for this name/type,
// anywhere in the agent's whole history" — WRONG BY CONSTRUCTION, caught before shipping: a
// single agent can produce MULTIPLE stop records over its life (one per turn boundary, not one
// per agent). An agent that stopped cleanly on turn 3 and then died mid-turn on turn 7 would be
// wrongly suppressed forever by turn 3's stop record. The fix: only a stop record whose OWN
// timestamp is at (or acceptably near) the transcript's last observed write can account for the
// CURRENT silence.
//
// ⚠⚠⚠ WHY THE TOLERANCE IS ASYMMETRIC AND WHY IT IS 1 SECOND — TWO further corrections, both
// caught by measurement after an earlier version of this fix already shipped with a symmetric
// 60s window compared against the wrong anchor (file mtime).
//
// CORRECTION 2 — the anchor. wt-arc-watch.mjs compares against the transcript's own last-record
// `timestamp` field, not file mtime (see its DISCRIMINATOR comment for why: mtime overstated the
// "stop precedes last activity" population by ~4.8x in a real measurement, because it answers a
// filesystem question, not a "when did the agent last take a turn" question).
//
// CORRECTION 3 — the tolerance value, DERIVED from the shape of the measured distribution, not
// tuned. Measured on 2026-08-02, anchored on the transcript's own last-record timestamp, 45 real
// negative (stop-precedes-last-turn) samples, sorted: one sample at -0.021s, then an EMPTY GAP of
// 5.87 SECONDS, then the next at -5.894s down to -46.323s (44 samples). Any epsilon between
// ~-0.1s and ~-5.8s classifies identically — one cross-process clock-skew sample tolerated, all 44
// genuine unaccounted-turn samples still rejected. BACKWARD_TOLERANCE_MS = 1_000 sits in the
// middle of that void: a separator between two observed populations, not a safety margin. If the
// gap ever closes (a slower machine, a loaded hook process), this constant must be RE-DERIVED, not
// widened — widening it starts swallowing genuine unaccounted turns from the far side.
// ⚠ Honesty caveat carried forward: the SEPARATION is well-evidenced (44 vs 1, a clean void), but
// the skew MAGNITUDE claim ("~20ms") rests on a single sample. Do not let the second borrow the
// confidence of the first. Scope caveat: this described ~325 of 960 transcripts on disk that
// matched a stop by raw id — the unmatched two-thirds are where the correlation defect (see
// CORRECTION 1 above) lives, not evidence about this tolerance.
//
// FORWARD (stop AFTER the anchor) has no cap at all: a later stop only ever makes suppression MORE
// justified, however much later — measured max is well under 1s, but nothing is gained by capping.
export const BACKWARD_TOLERANCE_MS = 1_000

export function hasRecordedStop(lastStopAt, meta, modifiedAtMs) {
  if (!meta) return false
  const candidates = [meta.name, meta.agentType].filter(Boolean)
  for (const key of candidates) {
    const at = lastStopAt.get(key)
    if (!at) continue
    const atMs = Date.parse(at)
    if (!Number.isFinite(atMs)) continue
    if (atMs >= modifiedAtMs - BACKWARD_TOLERANCE_MS) return true
  }
  return false
}

// Builds a Map of name -> latest 'at' timestamp seen on 'stop' records, from a journal's already-
// parsed record list — kept separate from file I/O so a caller with records in hand (tests, or a
// caller that already parsed the journal for another reason) never re-reads the file.
export function lastStopTimestamps(records) {
  const m = new Map()
  for (const r of records) {
    if (!r || r.t !== 'stop' || typeof r.name !== 'string' || !r.name || typeof r.at !== 'string') continue
    const prev = m.get(r.name)
    if (!prev || r.at > prev) m.set(r.name, r.at)
  }
  return m
}
