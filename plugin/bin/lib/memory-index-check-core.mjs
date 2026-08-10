// memory-index-check-core.mjs — the reachability check behind
// wt-memory-index-check.mjs. Kept separate so tests can drive the pure
// function without spawning a process (see wt-stale-date-guard.mjs's
// lib/stale-date-guard-core.mjs for the same split).
//
// WHAT THIS PROTECTS: an auto-loaded memory
// index (e.g. an auto-memory MEMORY.md) is truncated by the harness past a
// line count nobody sees a warning for. Entries past the cut simply stop
// existing for every session that loads the index — no error, no visible
// truncation. Counting index lines alone cannot tell a COMPRESSED index
// (fiches still reachable through an intermediate hub fiche) from an
// AMPUTATED one (fiches genuinely lost) — a probe that only counts lines can
// be satisfied by deleting entries, which is the defect itself. So this
// module's real output is REACHABILITY: how many fiches exist on disk, how
// many resolve from the index (following direct links AND, transitively,
// any `[[slug]]` references inside a linked fiche's own body — the hub
// pattern), and which ones do not resolve by any path.
//
// An unreachable fiche is not automatically a defect: wt-memory-hygiene.md
// names a deliberate de-indexing (a retraction kept only so old references
// still resolve) as intentional, not an orphan. A well-formed retraction
// block whose forward pointer resolves is therefore EXEMPT from
// unreachableFiches (see retractedFiches below) — but only that narrow
// case: a retraction with a broken pointer earns no exemption and stays
// counted, on top of the brokenRetractions finding it already produces.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// An index entry line, per the convention this project's own
// wt-memory-hygiene.md documents: `- [Title](file.md) — one-phrase hook`.
const ENTRY_LINE_RE = /^-\s*\[[^\]]*\]\(([^)]+\.md)\)/;
// Any markdown link to a .md file, anywhere in a line (index or fiche body).
const LINK_RE = /\]\(([^)]+\.md)\)/g;
// A wiki-style hub member reference inside a fiche BODY: `[[slug]]`.
// Any character except a literal bracket is accepted inside the double
// brackets — an earlier version enumerated a character class
// ([A-Za-z0-9_.-]) and silently dropped any slug outside it (a real gap
// found by cross-model review: a fiche filename containing a space, e.g.
// `[[topic 1]]` -> `topic 1.md`, was falsely reported unreachable even
// though ordinary markdown links already permit spaces). Enumerating a
// filename-character allowlist is the same trap the case-sensitivity fix
// above was meant to close — better to accept whatever the filesystem
// accepts and let diskFiches (the real on-disk listing) be the filter.
const HUBLINK_RE = /\[\[([^[\]]+)\]\]/g;
// A hub-MEMBER line: the whole trimmed line IS a `[[slug]]` list item, e.g.
// `- [[slug]] — hook`. Anchored at the start (after trimming) and NOT
// global — deliberately narrower than HUBLINK_RE above, which matches a
// `[[slug]]` occurrence anywhere in the text (that stays broad on purpose,
// for reachability: a narrative fiche that mentions a neighbour in prose
// still makes it reachable). This one decides hub CLASSIFICATION, where
// "anywhere in the text" is the wrong question — see HUB_MEMBER_LINE_RATIO.
const MEMBER_LINE_RE = /^-\s*\[\[([^[\]]+)\]\]/;
// Declared hub counts are opt-in and parsed only from an explicit frontmatter
// field: `member_count: <integer>`. A frontmatter key is unambiguous and keeps
// this check silent for stores that never adopted the convention; prose like
// "12 members" is too easy to match accidentally in an ordinary note.
//
// Leading whitespace is deliberately optional: real hub files write this key
// BOTH at column 0 (directly under the frontmatter block) AND nested two
// spaces under a `metadata:` key (`  member_count: 11`) — a column-0-only
// anchor never matched the nested shape, so every hub carrying it went
// unchecked: the probe ran at every session start and never once fired on a
// real hub using that shape (measured 2026-08-06).
const DECLARED_MEMBER_COUNT_RE = /^[ \t]*member_count:\s*(\d+)\s*$/m;
// A body counts as a hub only when member-shaped lines are a substantial
// share of its non-blank lines — not merely present. Without this ratio, a
// long narrative fiche that cross-references its neighbours in running
// prose (many `[[link]]` occurrences, almost none of them list items) gets
// classified as a hub and its citations counted as "members". Measured on
// the real store: a 2597-line resume-anchor fiche has 75 inline `[[links]]`
// in prose and exactly 1 line shaped like a member — at "any link present"
// that scored as a 48-member hub (a false positive that would fire a
// SessionStart hook on every session against a perfectly healthy store);
// at this ratio it scores ~0.04% and is correctly not a hub at all. 30% is
// a deliberately generous floor — a genuine hub (a body that IS a member
// list) scores near 100%, so the two shapes are nowhere near each other.
const HUB_MEMBER_LINE_RATIO = 0.3;
// The bound this probe is honest about, on EVERY run that actually checked a
// store — including the clean one. "0 unreachable, 0 dangling" reads as "the
// index is fine", and that is not the question this probe answers.
// REACHABLE means a path exists from the index to a fiche (a direct link, or
// transitively through a hub's `[[slug]]` members); it says nothing about
// whether a session SCANNING the index would know that path is there to
// follow. A real store measured at 2 index lines, 0 unreachable, green on
// every run, while one of those two lines fronted a 103 KB note covering
// fifteen subjects and naming three — twelve subjects were written, correct,
// and undiscoverable, and this probe would have called that store healthy.
// Deliberately NOT a new metric (a per-hub "how much of your body did you
// name" score fires on 13 of this project's own 13 hubs at once — see
// wt-memory-hygiene.md's placement-test note — noise that gets switched off
// before it ever earns its keep). This is a naming of the existing green's
// limit, not a new check.
const SCOPE_NOTE =
  'scope: this run verified REACHABILITY (a path exists from the index to every fiche, direct or via a hub) and the index/hub size ceilings — it did NOT verify DISCOVERABILITY (whether a session scanning the index would know a given subject sits behind a given line).';
