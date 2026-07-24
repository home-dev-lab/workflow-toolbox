// port-retry.ts — injectable bounded retry for `wt-observe start`'s canonical-port bind
// decision (card #1826418086278858660). Extracted the same way spawn-ready.ts extracted
// awaitSpawnedServerReady: the CLI wires the real probe/clock/sleep, the loop itself is
// pure-enough to unit test with a scripted probe sequence.
//
// The bug this closes: when `wt-observe start` holds NO pidfile (nothing we think we own)
// and the canonical port answers 'foreign' or 'inconclusive', `decideStart` (observe-lifecycle.ts)
// returns `{ action: 'start-free-port' }` — until this fix, `cmdStart` acted on that
// IMMEDIATELY, silently binding an OS-assigned ephemeral port instead of the canonical one
// (observed: :5174 → 44807, no warning). The common real trigger is a stop→start race: the
// just-stopped server's listening socket has not finished closing yet (OS linger/TIME_WAIT-ish
// window) and is usually released within a few seconds. This gives the canonical port a short,
// bounded chance to free up before conceding — the caller (cmdStart) is the one that decides
// what "conceding" means (fail loud by default; silent ephemeral fallback stays available, but
// only via the pre-existing explicit ask `OBSERVE_UI_SERVER_PORT=0`, which never reaches this
// retry at all — see cmdStart's own doc comment on that routing).

export type PortRetryOutcome =
  | { outcome: 'free' } // the canonical port now answers unreachable (or ours) — safe to bind directly
  | { outcome: 'still-occupied'; identity: 'foreign' | 'inconclusive' } // retries exhausted, never freed

export interface PortRetryDeps {
  /** One health-identity probe of the canonical port (observe-cli's classifyHealth(probeHealth(port))). */
  probe: () => Promise<'unreachable' | 'foreign' | 'inconclusive' | 'ours'>
  now: () => number
  sleep: (ms: number) => Promise<void>
  timeoutMs: number
  intervalMs: number
}

/** Poll the canonical port's health identity until it frees up (unreachable — safe to bind —
 *  or somehow becomes 'ours', which the caller re-decides from scratch) or the bounded window
 *  elapses. Always probes at least once before sleeping, so a canonical port that is ALREADY
 *  free costs zero extra latency on the common path. */
export async function retryCanonicalPort(deps: PortRetryDeps): Promise<PortRetryOutcome> {
  const deadline = deps.now() + deps.timeoutMs
  let last: 'foreign' | 'inconclusive' = 'inconclusive'
  for (;;) {
    const identity = await deps.probe()
    if (identity === 'unreachable' || identity === 'ours') return { outcome: 'free' }
    last = identity
    if (deps.now() > deadline) return { outcome: 'still-occupied', identity: last }
    await deps.sleep(deps.intervalMs)
  }
}
