// project-registry.ts — IMPURE fs module (like source.ts / config-dir.ts — NOT
// workflow-sandbox code, Node APIs are fine here). Reads Claude Code's OWN project
// registry and resolves a lossy on-disk run-dir slug (source.ts's `projectSlug()`)
// back to the real project path it was derived from.
//
// Registry location: <configDir>/.claude.json, top-level `projects` object whose
// KEYS are real absolute project paths (or Windows drive-letter paths). File or key
// may be absent — every reader here is tolerant by contract (never throws), like the
// rest of this package's fs layer. The legacy machine-global `~/.claude.json` union
// across config dirs is deliberately NOT done here — that's a consumer decision.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectSlug } from './source.js'

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/

function isPathLike(key: string): boolean {
  return key.startsWith('/') || WINDOWS_DRIVE_PATH.test(key)
}

/** Tolerant read of ONE registry file: the `projects` object's keys, filtered to
 *  path-like strings (the registry accumulates junk keys), deduped, first-seen
 *  order preserved. Every failure mode — file absent/unreadable, malformed JSON,
 *  `projects` missing/not-an-object/null/array — returns [], never throws. */
export function readRegistryFile(path: string): string[] {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return []
  const projects = (data as Record<string, unknown>)['projects']
  if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) return []

  const seen = new Set<string>()
  const out: string[] = []
  for (const key of Object.keys(projects as Record<string, unknown>)) {
    if (!isPathLike(key) || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/** The per-config-dir registry: <configDir>/.claude.json. */
export function readProjectRegistry(configDir: string): string[] {
  return readRegistryFile(join(configDir, '.claude.json'))
}

/**
 * Resolve a lossy run-dir slug (as produced by `projectSlug()`) to the registry path
 * whose slug is its LONGEST matching prefix. Pure — no fs.
 *
 * Match rule (the "-" boundary guard): a registry path R matches run slug S only when
 * `S === projectSlug(R)` or `S.startsWith(projectSlug(R) + '-')`. Without the boundary,
 * a registered `/home/u/proj` would wrongly claim runs from a sibling `/home/u/project`
 * (slug "-home-u-project" is a naive string prefix of "-home-u-proj" — but not at a "-").
 *
 * HONEST LIMIT (verifier-confirmed, not fixable by a smarter guard): `projectSlug()` maps
 * EVERY non-alphanumeric character to '-', so the boundary '-' this guard checks for is
 * indistinguishable from a REAL '-' (or '.', '_', any punctuation) already in the path. The
 * guard blocks an ALPHANUMERIC-continuation collision (`proj` vs `project` above) but canNOT
 * block a PUNCTUATION-sibling collision: an unregistered `/home/u/proj-secret` (or
 * `proj.bak`, `proj_old`) slugs to `-home-u-proj-secret`, which DOES satisfy
 * `S.startsWith(projectSlug(R) + '-')` for registered R = `/home/u/proj`, and so wrongly
 * resolves to it. This is an accepted heuristic limit, not a bug to chase: the slug is
 * IRREVERSIBLY lossy (no algorithm recovers the distinction from the string alone), this
 * field is a display/facet concern only (never an access/security boundary), and in the
 * common case the sibling itself is ALSO registered — longest-prefix-wins (below) then picks
 * whichever registered path's slug is the longer, more specific match, rescuing the sibling
 * case whenever the user actually opened that sibling in Claude Code too.
 *
 * Among matches, the LONGEST registry slug wins (a registered sub-path claims its own
 * runs over its registered ancestor). A tie on slug length (two paths that slugify
 * identically, e.g. "/home/u/proj.x" and "/home/u/proj-x") is broken by the
 * lexicographically smallest PATH — deterministic, arbitrary by design.
 *
 * Returns null on no match, an empty slug, or an empty registry.
 */
export function resolveProjectSlug(slug: string, registryPaths: string[]): string | null {
  if (!slug || registryPaths.length === 0) return null

  let bestPath: string | null = null
  let bestSlug = ''
  for (const path of registryPaths) {
    const candidateSlug = projectSlug(path)
    const matches = slug === candidateSlug || slug.startsWith(candidateSlug + '-')
    if (!matches) continue
    if (
      bestPath === null ||
      candidateSlug.length > bestSlug.length ||
      (candidateSlug.length === bestSlug.length && path < bestPath)
    ) {
      bestPath = path
      bestSlug = candidateSlug
    }
  }
  return bestPath
}