const RETRACTION_KEYWORD_RE = /\bretract(?:ed|ion)?\b/i;
const RETRACTION_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const ANY_LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const MD_PATH_RE = /(?:\.\.?\/)?(?:[^\s`()[\]]+\/)*[^\s`()[\]]+\.md(?:#[^\s`()[\]]+)?/g;

/**
 * @param {string} storeDir - absolute or relative path to the memory store
 *   (the directory holding the index file and the fiche .md files). Always
 *   an argument, never guessed — a tool that knows one location only works
 *   on one machine.
 * @param {{ threshold?: number, sizeThreshold?: number, indexFile?: string, hubMax?: number }} [opts]
 * @returns {{
 *   store: string, hasIndex: boolean, scopeNote?: string, indexFile: string, threshold: number,
 *   sizeThreshold: number, entryLines: number, indexBytes: number,
 *   overThreshold: boolean, overSizeThreshold: boolean,
 *   diskFiches: number, reachableFiches: number, unreachableFiches: string[],
 *   unreadableFiches: string[],
 *   indexEntries: Array<{ line: number, target: string, behindCount: number | null, complete: boolean, blockedBy: string[] }>,
 *   retractedFiches: string[],
 *   danglingRefs: Array<{ from: string, target: string }>,
 *   unresolvedCrossRefs: Array<{ from: string, target: string }>,
 *   archivedRefs: Array<{ from: string, target: string }>,
 *   staleIndexPointers: Array<{ from: string, target: string }>,
 *   brokenRetractions: Array<{ from: string, target: string }>,
 *   hubMax: number, hubCount: number,
 *   hubCountMismatches: Array<{ file: string, declared: number, actual: number }>,
 *   largestHub: { file: string, members: number } | null,
 *   inWarningBand: boolean, notices: string[],
 *   flagged: boolean, reasons: string[]
 * }}
 */
export function checkStore(storeDir, opts = {}) {
  const threshold = opts.threshold ?? 200;
  // Both defaults are OBSERVATIONS of one harness's behaviour, never a read of
  // any loader's source — state which number you applied whenever you report on
  // this, because neither is a documented constant and both may differ elsewhere.
  //
  // 25000 bytes: an index measured at ~24.4 KB was reported truncated at read
  // time, so the ceiling sits at or just below that. The default is placed just
  // ABOVE the observation on purpose — a threshold set below a real, working
  // size would fire on a healthy store, and a check that refuses correct work is
  // worse than no check: it gets switched off, taking its real case with it.
  // The consequence is deliberate and worth naming: this flags a store that has
  // CROSSED the ceiling, it does not warn one approaching it. Pass a lower
  // --size-threshold to get margin.
  const sizeThreshold = opts.sizeThreshold ?? 25000;
  const indexFile = opts.indexFile ?? 'MEMORY.md';
  const hubMax = opts.hubMax ?? 45;

  let storeStat;
  try {
    storeStat = statSync(storeDir);
  } catch {
    throw new Error(`store dir not found: ${storeDir}`);
  }
  if (!storeStat.isDirectory()) {
    throw new Error(`store path is not a directory: ${storeDir}`);
  }

  const indexPath = join(storeDir, indexFile);

  // A store with no index at all is a project that keeps none — silent,
  // never a block an adopter of this project's own hygiene convention
  // cannot satisfy.
  if (!existsSync(indexPath)) {
    return {
      store: storeDir,
      hasIndex: false,
      indexFile,
      threshold,
      sizeThreshold,
      entryLines: 0,
      indexBytes: 0,
      overThreshold: false,
      overSizeThreshold: false,
      diskFiches: 0,
      reachableFiches: 0,
      unreachableFiches: [],
      unreadableFiches: [],
      indexEntries: [],
      retractedFiches: [],
      danglingRefs: [],
      unresolvedCrossRefs: [],
      archivedRefs: [],
      staleIndexPointers: [],
      brokenRetractions: [],
      hubMax,
      hubCount: 0,
      hubCountMismatches: [],
      largestHub: null,
      inWarningBand: false,
      notices: [],
      flagged: false,
      reasons: [],
    };
  }

  const indexText = readFileSync(indexPath, 'utf8');
  const indexBytes = statSync(indexPath).size;
  const indexLines = indexText.split('\n');
  const indexEntries = [];
  for (let i = 0; i < indexLines.length; i++) {
    const match = ENTRY_LINE_RE.exec(indexLines[i].trim());
    if (!match) continue;
    indexEntries.push({ line: i + 1, target: match[1] });
  }
  const entryLineCount = indexLines.filter((line) => ENTRY_LINE_RE.test(line.trim())).length;
  const overThreshold = entryLineCount > threshold;
  const overSizeThreshold = indexBytes > sizeThreshold;

  // Fiches on disk: *.md files directly inside storeDir, excluding the
  // index itself. A subdirectory (e.g. archive/) is NOT descended into —
  // archived fiches were deliberately moved out of the live store by the
  // project's own hygiene convention, so they are excluded from the
  // reachability graph entirely rather than counted as invisible.
  const diskFiches = new Set();
  for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name === basename(indexPath)) continue;
    diskFiches.add(entry.name);
  }

  // Archived fiches are NOT live-store members — they stay out of the
  // reachability graph above, and that is correct. But they still EXIST, and
  // the hygiene convention says inbound `[[links]]` are deliberately not
  // rewritten when a fiche is archived, because "archived links resolve on
  // demand". A checker that cannot see the archive therefore reports a link
  // that resolves perfectly as unresolved — and, since archiving is the very
  // mechanism the convention prescribes, that count only ever grows. A line
  // showing a permanently-nonzero number nobody can act on is a line people
  // stop reading, which is how a checker loses the cases that matter.
  //
  // ⚠ The two link kinds are NOT the same finding, and collapsing them would
  // trade a false positive for a false negative:
  //   - a link in a BODY to an archived fiche is CORRECT by the convention;
  //   - a link in the INDEX to an archived fiche is a real defect the same
  //     convention names — archiving requires dropping the pointer, and a
  //     targeted deletion aimed at the index succeeds while deleting nothing
  //     when the pointer actually lives in a hub body.
  const archivedFiches = new Set();
  const archiveDir = join(storeDir, 'archive');
  if (existsSync(archiveDir)) {
    for (const entry of readdirSync(archiveDir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (!entry.name.endsWith('.md')) continue;
      archivedFiches.add(entry.name);
    }
  }

  // Direct links: every `(*.md)` target named anywhere in the index file.
  const directLinks = new Set();
  const danglingRefs = [];
  const unresolvedCrossRefs = [];
  const archivedRefs = [];
  const staleIndexPointers = [];
  const brokenRetractions = [];
  for (const line of indexLines) {
    LINK_RE.lastIndex = 0;
    let match;
    while ((match = LINK_RE.exec(line))) {
      directLinks.add(match[1]);
      if (diskFiches.has(match[1])) continue;
      // An index pointer at an archived fiche is not dangling — the file is
      // right there — but it IS the pointer the archiving step was supposed
      // to drop. Naming it as its own class is what makes it actionable;
      // folding it into "dangling" would send a reader hunting a missing file
      // that exists, and folding it into "resolved" would hide a real defect.
      if (archivedFiches.has(match[1])) staleIndexPointers.push({ from: indexFile, target: match[1] });
      else danglingRefs.push({ from: indexFile, target: match[1] });
    }
  }

  // BFS closure: a directly-linked fiche that is itself a hub lists its
  // members as `[[slug]]` in its own body; follow those transitively so a
  // hub-of-hubs still resolves. Depth is unbounded — nothing in the card's
  // design caps hub nesting, and capping it would just move the silent
  // ceiling one layer down instead of removing it.
  const reachable = new Set();
  const queue = [];
  const unreadableFiches = new Set();
  for (const file of directLinks) {
    if (diskFiches.has(file) && !reachable.has(file)) {
      reachable.add(file);
      queue.push(file);
    }
  }
  // Per-entry exposure counts member-shaped references for every readable
  // fiche. Hub sizing separately applies the structural ratio below; the
  // ratio answers whether hub-only checks apply, not whether members exist.
  const entryMemberCounts = new Map(); // file -> distinct resolved member count
  // Hub sizing: a hub buys index headroom by pushing facts one hop down,
  // it does not remove the ceiling — it RELOCATES it.
  const hubMemberCounts = new Map(); // file -> distinct resolved member count
  const hubCountMismatches = [];
  let structuralHubCount = 0;
  let hubsWithDeclaredCount = 0;

  while (queue.length > 0) {
    const current = queue.shift();
    let body;
    try {
      body = readFileSync(join(storeDir, current), 'utf8');
    } catch {
      unreadableFiches.add(current);
      continue; // linked but unreadable — treated as not further expandable, not a crash
    }
    // Reachability: any `[[slug]]` occurrence ANYWHERE in the body, prose
    // included — deliberately broad, this is what lets a hub-of-hubs (or a
    // narrative fiche that simply mentions a neighbour) still resolve.
    const bodyLinks = new Set();
    HUBLINK_RE.lastIndex = 0;
    let match;
    while ((match = HUBLINK_RE.exec(body))) {
      const candidate = `${match[1]}.md`;
      if (diskFiches.has(candidate)) bodyLinks.add(candidate);
      if (diskFiches.has(candidate) && !reachable.has(candidate)) {
        reachable.add(candidate);
        queue.push(candidate);
      }
    }
    // Hub classification: STRUCTURE, not "has a link" — see
    // HUB_MEMBER_LINE_RATIO above for why "any [[link]] present" is the
    // wrong test.
    const bodyLines = body.split('\n');
    const nonBlankLineCount = bodyLines.filter((l) => l.trim().length > 0).length;
    let memberLineCount = 0;
    const memberLineSlugs = new Set();
    const memberSlugs = new Set();
    const unresolvedMemberLineRefs = [];
    for (const line of bodyLines) {
      const m = MEMBER_LINE_RE.exec(line.trim());
      if (!m) continue;
      memberLineCount++;
      const candidate = `${m[1]}.md`;
      memberLineSlugs.add(candidate);
      if (diskFiches.has(candidate)) memberSlugs.add(candidate);
      // A body link into the archive RESOLVES — the convention says so
      // explicitly and tells stores not to rewrite these. Counted as its own
      // class so the distinction stays visible without ever reading as a fault.
      else if (archivedFiches.has(candidate)) archivedRefs.push({ from: current, target: candidate });
      else unresolvedMemberLineRefs.push({ from: current, target: candidate });
    }
    entryMemberCounts.set(current, memberSlugs.size);
    const declaredCount = readDeclaredMemberCount(body);
    if (declaredCount !== null && declaredCount !== memberLineSlugs.size) {
      hubCountMismatches.push({ file: current, declared: declaredCount, actual: memberLineSlugs.size });
    }
    const isStructuralHub =
      memberLineCount > 0 && nonBlankLineCount > 0 && memberLineCount / nonBlankLineCount >= HUB_MEMBER_LINE_RATIO;
    if (isStructuralHub) {
      structuralHubCount++;
      if (declaredCount !== null) hubsWithDeclaredCount++;
      for (const ref of unresolvedMemberLineRefs) danglingRefs.push(ref);
      hubMemberCounts.set(current, memberSlugs.size);
    } else {
      for (const ref of unresolvedMemberLineRefs) unresolvedCrossRefs.push(ref);
    }
  }

  const rawUnreachableFiches = [...diskFiches].filter((f) => !reachable.has(f)).sort();
  // Per-entry exposure is deliberately one hop and member-shaped. The
  // transitive graph above answers whole-store reachability; using it here
  // makes nearly every cross-referenced entry appear to front the whole store.
  const perEntryCounts = indexEntries.map(({ line, target }) =>
    measureEntryMembers(target, line, diskFiches, entryMemberCounts, unreadableFiches),
  );

  // Whole-note retractions are detected only by the convention's top-of-note
  // blockquote shape. Keyword presence elsewhere in the body stays out of
  // scope so section-level retractions inside live notes do not fire.
  //
  // A deliberate de-indexing is exactly what wt-memory-hygiene.md calls
  // intentional: "a retraction kept only so old references still resolve —
  // fine, reads intentional; else an orphan to place, merge, or archive."
  // Before this pass, `unreachableFiches` counted every unreachable fiche
  // with no exemption, so the two on this store were flagged EVERY session —
  // exactly the "always-red gate gets ignored" failure the rule itself warns
  // about. The exemption is narrow on purpose: only a WELL-FORMED retraction
  // block (`readRetractionForwardTarget` returns non-null) whose forward
  // pointer actually RESOLVES earns it — a retracted fiche with a broken
  // pointer gets no exemption and stays counted as unreachable, on top of
  // the brokenRetractions finding it already produces below. Trading one
  // false positive (the intentional retraction) for a hole (an unverified
  // retraction claim) would be the wrong trade.
  const retractedResolving = new Set();
  for (const file of diskFiches) {
    let body;
    try {
      body = readFileSync(join(storeDir, file), 'utf8');
    } catch {
      continue;
    }
    const target = readRetractionForwardTarget(body);
    if (target === null) continue;
    if (retractionTargetResolves(storeDir, target)) {
      retractedResolving.add(file);
      continue;
    }
    brokenRetractions.push({ from: file, target });
  }

  // Only an unreachable fiche's retraction status matters here — a fiche
  // that IS reachable (still linked from the index or a hub) needs no
  // exemption in the first place, so this never widens the exemption beyond
  // the de-indexed case the rule actually describes.
  const retractedFiches = rawUnreachableFiches.filter((f) => retractedResolving.has(f)).sort();
  const unreachableFiches = rawUnreachableFiches.filter((f) => !retractedResolving.has(f));

  // Largest hub, for reporting even when nothing is over hubMax — this is
  // what makes the relocated ceiling visible before it becomes a problem,
  // the same reasoning the warning band applies to the index itself.
  let largestHub = null;
  for (const [file, members] of hubMemberCounts) {
    if (!largestHub || members > largestHub.members) largestHub = { file, members };
  }

  const reasons = [];
  if (overThreshold) {
    reasons.push(`index has ${entryLineCount} entry line(s), over threshold ${threshold}`);
  }
  if (overSizeThreshold) {
    reasons.push(`index is ${indexBytes} byte(s), over threshold ${sizeThreshold}`);
  }
  if (unreachableFiches.length > 0) {
    reasons.push(
      `${unreachableFiches.length} fiche(s) on disk are reachable from the index by no path (hub or direct)`,
    );
  }
  if (unreadableFiches.size > 0) {
    reasons.push(
      `could not fully read ${unreadableFiches.size} reachable fiche(s); reachability was verified only where those files could be read`,
    );
  }
  for (const { from, target } of danglingRefs) {
    reasons.push(`dangling reference from ${from} to ${target}`);
  }
  for (const { from, target } of brokenRetractions) {
    reasons.push(`retraction forward pointer from ${from} to ${target} does not resolve`);
  }
  for (const { from, target } of staleIndexPointers) {
    reasons.push(
      `${from} still points at ${target}, which has been archived — drop the pointer (it may live in a hub body, not the index)`,
    );
  }
  for (const [file, members] of hubMemberCounts) {
    if (members > hubMax) {
      reasons.push(`hub ${file} has ${members} member(s), over hubMax ${hubMax}`);
    }
  }
  for (const { file, declared, actual } of hubCountMismatches) {
    reasons.push(`hub ${file} declared ${declared} member(s); actual ${actual}`);
  }

  // The warning band: a countdown toward the threshold, never a flag. The
  // probe as originally shipped only fires once the index is ALREADY over
  // the limit — by which point the tail is already invisible to every
  // session loading it. This gives a reader a heads-up while there is
  // still time to act, without turning a healthy store noisy: it never
  // fires once overThreshold is already true (that case has its own,
  // stronger signal), and it never changes `flagged` or the exit code.
  const headroom = threshold - entryLineCount;
  const bandWidth = Math.max(10, Math.round(threshold * 0.15));
  const inWarningBand = !overThreshold && headroom <= bandWidth;
  const notices = [];
  if (inWarningBand) {
    notices.push(`index headroom: ${headroom} line(s) before the threshold of ${threshold}`);
  }
  if (unresolvedCrossRefs.length > 0) {
    notices.push(
      `informational only: ${unresolvedCrossRefs.length} unresolved cross-reference(s) in non-hub bodies; see unresolvedCrossRefs for per-item detail`,
    );
  }
  if (archivedRefs.length > 0) {
    notices.push(
      `${archivedRefs.length} reference(s) resolve in archive/ — correct by the hygiene convention, which does not rewrite inbound links when a fiche is archived; no action`,
    );
  }
  if (structuralHubCount > 0 && hubsWithDeclaredCount === 0) {
    notices.push(
      'declared-count cross-check inactive: hubs exist, but none declares member_count; silence here means not measured, not verified',
    );
  }
  // A count that only ever reads "0 unreachable" loses the ability to say
  // what it exempted — its silence becomes indistinguishable from "nothing
  // to report" again, the exact failure this exemption exists to close.
  // Only printed when it applies (empty case reads exactly as before).
  if (retractedFiches.length > 0) {
    notices.push(
      `${retractedFiches.length} fiche(s) excluded from unreachable — a deliberate retraction whose forward pointer resolves (see wt-memory-hygiene.md); not a defect`,
    );
  }

  return {
    store: storeDir,
    hasIndex: true,
    scopeNote: SCOPE_NOTE,
    indexFile,
    threshold,
    sizeThreshold,
    entryLines: entryLineCount,
    indexBytes,
    overThreshold,
    overSizeThreshold,
    diskFiches: diskFiches.size,
    reachableFiches: reachable.size,
    unreachableFiches,
    unreadableFiches: [...unreadableFiches].sort(),
    indexEntries: perEntryCounts,
    retractedFiches,
    danglingRefs,
    unresolvedCrossRefs,
    archivedRefs,
    staleIndexPointers,
    brokenRetractions,
    hubMax,
    hubCount: hubMemberCounts.size,
    hubCountMismatches,
    largestHub,
    inWarningBand,
    notices,
    // Every flagging condition (over-threshold, an unreachable fiche, an
    // oversized hub) already pushed its own line into `reasons` above —
    // flagged is exactly "did anything push a reason", not a re-derivation
    // of the same three conditions a second way that could drift from it.
    flagged: reasons.length > 0,
    reasons,
  };
}

function measureEntryMembers(target, line, diskFiches, entryMemberCounts, unreadableFiches) {
  if (!diskFiches.has(target)) {
    return { line, target, behindCount: null, complete: false, blockedBy: [target] };
  }

  if (unreadableFiches.has(target)) {
    return { line, target, behindCount: null, complete: false, blockedBy: [target] };
  }

  if (!entryMemberCounts.has(target)) {
    return { line, target, behindCount: null, complete: false, blockedBy: [target] };
  }

  return {
    line,
    target,
    behindCount: entryMemberCounts.get(target),
    complete: true,
    blockedBy: [],
  };
}

function readDeclaredMemberCount(body) {
  const frontmatterMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(body);
  if (!frontmatterMatch) return null;
  const declaredMatch = DECLARED_MEMBER_COUNT_RE.exec(frontmatterMatch[1]);
  if (!declaredMatch) return null;
  return Number(declaredMatch[1]);
}

function readRetractionForwardTarget(body) {
  const content = stripFrontmatter(body).replace(/^\uFEFF/, '');
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  if (i >= lines.length || !/^\s*>/.test(lines[i])) return null;

  const quoteLines = [];
  while (i < lines.length && /^\s*>/.test(lines[i])) {
    quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
    i++;
  }

  const block = quoteLines.join('\n').trim();
  if (!RETRACTION_KEYWORD_RE.test(block) || !RETRACTION_DATE_RE.test(block)) return null;
  return extractRetractionTarget(block);
}

function extractRetractionTarget(block) {
  ANY_LINK_RE.lastIndex = 0;
  let match;
  while ((match = ANY_LINK_RE.exec(block))) {
    const candidate = match[1].trim();
    if (isResolvableRetractionTarget(candidate)) return candidate;
  }

  INLINE_CODE_RE.lastIndex = 0;
  while ((match = INLINE_CODE_RE.exec(block))) {
    const candidate = match[1].trim();
    if (isResolvableRetractionTarget(candidate)) return candidate;
  }

  MD_PATH_RE.lastIndex = 0;
  match = MD_PATH_RE.exec(block);
  if (match) return match[0];

  return null;
}

function isResolvableRetractionTarget(candidate) {
  if (candidate.length === 0) return false;
  if (/^[a-z]+:\/\//i.test(candidate)) return false;
  return candidate.includes('/') || candidate.endsWith('.md');
}

function retractionTargetResolves(storeDir, target) {
  const normalized = target.replace(/#.*/, '');
  if (normalized.length === 0) return false;
  if (/^[a-z]+:\/\//i.test(normalized)) return true;
  if (normalized.startsWith('/')) return existsSync(normalized);
  return existsSync(join(storeDir, normalized));
}

function stripFrontmatter(body) {
  const frontmatterMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(body);
  if (!frontmatterMatch) return body;
  return body.slice(frontmatterMatch[0].length);
}
