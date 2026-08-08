// hook-registration-coverage-core.mjs — the OTHER arrow of hook registration drift: a shipped
// hook script that no registration surface declares.
//
// `hook-manifest.mjs` / the existing SessionStart drift hook answer "does every DECLARED path
// resolve to a real file?" — that direction fails LOUDLY: a missing file breaks the hook at
// load time. This module answers the direction that fails SILENTLY: "does every SHIPPED hook
// script appear in the manifest?" A file can exist, carry its own tests, its own docs, and a
// CHANGELOG entry describing it as firing, and simply never run — nothing observes the gap,
// because nothing is broken. `wt-lesson-harvest-hook.mjs` shipped exactly that way in 0.134.0.
//
// SCOPE, deliberately narrow: only files matching `*-hook.mjs` directly under `plugin/bin/`
// (never `plugin/bin/lib/`, which holds shared code, not hook entry points, and never a bare
// CLI like `wt-lane-consent-check.mjs` that has no `-hook` suffix and is invoked by a person,
// not the harness). The suffix is this repo's own existing convention — every file already
// carrying it is either registered or explicitly excluded below; see
// hook-registration-exclusions.mjs.
//
// The list of shipped scripts is derived from the DIRECTORY, never hand-maintained — a
// hard-coded list would rot the first time someone adds a file, which is this defect one level
// up (card's own framing).

import { basename } from 'node:path'

/** Basenames of every `*-hook.mjs` file directly under `dirEntries` (one level, no recursion —
 *  `plugin/bin/lib/` is a distinct directory and must never be passed here). Sorted for a
 *  deterministic report. */
export function shippedHookBasenames(dirEntries) {
  return [...dirEntries]
    .filter((name) => /-hook\.mjs$/.test(name))
    .sort()
}

/**
 * declaredRelPaths: the `{event, rel}` entries `declaredHookPaths()` returns — `rel` is a full
 * path like `/bin/wt-foo-hook.mjs`; only its basename matters here (the manifest always points
 * into `plugin/bin/`, never `plugin/bin/lib/`, for a hook entry point).
 * exclusions: [{script, reason}] — basenames deliberately unregistered, each with a reason.
 * shipped: basenames from shippedHookBasenames(), the ground truth for "does this file exist".
 *
 * Returns:
 *  - undeclared: shipped hook scripts that are neither declared nor excluded — THE DEFECT.
 *  - staleExclusions: exclusion entries naming a script that is no longer shipped — an
 *    exclusion map that lies about what it excludes is its own defect (card's requirement #3).
 *  - redundantExclusions: exclusion entries naming a script that IS declared — dead entries
 *    that make the map harder to trust (a script can't be both registered and excluded).
 */
export function auditHookRegistration({ shipped, declaredRelPaths, exclusions }) {
  const declaredBasenames = new Set((declaredRelPaths ?? []).map(({ rel }) => basename(String(rel))))
  const shippedSet = new Set(shipped ?? [])
  const exclusionByScript = new Map((exclusions ?? []).map((e) => [e.script, e.reason]))

  const undeclared = (shipped ?? [])
    .filter((name) => !declaredBasenames.has(name) && !exclusionByScript.has(name))
    .sort()

  const staleExclusions = (exclusions ?? [])
    .filter((e) => !shippedSet.has(e.script))
    .map((e) => e.script)
    .sort()

  const redundantExclusions = (exclusions ?? [])
    .filter((e) => declaredBasenames.has(e.script))
    .map((e) => e.script)
    .sort()

  return { undeclared, staleExclusions, redundantExclusions }
}
