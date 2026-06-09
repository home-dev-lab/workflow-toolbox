// changelog.ts — PURE changelog inspection for the upgrade canary (Phase B). When
// the canary measures a Claude Code version move, this turns the official changelog
// text into "what the maintainer should look at for this version range": the entries
// in (lastVersion, currentVersion], with toolbox-relevant lines highlighted. No I/O
// here — the fs/network source lives in changelog-source.ts (impure, out of
// `pnpm test`). All decisions live in one table (buildChangelogReport) so they are
// unit-tested offline against a fixture that mirrors the real changelog shape.

import { compareVersions, parseClaudeVersion } from './version.js'

/** One parsed `## x.y.z` section: its version and its bullet lines (no `- `). */
export interface ChangelogEntry {
  version: string
  lines: string[]
}

/** An entry reduced to only its toolbox-relevant lines. */
export interface RelevantHighlight {
  version: string
  lines: string[]
}

export type ChangelogStatus =
  | 'shown' // a forward move with documented entries in range
  | 'first-run' // no prior marker → only the current version's entry
  | 'no-move' // from == to
  | 'downgrade' // from > to (rollback)
  | 'no-source' // changelog text unavailable (offline / non-2xx / timeout)
  | 'unknown-version' // current version could not be measured

/** The structured, fully-decided report the orchestrator formats. Pure: same
 *  inputs → same output, so the whole decision table is unit-tested. */
export interface ChangelogReport {
  status: ChangelogStatus
  /** Normalized `x.y.z` (or null) of the previous / current version. */
  from: string | null
  to: string | null
  relevant: RelevantHighlight[]
  /** Entries in range that carried no toolbox-relevant line (the remainder). */
  otherCount: number
}

// Substring match (NOT word-boundary) is deliberate: this is an informational
// highlight where recall matters more than precision. Word boundaries would drop
// real signal the maintainer wants — `subagent`, `tool_result`, `tool_decision`
// (underscore is a word char, so `\btool\b` misses `tool_result`). The feared
// false positives ("management"/"engagement"/"propagate") don't actually contain
// "agent" as a substring; only "toolbar"/"toolkit" could ever over-match "tool",
// which is rare and borderline-relevant anyway. A false highlight costs a skim; a
// missed one costs a real regression going unnoticed.
const RELEVANT = /workflow|agent|tool|sdk/i

/** Parse every clean `## x.y.z` heading + its `- ` bullet lines, in file order.
 *  Headings with extra text or non-3-component versions are ignored; prose and the
 *  top `# Changelog` header are skipped. Never throws (empty/garbage md → []). */
export function parseChangelog(md: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let cur: ChangelogEntry | null = null
  for (const raw of md.split('\n')) {
    const heading = raw.match(/^##\s+(\d+\.\d+\.\d+)\s*$/)
    if (heading !== null) {
      cur = { version: heading[1] as string, lines: [] }
      entries.push(cur)
      continue
    }
    if (cur !== null) {
      const trimmed = raw.trimStart()
      if (trimmed.startsWith('- ')) cur.lines.push(trimmed.slice(2).trim())
    }
  }
  return entries
}

/** Entries in the half-open range (from, to]: strictly after `from`, up to and
 *  including `to`, by NUMERIC version compare (so gap versions like a never-published
 *  2.1.164 are handled — `from` need not appear in the changelog). Inputs are
 *  normalized first so a noisy `"2.1.167 (Claude Code)"` compares correctly.
 *  Special cases collapse to one table:
 *   - to unresolvable      → []  (current version unknowable)
 *   - from null (first run)→ only the entry equal to `to` (never the whole history)
 *   - from >= to           → []  (no move, or a downgrade) */
export function extractEntries(md: string, fromVersion: string | null, toVersion: string | null): ChangelogEntry[] {
  const to = toVersion === null ? null : parseClaudeVersion(toVersion)
  if (to === null) return []
  const entries = parseChangelog(md)
  const from = fromVersion === null ? null : parseClaudeVersion(fromVersion)
  if (from === null) return entries.filter((e) => compareVersions(e.version, to) === 0)
  if (compareVersions(from, to) >= 0) return []
  return entries.filter((e) => compareVersions(e.version, from) > 0 && compareVersions(e.version, to) <= 0)
}

/** Reduce entries to only their toolbox-relevant lines, dropping entries that have
 *  none. Pure (entries in → highlights out). */
export function highlightRelevant(entries: readonly ChangelogEntry[]): RelevantHighlight[] {
  const out: RelevantHighlight[] = []
  for (const e of entries) {
    const lines = e.lines.filter((l) => RELEVANT.test(l))
    if (lines.length > 0) out.push({ version: e.version, lines })
  }
  return out
}

/** The single decision table the orchestrator formats. `md` null means the source
 *  was unavailable (the canary must NOT gate on it). Versions are normalized so the
 *  live `from = marker.claudeVersion` / `to = measured ccVersion` feed in directly. */
export function buildChangelogReport(
  md: string | null,
  fromVersion: string | null,
  toVersion: string | null,
): ChangelogReport {
  const from = fromVersion === null ? null : parseClaudeVersion(fromVersion)
  const to = toVersion === null ? null : parseClaudeVersion(toVersion)
  const empty = { from, to, relevant: [] as RelevantHighlight[], otherCount: 0 }
  if (md === null) return { ...empty, status: 'no-source' }
  if (to === null) return { ...empty, status: 'unknown-version' }

  let status: ChangelogStatus
  if (from === null) status = 'first-run'
  else {
    const c = compareVersions(from, to)
    status = c > 0 ? 'downgrade' : c === 0 ? 'no-move' : 'shown'
  }

  const entries = extractEntries(md, from, to)
  const relevant = highlightRelevant(entries)
  return { from, to, status, relevant, otherCount: entries.length - relevant.length }
}
