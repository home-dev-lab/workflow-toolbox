// changelog-source.ts — impure resolver for the official Claude Code changelog text the
// upgrade canary inspects (Phase B). Kept OUT of `pnpm test` (it performs network I/O and the
// result is environment/time-dependent), exactly like runtimes.ts. The pure logic that consumes
// the text lives in changelog.ts. Resolution is best-effort by contract: the changelog is
// informational, never a gate, so any failure (offline, non-2xx, timeout) returns null and the
// canary continues unaffected.
//
// Source: the official Claude Code CHANGELOG, fetched directly from the canonical public repo.
// A SINGLE best-effort attempt with a short timeout — NO retries, NO cache (an informational
// lookup must never stall the canary). This supersedes the earlier offline-mirror approach.

/** The canonical public Claude Code changelog (raw markdown of anthropics/claude-code@main). */
export const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'

/** Fetch the official changelog, or null if unreachable/unreadable. Best-effort: a single attempt
 *  with a ~5s timeout; never throws — the canary treats null as "no changelog to show" and proceeds. */
export async function resolveChangelogText(): Promise<string | null> {
  try {
    const res = await fetch(CHANGELOG_URL, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    return await res.text()
  } catch {
    // offline / timeout / abort — informational source, never fatal
    return null
  }
}
