// session-start-source.mjs — the one predicate every SessionStart hook of this plugin uses to tell a
// post-compaction start from any other.
//
// The harness re-runs every SessionStart hook after a compaction with `source: "compact"`, and the
// text a hook prints there is re-read on every later turn of the continuing session. A hook whose
// output is start-of-session information (configuration, a standing reminder, a weekly count)
// returns early when this predicate is true; a hook whose output reports a defect the session must
// act on keeps printing it.
//
// An absent `hook_event_name` counts as SessionStart: these hooks are only registered there, and a
// hand-run payload often omits the field.

/**
 * @param {unknown} input the parsed hook payload
 * @returns {boolean} true only for a SessionStart payload whose `source` is "compact"
 */
export function isCompactSource(input) {
  if (!input || typeof input !== 'object') return false
  const payload = /** @type {{ hook_event_name?: unknown, source?: unknown }} */ (input)
  const event = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'SessionStart'
  return event === 'SessionStart' && payload.source === 'compact'
}
