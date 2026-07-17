// spawn-ready.ts — injectable readiness wait for a freshly spawned observe
// server (card #1820935029484684499). Extracted from observe-cli's spawnServer
// (the launch-body.ts precedent: the CLI wires process/fs effects, the logic
// lives here, unit-testable) to fix two lived failures:
//
//  (1) PORT 0 — `wt-observe start` health-checked the REQUESTED literal port;
//      with port 0 (OS-assigned free port, the scratch-server workflow) it
//      probed ":0" forever and timed out although the child was healthy. The
//      real port is resolved from the child's own log BANNER
//      (`[observe-ui] app + run discovery on http://127.0.0.1:<port>…`,
//      dev-api.ts prints it once listening; host.port carries the ACTUAL
//      bound port). The server log opens in APPEND mode and survives
//      restarts, so the CALLER must feed only the slice written after THIS
//      spawn (record the file size before spawning) — a stale banner from a
//      previous server must never be trusted.
//
//  (2) ORPHANED CHILD — after a readiness FAILURE (timeout) the detached,
//      unref'd child kept running; the launcher threw and exited, leaving an
//      orphan server (two were killed by hand during the capabilities PoC).
//      On timeout the child is now reaped via the injected `kill` (precise
//      PID, never a pattern match — see the pkill-broad-match lesson). The
//      spawn-error and exited-immediately paths do NOT kill: there is no
//      live child to reap on those.
// ---------------------------------------------------------------------------

/** The single-source AND hub banners both match (the config-dir suffix is
 *  optional); several banners in one slice → the LAST one wins (freshest).
 *  Coupling note: the pattern mirrors dev-api.ts's startup line in the
 *  workflow-observatory checkout — keep the two in sync. */
const BANNER_RE = /app \+ run discovery on http:\/\/127\.0\.0\.1:(\d+)/g

/** Parse the port the child ANNOUNCED in the given log slice, or null when no
 *  (valid) banner is present yet. Out-of-range numbers are rejected. */
export function parseAnnouncedPort(logSlice: string): number | null {
  let last: number | null = null
  for (const m of logSlice.matchAll(BANNER_RE)) {
    const n = Number(m[1])
    if (Number.isInteger(n) && n > 0 && n <= 65535) last = n
  }
  return last
}

export interface SpawnExitState {
  error: Error | null
  exited: { code: number | null; signal: NodeJS.Signals | null } | null
}

export interface SpawnReadyDeps<H> {
  /** The port `start` asked for; 0 = OS-assigned (resolved from the banner). */
  requestedPort: number
  timeoutMs: number
  /** Log content written AFTER this spawn (caller slices from the recorded
   *  pre-spawn file size — the log is append-mode and survives restarts). */
  readLogSlice: () => string
  /** Health probe for one port (observe-cli's probeHealth). */
  probe: (port: number) => Promise<H | string>
  /** Does this probe answer mean "ready, ours"? */
  isReady: (v: H | string) => v is H
  /** Current spawn error/exit observation (observe-cli's once-handlers). */
  spawnState: () => SpawnExitState
  /** Reap the still-alive child (precise-PID SIGTERM). Called EXACTLY once,
   *  only on the readiness-timeout path. */
  kill: () => void
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Last log lines for the error message (observe-cli's logTail). */
  logTail: () => string
}

const POLL_INTERVAL_MS = 500

/** Wait for the spawned server to become healthy on its REAL port. Throws on
 *  spawn error / immediate exit (no kill — no live child) and on timeout
 *  (AFTER reaping the child). Returns the ready health payload. */
export async function awaitSpawnedServerReady<H>(deps: SpawnReadyDeps<H>): Promise<H> {
  const deadline = deps.now() + deps.timeoutMs
  for (;;) {
    const st = deps.spawnState()
    if (st.error !== null) {
      throw new Error(`failed to spawn the server: ${st.error.message}`)
    }
    if (st.exited !== null) {
      const e = st.exited
      throw new Error(
        `server exited immediately (code ${e.code ?? 'null'}${e.signal ? `, signal ${e.signal}` : ''}).\n${deps.logTail()}`,
      )
    }
    const port = deps.requestedPort !== 0 ? deps.requestedPort : parseAnnouncedPort(deps.readLogSlice())
    if (port !== null) {
      const h = await deps.probe(port)
      if (deps.isReady(h)) return h
    }
    if (deps.now() > deadline) {
      // The child is alive (neither error nor exit observed) but never became
      // healthy — reap it so a failed start leaves NO orphan server behind.
      deps.kill()
      const where =
        deps.requestedPort !== 0
          ? `:${deps.requestedPort}`
          : port !== null
            ? `:${port} (OS-assigned)`
            : 'its OS-assigned port (never announced in the log)'
      throw new Error(
        `server did not become healthy on ${where} within ${deps.timeoutMs} ms — child killed (no orphan left).\n${deps.logTail()}`,
      )
    }
    await deps.sleep(POLL_INTERVAL_MS)
  }
}
