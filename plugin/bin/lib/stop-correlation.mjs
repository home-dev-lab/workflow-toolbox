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

// ⚠⚠⚠⚠ CORRECTION 4 — RAW AGENT ID AS THE FIRST CANDIDATE. Flagged by an independent review
// (pilot-orchestrator brief B9) AFTER this file already shipped, matching by name/agentType only:
// this reproduced the EXACT correlation defect an earlier raw-agent-id fix already closed —
// a stop record's `name` field can carry neither the spawn's explicit name nor its agentType (the
// s-fence-125 shape), while the raw `agentId` still matches. That raw id is available here too:
// transcript files are named `agent-<rawId>.jsonl`, and the id is verified byte-identical to the
// journal's `stop.agentId` on a real record (`agent-a013def19e5877298.jsonl` <->
// `{"t":"stop","agentId":"a013def19e5877298",...}`). Checked FIRST, before name/agentType, since
// it is the most specific and least ambiguous of the three keys — a raw id is unique per spawn,
// where a name or type can (rarely) collide across agents.
export function hasRecordedStop(lastStopAt, meta, modifiedAtMs, rawAgentId) {
  const candidates = [rawAgentId, meta?.name, meta?.agentType].filter(Boolean)
  for (const key of candidates) {
    const at = lastStopAt.get(key)
    if (!at) continue
    const atMs = Date.parse(at)
    if (!Number.isFinite(atMs)) continue
    if (atMs >= modifiedAtMs - BACKWARD_TOLERANCE_MS) return true
  }
  return false
}

// ⚠⚠⚠⚠⚠ CORRECTION 5 — TRAILING `observer-ref` RECORDS ARE NOT TURN CONTENT, AND POLLUTE THE
// ANCHOR. Measured 2026-08-02: two REAL clean-finish agents were wrongly
// STALE'd, with backward gaps of 11.4s and 7.2s -- far past BACKWARD_TOLERANCE_MS. Delegated
// forensics (transcript structure, not guessed) found the "second cluster" of large backward
// gaps described in CORRECTION 3 above (5.99s-46.3s, assumed there to be mostly genuine
// unaccounted later turns) is a SINGLE, unrelated mechanism, not turn-boundary noise at all: a
// PAIRED watchdog agent (`pilot-watchdog`, the `observer:` pairing) writes its own heartbeat
// records — `{type:"observer-ref", agentId, observerTaskId, observerAgentType, timestamp}` —
// into the SAME transcript file, on its OWN independent polling cadence. These carry no `uuid`,
// `parentUuid`, `role`, or `message` — they are not part of the assistant/user turn chain at
// all. Scanned across one real session's 105 stop-matched agents (2026-08-02): 51/51 agents
// whose naive last-record gap fell in 5.89s-46.3s had `observer-ref` as the transcript's literal
// last line, and EVERY one fell back into -0.4s..0.0s (comfortably inside the EXISTING 1000ms
// tolerance) once observer-ref is excluded from the anchor. Zero exceptions. Confirmed directly
// for the two card-cited agents: `ad976496919625efe` (stop 17:57:04.713Z, real last record
// 17:57:04.641Z, gap -0.072s) and `a585e7a53340c178e` (stop 18:22:41.919Z, real last record
// 18:22:41.787Z, gap -0.132s).
//
// THE FIX IS THE ANCHOR, NOT THE CONSTANT. BACKWARD_TOLERANCE_MS above was never miscalibrated
// for the population it was actually meant to cover — CORRECTION 3's own separating gap (a void
// around 5.87s) is real, but its right-hand side was misread: it is not "genuine unaccounted
// turns", it is observer-ref polling noise. Re-deriving a bigger constant would have masked
// genuine mid-turn deaths across that same 1s-46s range with no way back to tell them apart —
// exactly the failure this file's own header already warns against ("re-derive, don't widen").
//
// MAX-OVER-FILTERED, NOT BACKWARD-WALK. This picks the latest timestamp among all NON-
// observer-ref records, rather than walking from the end and stopping at the first non-
// observer-ref line. The forensics that found this could not rule out observer-ref appearing
// INTERLEAVED rather than strictly trailing in every possible case; a backward-walk would be
// fooled by an observer-ref record sitting after a stale real record but before a fresher one
// recorded earlier in file order. Max-over-filtered is order-independent and cannot make that
// mistake — see the MULTI-TURN-THEN-DIE-WITH-NOISE test in stop-correlation.test.ts.
export function lastRealRecordTimestampMs(records) {
  let best = null
  for (const r of records) {
    if (!r || r.type === 'observer-ref') continue
    for (const key of ['timestamp', 'at', 'ts', 'createdAt', 'time']) {
      const v = r?.[key]
      if (typeof v === 'string' && v.length >= 20) {
        const t = Date.parse(v)
        if (Number.isFinite(t) && (best === null || t > best)) best = t
        break
      }
    }
  }
  return best
}

// Builds a Map of key -> latest 'at' timestamp seen on 'stop' records, from a journal's already-
// parsed record list — kept separate from file I/O so a caller with records in hand (tests, or a
// caller that already parsed the journal for another reason) never re-reads the file.
//
// Keyed by BOTH `name` and `agentId` (CORRECTION 4, see hasRecordedStop above) — the two keys
// point at the SAME latest timestamp for a given stop record, so a caller can look up by whichever
// one it has (wt-arc-watch.mjs only ever has the raw id from a transcript filename; a caller
// working from meta.json only has name/agentType). Each key's "latest" is tracked independently,
// since a stop record can carry one without the other (an agentId with no usable name still gets
// its agentId keyed; a name/agentType with no agentId still gets its name keyed, exactly as
// before this correction).
export function lastStopTimestamps(records) {
  const m = new Map()
  const bump = (key, at) => {
    if (!key) return
    const prev = m.get(key)
    if (!prev || at > prev) m.set(key, at)
  }
  for (const r of records) {
    if (!r || r.t !== 'stop' || typeof r.at !== 'string') continue
    if (typeof r.name === 'string' && r.name) bump(r.name, r.at)
    if (typeof r.agentId === 'string' && r.agentId) bump(r.agentId, r.at)
  }
  return m
}
