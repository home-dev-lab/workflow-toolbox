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
