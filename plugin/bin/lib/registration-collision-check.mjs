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
 * Extract every `${CLAUDE_PLUGIN_ROOT}/...` script path referenced by a command/string, as its
 * FULL path relative to the plugin root (e.g. `/bin/wt-arc-watch.mjs`) — never just the
 * basename. A basename-only key would collide two DIFFERENT files that merely share a filename
 * (e.g. a top-level script and an unrelated one under `bin/lib/`), producing a false-positive
 * duplicate; the full relative path is what a registration surface actually names, so it is
 * what must match for two entries to genuinely be "the same script". Mirrors the
 * reference-collecting regex in hook-manifest.mjs (global match — a command can reference more
 * than one script path).
 */
export function extractScriptPaths(text) {
  const out = []
  const re = /(?:\$\{CLAUDE_PLUGIN_ROOT\}|\/)([^"'\s]+\.m?js)/g
  for (const match of String(text ?? '').matchAll(re)) {
    const rel = match[1]
    out.push(rel.startsWith('/') ? rel : `/${rel}`)
  }
  return out
}

/**
 * surfaces: Record<surfaceName, string[] of script paths registered on that surface>.
 * Returns [{ script, surfaces: string[] }] for every script path appearing on 2+ DISTINCT
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
 * Strips `//` line comments before scanning, so a comment or example line mentioning
 * `hook_event_name !== '...'` cannot be mistaken for a real gate. NAIVE and stated as such: it
 * does not parse block comments (`/* ... *\/`) or recognize a `//` occurring inside a string
 * literal — good enough for this repo's actual hook sources (none embed `//` in a matched
 * string), not a general-purpose JS comment stripper. Extending it would need a real tokenizer.
 */
function stripLineComments(source) {
  return String(source ?? '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')
}

/**
 * Returns the single event a hook file's OWN code requires (via its `hook_event_name !== 'X'`
 * gate), or null when no such gate exists or it names more than one distinct event (ambiguous —
 * the hook deliberately handles multiple events; skip it rather than guess).
 */
export function requiredEventOf(source) {
  const events = new Set()
  const re = /\bhook_event_name\s*!==\s*'([A-Za-z]+)'/g
  for (const match of stripLineComments(source).matchAll(re)) events.add(match[1])
  if (events.size !== 1) return null
  return [...events][0]
}
