// changelog-span.mjs — pure logic that slices plugin/CHANGELOG.md between two versions.
//
// A stale adopted copy's `adopt --check` report used to say only:
//
//   wt-answer-first-reporting.md: STALE (installed v0.112.0 < v0.125.2)
//
// which tells a reading session a number moved, never what changed — so it is
// rationally ignored, which is how a stale set stays stale (card 1836356654). This
// module answers "what actually shipped between these two versions", sourced from the
// CHANGELOG's own `## [x.y.z]` headings (Keep a Changelog format) — never from commit
// subjects between tags, a structural decision made on the card.
//
// THE INVARIANT THIS FILE EXISTS TO HOLD (do not weaken without re-reading the card):
// measured on this repo's own plugin/CHANGELOG.md, 61 of the minor versions between
// 0.68 and 0.144 carry NO `## [x.y.z]` heading at all — a mechanical gate
// (plugin-changelog-gate.test.ts) now forces every NEW version to carry one, but the
// historical gap is real and permanent. A range that falls entirely inside that gap
// slices to zero headings — and rendering that the same way as "nothing changed" is an
// INVERTING failure: it reads as calm at exactly the moment ~100 versions went past.
// So this module returns two structurally different shapes, never conflatable by a
// caller that only checks "is the entries array empty":
//
//   { recorded: true,  entries: [...] }   — the range is inside the changelog's
//                                            recorded span; entries may still be [],
//                                            meaning genuinely nothing was recorded
//                                            in that exact window.
//   { recorded: false, oldestRecordedVersion }
//                                          — fromVersion predates every heading the
//                                            changelog carries at all: there is no
//                                            record to slice, full stop.
//
// This module is PURE (no fs). The caller reads plugin/CHANGELOG.md and passes its text.
//
// === CHANGELOG-SPAN CORE START — kept BYTE-IDENTICAL between changelog-span.mjs and
// install.mjs; locked by adopt-changelog-span-drift.test.ts. Duplicated rather than
// imported because install.mjs must stay a single relocatable script — its own tests
// copy it alone into a synthetic plugin root, so a runtime import of a sibling module
// breaks it there (measured elsewhere in this codebase: the same reason
// UNIVERSAL_ENV_REQUIREMENTS is duplicated against plugin/bin/lib/env-prerequisites.mjs,
// kept honest by env-prerequisite-drift-hook.test.ts's own text-equality check rather
// than an import). Every helper name is prefixed `changelogSpan*` so pasting this block
// into install.mjs cannot collide with that file's OWN `cmp()` (different signature:
// string-vs-string, not tuple-vs-tuple). ===
const CHANGELOG_SPAN_HEADING_RE = /^##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/

/** Parse a semver-ish string 'x.y.z' into a comparable [x,y,z] tuple. Throws on a
 *  malformed string — callers only ever pass adopt's own installed/current versions,
 *  both of which are validated elsewhere (VERSION_RE / plugin.json's own manifest
 *  check) before they ever reach here. */
function changelogSpanParseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim())
  if (!m) throw new Error(`changelogSpan: not a valid x.y.z version: ${JSON.stringify(v)}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function changelogSpanCmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** Every `## [x.y.z]` heading in `changelog`, in FILE order (newest-first, the normal
 *  Keep-a-Changelog convention — never assumed by callers, only used here to find each
 *  heading's line range). Each item carries the exact line index its heading starts at,
 *  so the caller can slice the body down to (but not including) the NEXT heading of any
 *  version — an `## [Unreleased]` section has no version token and is correctly never
 *  matched, matching the plugin-changelog-gate's own `changelogRecordsVersion`. */
function changelogSpanParseHeadings(changelog) {
  const lines = changelog.split(/\r?\n/)
  const headings = []
  for (let i = 0; i < lines.length; i++) {
    const m = CHANGELOG_SPAN_HEADING_RE.exec(lines[i])
    if (!m) continue
    headings.push({
      version: `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`,
      versionTuple: [Number(m[1]), Number(m[2]), Number(m[3])],
      lineIndex: i,
      headingLine: lines[i],
    })
  }
  return { lines, headings }
}

/**
 * Slice `changelog` (plugin/CHANGELOG.md's text, Keep a Changelog format) for every
 * heading strictly newer than `fromVersion` up to and including `toVersion`.
 *
 * @param {string} changelog        raw CHANGELOG.md text
 * @param {string} fromVersion      the stale copy's installed version, e.g. '0.112.0'
 * @param {string} toVersion        the current plugin version, e.g. '0.144.0'
 * @param {{maxEntries?: number}} [opts]  cap on entries returned (default 10); the
 *   MOST RECENT entries are kept and the rest are counted in `omittedCount` — never
 *   silently dropped, per the card's invariant 4.
 *
 * @returns {{recorded:true, entries:Array<{version:string, heading:string, body:string}>,
 *            totalCount:number, omittedCount:number}
 *          |{recorded:false, oldestRecordedVersion:string|null}}
 */
function changelogSpan(changelog, fromVersion, toVersion, opts = {}) {
  const maxEntries = opts.maxEntries ?? 10
  const from = changelogSpanParseVersion(fromVersion)
  const to = changelogSpanParseVersion(toVersion)
  const { lines, headings } = changelogSpanParseHeadings(changelog)

  if (headings.length === 0) {
    return { recorded: false, oldestRecordedVersion: null }
  }

  // Oldest/newest by VALUE, never by file position — a hand-edited or reordered
  // changelog must not silently invert this via list order.
  let oldest = headings[0]
  for (const h of headings) {
    if (changelogSpanCmp(h.versionTuple, oldest.versionTuple) < 0) oldest = h
  }

  if (changelogSpanCmp(from, oldest.versionTuple) < 0) {
    // fromVersion predates every heading this changelog carries — nothing to slice,
    // and saying so is the whole point: this is NOT "no changes", it is "no record".
    return { recorded: false, oldestRecordedVersion: oldest.version }
  }

  // Headings strictly after `from`, up to and including `to` — sorted NEWEST FIRST
  // (the useful reading order for "what did I miss"), independent of file order.
  const inRange = headings
    .filter((h) => changelogSpanCmp(h.versionTuple, from) > 0 && changelogSpanCmp(h.versionTuple, to) <= 0)
    .sort((a, b) => -changelogSpanCmp(a.versionTuple, b.versionTuple))

  // Body = from this heading's line, up to (not including) the next heading of ANY
  // version in the whole file (not just those in-range) — so a body never swallows a
  // sibling entry that happened to fall outside the requested range.
  const allByLine = [...headings].sort((a, b) => a.lineIndex - b.lineIndex)
  function bodyFor(h) {
    const pos = allByLine.findIndex((x) => x.lineIndex === h.lineIndex)
    const nextLineIndex = pos + 1 < allByLine.length ? allByLine[pos + 1].lineIndex : lines.length
    return lines
      .slice(h.lineIndex, nextLineIndex)
      .join('\n')
      .replace(/\n+$/, '')
  }

  const totalCount = inRange.length
  const shown = inRange.slice(0, maxEntries)
  const omittedCount = totalCount - shown.length

  const entries = shown.map((h) => ({
    version: h.version,
    heading: h.headingLine,
    body: bodyFor(h),
  }))

  return { recorded: true, entries, totalCount, omittedCount }
}
// === CHANGELOG-SPAN CORE END ===

export { changelogSpan }
