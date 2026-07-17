// launch-body.ts — the PURE builder of the POST /api/launch request body (card
// #1820589984604750931). The observe server (companion app) accepts an optional
// `requesterCwd` on /api/launch: it slugs it server-side and groups the delegated run
// under the REQUESTING project's timeline bucket instead of the generic "Delegated" one.
// The field contract is "non-empty string when present, 400 otherwise", so the builder
// OMITS it for a degenerate (empty/whitespace) cwd — absent degrades compatibly on both
// old servers (unknown field ignored / never sent) and new ones (Delegated fallback).

/** Body for `POST /api/launch`: `script` always, `args` only when the caller passed some
 *  (undefined = "no --args flag"; null/false are real JSON args and go through), and
 *  `requesterCwd` only when it is a non-degenerate path (sent VERBATIM — the server owns
 *  slugging/normalization; trimming here would corrupt meaningful paths). */
export function buildLaunchBody(script: string, args: unknown, requesterCwd: string): Record<string, unknown> {
  return {
    script,
    ...(args !== undefined ? { args } : {}),
    ...(requesterCwd.trim().length > 0 ? { requesterCwd } : {}),
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
