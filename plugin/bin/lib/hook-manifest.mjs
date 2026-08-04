import { readFileSync } from 'node:fs'

/**
 * Return every hook path the manifest declares via ${CLAUDE_PLUGIN_ROOT}, preserving event
 * order. A single command string can reference the plugin root MORE THAN ONCE (e.g. a script
 * invocation that also passes a `--lib` path under plugin/bin) — the regex is global and every
 * occurrence is collected, not just the first, or a command with a second plugin-root reference
 * would silently drop it from both the manifest-path lock and the drift detector's snapshot.
 */
export function declaredHookPaths(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const out = []
  for (const [event, groups] of Object.entries(manifest.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const entry of group?.hooks ?? []) {
        const command = entry?.command ?? ''
        for (const match of command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}(\/[^"'\s]+)/g)) {
          out.push({ event, rel: match[1] })
        }
      }
    }
  }
  return out
}
