// registration-collision-check.mjs — two independent, MECHANICAL checks against the finite,
// readable surfaces where an automatic mechanism (hook or monitor) gets registered:
//
//  1. duplicateScriptRegistrations(surfaces) — a script invoked by more than one DISTINCT
//     registration SURFACE (e.g. plugin/monitors/monitors.json AND plugin/.claude-plugin/
//     plugin.json) is almost certainly two mechanisms doing the same job under different names.
//     Registering the SAME script twice WITHIN one surface (e.g. a hook wired to both
//     PreToolUse and PostToolUse in plugin.json, to do different work per event) is the
//     existing, deliberate convention in this repo and is NOT flagged — only a script that
//     crosses surfaces is.
//
//     Honest scope: this catches identical-SCRIPT duplication only. It does NOT catch two
//     DIFFERENT scripts implementing the same watcher under different names (that class is a
//     judgment call — no mechanical check here covers it).
//
//  2. requiredEventOf(source) — reads a hook's OWN gate (`... .hook_event_name !== 'X') return`)
//     and returns the single event `X` its code requires, or `null` when the file's gate is
//     absent or ambiguous (multiple distinct required events → the hook deliberately handles
//     more than one event, e.g. wt-check-commit-signatures-hook.mjs; not a case this check can
//     safely judge). `null` means "cannot determine", never "no mismatch" — callers must skip
//     rather than pass such a hook.

/**
 * Extract every `${CLAUDE_PLUGIN_ROOT}/...` (or literal-rooted) script path referenced by a
 * command/string, as its basename. Mirrors the reference-collecting regex in hook-manifest.mjs
 * (global match — a command can reference more than one script path).
 */
export function extractScriptBasenames(text) {
  const out = []
  const re = /(?:\$\{CLAUDE_PLUGIN_ROOT\}|\/)([^"'\s]+\.m?js)/g
  for (const match of String(text ?? '').matchAll(re)) {
    const rel = match[1]
    const base = rel.split('/').pop()
    if (base) out.push(base)
  }
  return out
}

/**
 * surfaces: Record<surfaceName, string[] of script basenames registered on that surface>.
 * Returns [{ script, surfaces: string[] }] for every script basename appearing on 2+ DISTINCT
 * surface names. Multiple occurrences WITHIN one surface's own array are not duplicates here —
 * dedupe per surface before comparing.
 */
export function duplicateScriptRegistrations(surfaces) {
  const owners = new Map() // script -> Set<surfaceName>
  for (const [surfaceName, scripts] of Object.entries(surfaces)) {
    for (const script of new Set(scripts)) {
      if (!owners.has(script)) owners.set(script, new Set())
      owners.get(script).add(surfaceName)
    }
  }
  const dups = []
  for (const [script, surfaceSet] of owners) {
    if (surfaceSet.size > 1) dups.push({ script, surfaces: [...surfaceSet].sort() })
  }
  return dups.sort((a, b) => a.script.localeCompare(b.script))
}

/**
 * Returns the single event a hook file's OWN code requires (via its `hook_event_name !== 'X'`
 * gate), or null when no such gate exists or it names more than one distinct event (ambiguous —
 * the hook deliberately handles multiple events; skip it rather than guess).
 */
export function requiredEventOf(source) {
  const events = new Set()
  const re = /\bhook_event_name\s*!==\s*'([A-Za-z]+)'/g
  for (const match of String(source ?? '').matchAll(re)) events.add(match[1])
  if (events.size !== 1) return null
  return [...events][0]
}
