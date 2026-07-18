// launch-body.ts — the PURE builder of the POST /api/launch request body (card
// #1820589984604750931). The observe server (companion app) accepts an optional
// `requesterCwd` on /api/launch: it slugs it server-side and groups the delegated run
// under the REQUESTING project's timeline bucket instead of the generic "Delegated" one.
// The field contract is "non-empty string when present, 400 otherwise", so the builder
// OMITS it for a degenerate (empty/whitespace) cwd — absent degrades compatibly on both
// old servers (unknown field ignored / never sent) and new ones (Delegated fallback).

/** Body for `POST /api/launch`: `script` always, `args` only when the caller passed some
 *  (undefined = "no --args flag"; null/false are real JSON args and go through),
 *  `requesterCwd` only when it is a non-degenerate path (sent VERBATIM — the server owns
 *  slugging/normalization; trimming here would corrupt meaningful paths), and `commRoot`
 *  (the `--comm-root` flag) only when non-empty. `commRoot` is the wt-comm ROOT under which
 *  a hint-emitting observer's per-run arc dir lives; the SERVER appends the runId itself and
 *  validates the root against its OBSERVE_COMM_ALLOWED_ROOTS allowlist (400 when outside it,
 *  or a non-empty-string contract like requesterCwd) — so absent = wt-comm hint delivery is
 *  simply not enabled, the compatible degrade. Sent VERBATIM for the same reason as cwd. */
export function buildLaunchBody(
  script: string,
  args: unknown,
  requesterCwd: string,
  commRoot?: string,
): Record<string, unknown> {
  return {
    script,
    ...(args !== undefined ? { args } : {}),
    ...(requesterCwd.trim().length > 0 ? { requesterCwd } : {}),
    ...(commRoot !== undefined && commRoot.trim().length > 0 ? { commRoot } : {}),
  }
}

/** Resolve the requester's cwd for launch attribution, degrading LOUDLY instead of
 *  failing the launch: `cwdFn` (process.cwd in production, injectable for tests) can
 *  throw when the working directory was deleted. On failure: `cwd` is '' (which
 *  buildLaunchBody OMITS — the server 400s an empty string, and an empty-but-present
 *  value would mis-group the run) and `note` carries the operator-facing diagnostic
 *  (pr-review findings on 98d77bc: the silent fallback left runs in the Delegated
 *  bucket with no explanation, and the throw branch had no executable coverage). */
export function safeRequesterCwd(cwdFn: () => string): { cwd: string; note: string | null } {
  try {
    return { cwd: cwdFn(), note: null }
  } catch {
    return {
      cwd: '',
      note: 'requesterCwd unavailable (working directory unresolvable) — the run will appear under the Delegated bucket',
    }
  }
}

/** Default `POST /api/launch` request timeout (ms). The server's SDK session spawn can
 *  exceed this under concurrent load — a timed-out request starts NO run (card
 *  #1821667078139020890). The `--launch-timeout-s` flag / OBSERVE_LAUNCH_TIMEOUT_MS env
 *  extend it. */
export const LAUNCH_DEFAULT_TIMEOUT_MS = 30_000

/** Effective `POST /api/launch` timeout in ms: the `--launch-timeout-s` flag (SECONDS)
 *  wins over the OBSERVE_LAUNCH_TIMEOUT_MS env (MILLISECONDS), else the 30s default. A
 *  non-numeric or non-positive value in EITHER channel is IGNORED (falls through) — never
 *  a 0/NaN that would abort the request instantly (the same sanitize-both-layers posture
 *  the server's own run-timeout knobs use). */
export function resolveLaunchTimeoutMs(flagSeconds: string | undefined, envMs: string | undefined): number {
  const fromFlag = flagSeconds === undefined ? NaN : Number(flagSeconds) * 1000
  if (Number.isFinite(fromFlag) && fromFlag > 0) return fromFlag
  const fromEnv = envMs === undefined ? NaN : Number(envMs)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  return LAUNCH_DEFAULT_TIMEOUT_MS
}

/** Whether the DELEGATED session has WebSearch/WebFetch, from the `OBSERVE_WEB_AVAILABLE`
 *  env (card #1821814620105475706). This is an OPERATOR DECLARATION, not a probe: the
 *  launcher runs outside the spawned bare session and cannot observe its actual tool grant,
 *  so a machine whose delegated sessions lack web tools sets this to opt OUT — otherwise a
 *  docs-lookup that degrades would name `degraded:web` (WebSearch/WebFetch) tools the session
 *  cannot use (phantom tools). Opt-out contract: a FALSE token (`0`/`false`/`no`/`off`,
 *  case-insensitive, trimmed) → false; UNSET or ANY other value → true (the shipped default,
 *  so a typo never silently disables web). */
export function resolveWebAvailable(raw: string | undefined): boolean {
  if (raw === undefined) return true
  const v = raw.trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false
  return true
}
