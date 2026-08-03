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
const DECLARED_MEMBER_COUNT_RE = /^member_count:\s*(\d+)\s*$/m;
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

/**
 * @param {string} storeDir - absolute or relative path to the memory store
 *   (the directory holding the index file and the fiche .md files). Always
 *   an argument, never guessed — a tool that knows one location only works
 *   on one machine.
 * @param {{ threshold?: number, indexFile?: string, hubMax?: number }} [opts]
 * @returns {{
 *   store: string, hasIndex: boolean, indexFile: string, threshold: number,
 *   entryLines: number, overThreshold: boolean,
 *   diskFiches: number, reachableFiches: number, unreachableFiches: string[],
 *   danglingRefs: Array<{ from: string, target: string }>,
 *   hubMax: number, hubCount: number,
 *   hubCountMismatches: Array<{ file: string, declared: number, actual: number }>,
 *   largestHub: { file: string, members: number } | null,
 *   inWarningBand: boolean, notices: string[],
 *   flagged: boolean, reasons: string[]
 * }}
 */
export function checkStore(storeDir, opts = {}) {
  const threshold = opts.threshold ?? 200;
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
      entryLines: 0,
      overThreshold: false,
      diskFiches: 0,
      reachableFiches: 0,
      unreachableFiches: [],
      danglingRefs: [],
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
  const indexLines = indexText.split('\n');
  const entryLineCount = indexLines.filter((line) => ENTRY_LINE_RE.test(line.trim())).length;
  const overThreshold = entryLineCount > threshold;

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

  // Direct links: every `(*.md)` target named anywhere in the index file.
  const directLinks = new Set();
  const danglingRefs = [];
  for (const line of indexLines) {
    LINK_RE.lastIndex = 0;
    let match;
    while ((match = LINK_RE.exec(line))) {
      directLinks.add(match[1]);
      if (!diskFiches.has(match[1])) danglingRefs.push({ from: indexFile, target: match[1] });
    }
  }

  // BFS closure: a directly-linked fiche that is itself a hub lists its
  // members as `[[slug]]` in its own body; follow those transitively so a
  // hub-of-hubs still resolves. Depth is unbounded — nothing in the card's
  // design caps hub nesting, and capping it would just move the silent
  // ceiling one layer down instead of removing it.
  const reachable = new Set();
  const queue = [];
  for (const file of directLinks) {
    if (diskFiches.has(file) && !reachable.has(file)) {
      reachable.add(file);
      queue.push(file);
    }
  }
  // Hub sizing: a hub buys index headroom by pushing facts one hop down,
  // it does not remove the ceiling — it RELOCATES it. So while walking the
  // BFS anyway, record for each reachable file that is STRUCTURALLY a hub
  // (see HUB_MEMBER_LINE_RATIO) the number of DISTINCT member-shaped
  // `[[slug]]` references its body yields that resolve to a real fiche on
  // disk.
  const hubMemberCounts = new Map(); // file -> distinct resolved member count
  const hubCountMismatches = [];

  while (queue.length > 0) {
    const current = queue.shift();
    let body;
    try {
      body = readFileSync(join(storeDir, current), 'utf8');
    } catch {
      continue; // linked but unreadable — treated as not further expandable, not a crash
    }
    // Reachability: any `[[slug]]` occurrence ANYWHERE in the body, prose
    // included — deliberately broad, this is what lets a hub-of-hubs (or a
    // narrative fiche that simply mentions a neighbour) still resolve.
    HUBLINK_RE.lastIndex = 0;
    let match;
    while ((match = HUBLINK_RE.exec(body))) {
      const candidate = `${match[1]}.md`;
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
    for (const line of bodyLines) {
      const m = MEMBER_LINE_RE.exec(line.trim());
      if (!m) continue;
      memberLineCount++;
      const candidate = `${m[1]}.md`;
      memberLineSlugs.add(candidate);
      if (!diskFiches.has(candidate)) danglingRefs.push({ from: current, target: candidate });
      if (diskFiches.has(candidate)) memberSlugs.add(candidate);
    }
    const declaredCount = readDeclaredMemberCount(body);
    if (declaredCount !== null && declaredCount !== memberLineSlugs.size) {
      hubCountMismatches.push({ file: current, declared: declaredCount, actual: memberLineSlugs.size });
    }
    if (
      memberSlugs.size > 0 &&
      nonBlankLineCount > 0 &&
      memberLineCount / nonBlankLineCount >= HUB_MEMBER_LINE_RATIO
    ) {
      hubMemberCounts.set(current, memberSlugs.size);
    }
  }

  const unreachableFiches = [...diskFiches].filter((f) => !reachable.has(f)).sort();

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
  if (unreachableFiches.length > 0) {
    reasons.push(
      `${unreachableFiches.length} fiche(s) on disk are reachable from the index by no path (hub or direct)`,
    );
  }
  for (const { from, target } of danglingRefs) {
    reasons.push(`dangling reference from ${from} to ${target}`);
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

  return {
    store: storeDir,
    hasIndex: true,
    indexFile,
    threshold,
    entryLines: entryLineCount,
    overThreshold,
    diskFiches: diskFiches.size,
    reachableFiches: reachable.size,
    unreachableFiches,
    danglingRefs,
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

function readDeclaredMemberCount(body) {
  const frontmatterMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(body);
  if (!frontmatterMatch) return null;
  const declaredMatch = DECLARED_MEMBER_COUNT_RE.exec(frontmatterMatch[1]);
  if (!declaredMatch) return null;
  return Number(declaredMatch[1]);
}
