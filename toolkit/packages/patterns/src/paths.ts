// paths.ts — boundary-safe POSIX path relativization.
//
// Promoted from the dev-workflow family (dev-plan / dev-implement / dev-full),
// where the same kernel guarded three different terminal policies (warn-and-keep,
// throw, silent-fallback). The helper owns ONLY the mapping question — "can this
// path be expressed relative to this root?" — and answers null when it cannot;
// what to do about an unmappable path stays a caller decision.

/**
 * Relativizes `path` under `root`, boundary-safely. POSIX paths only.
 *
 * Returns the relative remainder when ALL of the following hold; `null` in
 * every other case (relative `path`, relative `root`, root `"/"`, `path`
 * outside `root`, an empty remainder, or a remainder that is not genuinely
 * inside the root):
 *
 * - `root` (with trailing slashes stripped) is absolute,
 * - `path` starts with `root + '/'` at a segment boundary — `/a/b` never
 *   matches `/a/bc/...`,
 * - the remainder is non-empty (`path === root` has no relative form),
 * - the remainder does not start with `/` (a doubled separator would yield an
 *   absolute-looking remainder) and contains no `..` segment — lexical
 *   containment is not semantic containment, and a `..` segment resolves
 *   OUTSIDE the root the caller believes it is under.
 *
 * @example
 * ```ts
 * import { relativizeUnder } from '@workflow-toolbox/patterns'
 *
 * relativizeUnder('/repo', '/repo/src/x.ts') // 'src/x.ts'
 * relativizeUnder('/repo/', '/repo/src/x.ts') // 'src/x.ts' (trailing slash ok)
 * relativizeUnder('/a/b', '/a/bc/file') // null — adjacent prefix, not under root
 * relativizeUnder('/repo', '/elsewhere/x') // null — outside the root
 * relativizeUnder('/repo', '/repo/../etc/x') // null — dot-segment escape
 * relativizeUnder('/repo', '/repo//x') // null — remainder would look absolute
 * relativizeUnder('.', '/abs/x') // null — only an absolute root can map
 *
 * // Callers keep their own policy for null:
 * const rel = relativizeUnder(projectDir, filePath)
 * if (rel === null) throw new Error(`unmappable absolute path: ${filePath}`)
 * ```
 */
export function relativizeUnder(root: string, path: string): string | null {
  const stripped = root.replace(/\/+$/, '') // '' when root is '/' or ''
  if (!stripped.startsWith('/')) return null
  if (!path.startsWith(stripped + '/')) return null
  const rel = path.slice(stripped.length + 1)
  if (rel === '') return null
  // Rejected, never normalized: the helper answers "can this path be expressed
  // relative to this root?", and for these two the honest answer is no.
  if (rel.startsWith('/')) return null
  if (rel.split('/').includes('..')) return null
  return rel
}
