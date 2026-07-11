// config-dir.ts — WHICH Claude config dir is this process under, and how to key
// per-config-dir state. Its own module (not source.ts) so lean consumers — the
// bundled wt-observe CLI, observe-lifecycle — pull ONLY this, not the whole
// journal-resolution surface. source.ts re-exports both for existing importers.

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Canonicalize an ARBITRARY path: absolutize (against cwd, for a relative input), then
 *  realpath (falling back to the absolutized form when the dir doesn't exist yet — never
 *  throws). The shared canonicalization CORE resolveConfigDir uses for CLAUDE_CONFIG_DIR —
 *  extracted (multi-observe I5) so a path that did NOT come from that one env var — an
 *  OBSERVE_SOURCES entry, a `wt-observe start --source` flag, an auto-discovered candidate —
 *  canonicalizes exactly the same way, without a second copy of "what canonical means here"
 *  to drift from this one. */
export function resolveDir(path: string): string {
  const abs = resolve(path)
  try {
    return realpathSync(abs)
  } catch {
    return abs // dir absent (e.g. never created) — the absolutized path is still canonical
  }
}

/** Resolve WHICH Claude config dir this process is under: CLAUDE_CONFIG_DIR ?? ~/.claude,
 *  canonicalized via resolveDir so two spellings of the same dir — relative path, trailing
 *  slash, symlink — canonicalize to ONE string. Load-bearing on a machine running several
 *  config dirs at once (e.g. ~/.claude + ~/.claude-work): anything deriving a key/slug/
 *  pidfile from the dir must see the canonical form. NOTE: a RELATIVE CLAUDE_CONFIG_DIR
 *  resolves against process.cwd() at call time — deliberate (there is no better anchor), so
 *  real-world values should be absolute. */
export function resolveConfigDir(env: Record<string, string | undefined> = process.env): string {
  const raw = env['CLAUDE_CONFIG_DIR']
  return resolveDir(raw !== undefined && raw.length > 0 ? raw : join(homedir(), '.claude'))
}

/** INJECTIVE per-config-dir state key: readable slug + 8-hex sha256 of the canonical
 *  path. The slug alone is NON-injective (every non-alphanumeric collapses to '-'), so
 *  two plausible variants (~/.claude-work vs ~/.claude_work) would silently SHARE
 *  state — the exact isolation boundary per-config-dir keying exists to protect.
 *  Feed it resolveConfigDir() output (canonical), never a raw env value. */
export function configDirKey(configDir: string): string {
  const slug = configDir.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 180) || 'unknown'
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `${slug}-${hash}`
}
